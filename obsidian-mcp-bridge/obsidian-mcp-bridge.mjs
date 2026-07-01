#!/usr/bin/env node
/**
 * MCP HTTP bridge for obsidian-mcp.
 * Replaces both mcp-proxy and mcp-oauth-proxy:
 *   - Spawns obsidian-mcp over stdio
 *   - Implements MCP Streamable HTTP transport (2024-11-05 spec)
 *   - Provides the OAuth 2.0 discovery endpoints Claude Code requires
 *
 * Usage: VAULT=/path/to/vault node obsidian-mcp-bridge.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { normPath, isDenied as _isDenied, checkAccess as _checkAccess } from './lib/access.mjs';

const LISTEN_PORT  = parseInt(process.env.LISTEN_PORT  || '3002', 10);
if (Number.isNaN(LISTEN_PORT) || LISTEN_PORT < 1 || LISTEN_PORT > 65535) {
  console.error('LISTEN_PORT must be a valid port number (1-65535)');
  process.exit(1);
}
const BASE_URL     = process.env.MCP_BASE_URL;
const VAULT        = process.env.VAULT || process.argv[2];
const CHILD_BIN    = process.env.CHILD_BIN;
const VAULT_NAME   = VAULT ? VAULT.replace(/\/+$/, '').split('/').pop() : 'vault';

// Comma-separated vault-relative paths that are off-limits, e.g. "private,journal/personal"
const DENY_PATHS = (process.env.DENY_PATHS || '')
  .split(',')
  .map(p => p.trim().replace(/^\/+|\/+$/g, '')) // strip leading/trailing slashes
  .filter(Boolean);

if (!BASE_URL) {
  console.error('Set MCP_BASE_URL env var to the public HTTPS base URL of this bridge (e.g. https://hostname:4001)');
  process.exit(1);
}
if (!CHILD_BIN) {
  console.error('Set CHILD_BIN env var to the path of the obsidian-mcp binary (e.g. /usr/local/bin/obsidian-mcp)');
  process.exit(1);
}
if (!VAULT) {
  console.error('Set VAULT env var or pass vault path as first argument');
  process.exit(1);
}

// ── child process ──────────────────────────────────────────────────────────

let child            = null;
let childReady       = false;
let everInitialized  = false;
let childKeepAlive   = null;  // timer handle for child keepalive pings
let childCapResolve = null;
let childCapReject  = null;
let childCapPromise = new Promise((res, rej) => {
  childCapResolve = res;
  childCapReject  = rej;
});
let childCaps    = null;      // result of child's initialize response
let childTools   = null;      // cached tools/list result — refreshed on each child restart
let childBuf     = '';
const pending    = new Map(); // globalId → (response) => void

function sendChild(msg) {
  if (!child || child.killed || !child.stdin.writable) {
    console.error('sendChild: child not available, dropping message');
    return;
  }
  try {
    child.stdin.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    console.error('sendChild write error:', err.code ?? err.message);
  }
}

function onChildLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // notification (no id member) → forward to open SSE streams
  // Note: id:null is technically valid in JSON-RPC error responses; String(null) === "null"
  // so it would miss the pending lookup below — but obsidian-mcp does not produce id:null.
  if (msg.id === undefined) {
    broadcastNotification(msg);
    return;
  }

  const cb = pending.get(String(msg.id));
  if (cb) {
    pending.delete(String(msg.id));
    cb(msg);
  }
}

// obsidian-mcp has a 60s inactivity ConnectionMonitor. The bridge short-circuits
// most requests (tools/list, prompts/list, resources/list) so the child rarely sees
// traffic. Send a tools/list keepalive every 45s to prevent the monitor from firing.
function scheduleKeepAlive() {
  clearTimeout(childKeepAlive);
  childKeepAlive = setTimeout(async () => {
    if (!child || !childReady) return;
    console.log('  → keepalive: pinging child');
    const r = await callChild({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: {} }, 10_000);
    if (r.error) {
      // If the child already exited, the exit handler set childReady=false and
      // scheduled a respawn — nothing for us to do. Only force-restart if the
      // child appears to still be running but stopped responding.
      if (childReady) {
        console.error('keepalive timed out or errored — restarting child:', r.error.message);
        restartChild();
      } else {
        console.error('keepalive errored after child exit (restart already scheduled):', r.error.message);
      }
    } else {
      if (r.result) childTools = r.result; // refresh cache while we're here
      scheduleKeepAlive();
    }
  }, 30_000);
}

function spawnChild() {
  childReady = false;
  childBuf   = '';
  child = spawn(CHILD_BIN, [VAULT], { stdio: ['pipe', 'pipe', 'inherit'] });
  const self = child; // captured so data/error listeners can detect replacement

  child.stdin.on('error', err => {
    console.error('child stdin error:', err.code ?? err.message);
  });

  child.stdout.on('error', err => {
    console.error('child stdout error:', err.code ?? err.message);
  });

  child.stdout.on('data', chunk => {
    if (child !== self) return; // stale listener from killed child, discard
    const chunkStr = chunk.toString();
    console.log(`  ← child stdout: ${chunk.length} bytes (buf=${childBuf.length + chunkStr.length}), pending=${pending.size}`);
    childBuf += chunkStr;
    if (childBuf.length > 10 * 1024 * 1024) { // obsidian-mcp messages can be large; 10MB prevents resource exhaustion
      console.error(`childBuf overflow at ${childBuf.length} bytes (limit=10MB), restarting child`);
      childBuf = '';
      if (child && !child.killed) child.kill('SIGTERM');
      return;
    }
    let nl;
    while ((nl = childBuf.indexOf('\n')) !== -1) {
      const line = childBuf.slice(0, nl).trim();
      childBuf  = childBuf.slice(nl + 1);
      console.log(`  ← child line: id=${(() => { try { return JSON.parse(line)?.id ?? 'none'; } catch { return 'parse-err'; } })()} pending=${pending.size}`);
      if (line) onChildLine(line);
    }
  });

  child.on('exit', code => {
    console.error(`obsidian-mcp exited (${code}), restarting in 3s`);
    clearTimeout(childKeepAlive);
    childReady  = false;
    childCaps   = null;
    childTools  = null;
    // fail any in-flight requests (snapshot first so callbacks can't mutate pending mid-iteration)
    for (const [id, cb] of [...pending]) {
      cb({ jsonrpc: '2.0', id, error: { code: -32603, message: 'child restarted' } });
    }
    pending.clear();
    // reset cap promise for restart
    childCapPromise = new Promise((res, rej) => {
      childCapResolve = res;
      childCapReject  = rej;
    });
    childCapPromise.catch(err => console.error('child re-init failed:', err));
    setTimeout(spawnChild, 3000);
  });

  // send initialize to child
  const initId = randomUUID();
  pending.set(initId, resp => {
    if (resp.error) {
      console.error('child init error:', resp.error);
      childCapReject(resp.error); // already .catch'd on the promise
      if (everInitialized) {
        // On restart, kill and let the exit handler retry
        if (child && !child.killed) child.kill('SIGTERM');
      }
      // else: first-start failure — the .catch on childCapPromise below calls process.exit(1)
      return;
    }
    childCaps       = resp.result;
    childReady      = true;
    everInitialized = true;
    // Spec requires the client to send notifications/initialized after receiving
    // the initialize response. obsidian-mcp ignores unknown notifications safely.
    sendChild({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Pre-fetch static responses so they can be short-circuited without blocking on the child.
    const toolsId = randomUUID();
    pending.set(toolsId, resp => { if (!resp.error) childTools = resp.result; });
    sendChild({ jsonrpc: '2.0', id: toolsId, method: 'tools/list', params: {} });

    console.log('obsidian-mcp ready');
    childCapResolve(childCaps);
    scheduleKeepAlive();
  });

  sendChild({
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'obsidian-mcp-bridge', version: '1.0' },
    },
  });
}

async function ensureReady() {
  if (childReady) return childCaps;
  try { return await childCapPromise; } catch { return null; }
}

let lastRestart = 0;
function restartChild() {
  const now = Date.now();
  if (now - lastRestart < 5000) return; // debounce
  lastRestart = now;
  console.error('restarting stuck child');
  if (child && !child.killed) child.kill('SIGTERM');
}

async function callChild(request, timeoutMs = 60_000) {
  await ensureReady();
  if (!childReady) await ensureReady(); // wait again on the new childCapPromise if child restarted
  if (!childReady) {
    return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'child not available' } };
  }
  const origId   = request.id;
  const globalId = randomUUID();
  const label    = request.method === 'tools/call'
    ? `tools/call (${request.params?.name ?? '?'})` : request.method;
  const t0 = Date.now();
  const argsLog = request.method === 'tools/call' && request.params?.arguments
    ? ' args=' + JSON.stringify(request.params.arguments) : '';
  console.log(`  ⟶ child: ${label}${argsLog} [${globalId.slice(0, 8)}] pending=${pending.size + 1}`);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(globalId);
      console.log(`  ✗ timeout: ${label} [${globalId.slice(0, 8)}] after ${Date.now() - t0}ms pending=${pending.size}`);
      resolve({ jsonrpc: '2.0', id: origId, error: { code: -32603, message: `timeout: ${request.method}` } });
      // Do NOT restart the child here — it may just be slow (e.g. USB disk read).
      // The child is only restarted if it actually exits/crashes (see exit handler).
    }, timeoutMs);

    pending.set(globalId, resp => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const status = resp.error ? `error(${resp.error.code})` : 'ok';
      console.log(`  ✓ ${label} [${globalId.slice(0, 8)}] ${status} in ${ms}ms pending=${pending.size - 1}`);
      resolve({ ...resp, id: origId });
    });

    sendChild({ ...request, id: globalId });
  });
}

// ── Path access control ────────────────────────────────────────────────────

// Bind module-level DENY_PATHS into the imported pure functions.
const isDenied    = path             => _isDenied(DENY_PATHS, path);
const checkAccess = (toolName, args) => _checkAccess(DENY_PATHS, toolName, args);

// ── SSE streams (GET /mcp per session) ────────────────────────────────────

const sseStreams = new Map(); // sessionId → ServerResponse

function broadcastNotification(msg) {
  const chunk = `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const [sid, res] of sseStreams) {
    try {
      res.write(chunk);
    } catch (err) {
      const code = err.code;
      if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED') {
        console.error(`broadcastNotification error for sid ${sid.slice(0, 8)}:`, err.message);
      }
      // Always prune the broken stream and its session regardless of error type.
      sseStreams.delete(sid);
      sessions.delete(sid);
    }
  }
}

// ── active HTTP sessions ───────────────────────────────────────────────────

const sessions    = new Set();
const SESSION_TTL = 60_000; // remove sessions that never open a GET /mcp stream

function addSession(sid) {
  if (sessions.size >= 1000) return false;
  sessions.add(sid);
  // If no SSE stream opens within TTL, drop the session
  setTimeout(() => {
    if (!sseStreams.has(sid)) sessions.delete(sid);
  }, SESSION_TTL);
  return true;
}

// ── OAuth static responses ─────────────────────────────────────────────────

const OAUTH_RESOURCE = JSON.stringify({
  resource: BASE_URL,
  authorization_servers: [BASE_URL],
});

const OAUTH_SERVER = JSON.stringify({
  issuer: BASE_URL,
  authorization_endpoint: `${BASE_URL}/authorize`,
  token_endpoint:         `${BASE_URL}/token`,
  registration_endpoint:  `${BASE_URL}/register`,
  grant_types_supported:              ['client_credentials', 'authorization_code'],
  token_endpoint_auth_methods_supported: ['none'],
  response_types_supported:           ['code', 'token'],
  scopes_supported:                   [],
});

const TOKEN_RESPONSE = JSON.stringify({
  access_token: 'public',
  token_type:   'Bearer',
  expires_in:   86400,
  scope:        '',
});

// ── HTTP helpers ───────────────────────────────────────────────────────────

function sendSse(res, statusCode, sessionId, msgs) {
  const headers = {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  res.writeHead(statusCode, headers);
  for (const m of msgs) {
    res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
  }
  res.end();
}

// ── HTTP server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url?.split('?')[0];
  // Validate session ID as a UUID — all legitimate IDs are created by randomUUID().
  // Non-matching values become '' so sessions.has('') is always false.
  const rawSid = req.headers['mcp-session-id']?.trim() || '';
  const sid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawSid)
    ? rawSid : '';
  const safeMethod = req.method?.replace(/[^\w-]/g, '?') ?? 'UNKNOWN';
  const safeUrl    = (url ?? '').replace(/[^\w/.-]/g, '?');
  const safeSid    = sid.slice(0, 8) || 'none';
  console.log(`${safeMethod} ${safeUrl} sid=${safeSid}`);

  try {
    await route(req, res, url, sid);
  } catch (err) {
    console.error('unhandled:', err);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
});

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

async function route(req, res, url, sid) {
  // Reject cross-origin browser requests to defend against DNS-rebinding.
  // Direct tool/CLI calls don't send Origin so this only fires for browsers.
  const origin = req.headers['origin'];
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).hostname; } catch { originHost = null; }
    if (!originHost || !LOOPBACK.has(originHost)) {
      res.writeHead(403); return res.end('forbidden origin');
    }
  }

  // ── OAuth ──────────────────────────────────────────────────────────────
  if (url === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(OAUTH_RESOURCE);
  }
  if (url === '/.well-known/oauth-authorization-server') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(OAUTH_SERVER);
  }
  if (url === '/authorize' && req.method === 'GET') {
    handleAuthorize(req, res);
    return;
  }
  if (url === '/token' && req.method === 'POST') {
    req.resume(); // drain and discard body
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(TOKEN_RESPONSE);
  }
  if (url === '/register' && req.method === 'POST') {
    req.setEncoding('utf8');
    let body = '';
    for await (const chunk of req) {
      if (body.length + chunk.length > 65536) { req.destroy(); res.writeHead(413); return res.end('request too large'); } // registration payloads are small
      body += chunk;
    }
    let redirect_uris = [];
    try {
      const parsed = JSON.parse(body).redirect_uris;
      if (Array.isArray(parsed)) {
        redirect_uris = parsed.filter(u => {
          try { return LOOPBACK.has(new URL(u).hostname); } catch { return false; }
        });
      }
    } catch {}
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      client_id:              'public-client',
      client_id_issued_at:    Math.floor(Date.now() / 1000),
      redirect_uris,
      grant_types:            ['client_credentials', 'authorization_code'],
      token_endpoint_auth_method: 'none',
    }));
  }

  if (url !== '/mcp') { res.writeHead(404); return res.end('not found'); }

  // ── GET /mcp — notification SSE stream ────────────────────────────────
  if (req.method === 'GET') {
    if (!sid || !sessions.has(sid)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'session not found' }));
    }
    // End any previous SSE response for this session (e.g. reconnect after network blip).
    const prev = sseStreams.get(sid);
    if (prev && !prev.writableEnded) {
      try { prev.end(); } catch {}
    }
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'mcp-session-id': sid,
    });
    res.flushHeaders();
    sseStreams.set(sid, res);
    // On close: remove the stream but keep the session alive so that POST
    // requests (e.g. from a shim that reconnects the SSE stream) still work.
    req.on('close', () => {
      if (sseStreams.get(sid) === res) sseStreams.delete(sid);
    });
    return;
  }

  // ── POST /mcp ──────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end('method not allowed');
  }

  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) {
    res.writeHead(415); return res.end('content-type must be application/json');
  }

  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) {
    if (body.length + chunk.length > 10 * 1024 * 1024) { // raised from 1MB to accommodate large obsidian-mcp messages
      console.error(`request body too large at ${body.length + chunk.length} bytes (limit=10MB)`);
      req.destroy(); res.writeHead(413); return res.end('request too large');
    }
    body += chunk;
  }
  if (body.length > 10_000) console.log(`  → request body: ${body.length} bytes`);

  let msg;
  try { msg = JSON.parse(body); } catch {
    res.writeHead(400); return res.end('invalid json');
  }

  // Clamp msg.id to valid JSON-RPC types (string | number | null) before echoing in responses.
  const msgId = (typeof msg.id === 'string' || typeof msg.id === 'number' || msg.id === null)
    ? msg.id : null;

  // Log the JSON-RPC method (and tool name for tools/call) so requests are traceable.
  const toolName = msg.method === 'tools/call' ? ` (${msg.params?.name ?? '?'})` : '';
  console.log(`  → ${msg.method ?? '?'}${toolName} sid=${sid.slice(0, 8) || 'none'}`);

  // initialize → new session, no forwarding needed
  if (msg.method === 'initialize') {
    const caps = await ensureReady();
    if (!caps) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msgId, error: { code: -32603, message: 'child not available' } }));
    }
    const newSid = randomUUID();
    if (!addSession(newSid)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msgId, error: { code: -32603, message: 'session table full' } }));
    }
    return sendSse(res, 200, newSid, [{
      jsonrpc: '2.0',
      id: msgId,
      result: caps,
    }]);
  }

  // All other requests need a valid session — 404 signals the shim to re-initialize.
  if (!sid || !sessions.has(sid)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'session not found' }));
  }

  // notifications (no id member per JSON-RPC 2.0) → 202, don't forward
  // Note: id:null is technically a malformed request, not a notification, but
  // we treat it the same way since obsidian-mcp does not produce id:null responses.
  if (msg.id === undefined || msg.id === null) {
    res.writeHead(202);
    return res.end();
  }

  // short-circuit list methods that obsidian-mcp is slow/stuck on
  if (msg.method === 'resources/list') {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: { resources: [] } }]);
  }
  if (msg.method === 'prompts/list') {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: { prompts: [] } }]);
  }
  if (msg.method === 'tools/list' && childTools) {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: childTools }]);
  }

  // list-available-vaults is answered directly from the VAULT env var — never hits the child
  if (msg.method === 'tools/call' && msg.params?.name === 'list-available-vaults') {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
      content: [{ type: 'text', text: `Available vaults:\n  - ${VAULT_NAME}` }],
    } }]);
  }

  // path access control for tool calls
  if (msg.method === 'tools/call') {
    const denied = checkAccess(msg.params?.name, msg.params?.arguments ?? {});
    if (denied) {
      const safeName = String(msg.params?.name ?? '').replace(/[\r\n]/g, '?');
      console.log(`DENY ${safeName}: ${denied}`);
      return sendSse(res, 200, sid, [{
        jsonrpc: '2.0',
        id: msgId,
        result: { content: [{ type: 'text', text: denied }], isError: true },
      }]);
    }
  }

  // requests → forward to child, return SSE response
  const response = await callChild({ ...msg, id: msgId });
  return sendSse(res, 200, sid, [response]);
}

function handleAuthorize(req, res) {
  req.resume(); // GET requests have no body, but drain anyway for keep-alive hygiene
  const qs          = new URL(req.url, BASE_URL).searchParams;
  const redirectUri = qs.get('redirect_uri');
  const state       = qs.get('state');
  if (!redirectUri) { res.writeHead(400); return res.end('missing redirect_uri'); }

  let dest;
  try { dest = new URL(redirectUri); } catch {
    res.writeHead(400); return res.end('invalid redirect_uri');
  }

  // Only redirect to loopback — the only legitimate client is Claude Code,
  // which always uses a local callback server.
  if (!LOOPBACK.has(dest.hostname)) {
    res.writeHead(400); return res.end('redirect_uri must target localhost');
  }

  // PKCE is not enforced; code is a fixed placeholder since token exchange is also a no-op.
  dest.searchParams.set('code', 'public-auth-code');
  if (state) dest.searchParams.set('state', state.slice(0, 512));

  res.writeHead(302, { Location: dest.toString() });
  res.end();
}

// ── start ──────────────────────────────────────────────────────────────────

spawnChild();

// Wait for child before accepting connections
childCapPromise.then(
  () => {
    server.listen(LISTEN_PORT, '127.0.0.1', () => {
      console.log(`obsidian-mcp bridge listening on 127.0.0.1:${LISTEN_PORT}`);
    });
  },
  err => {
    console.error('child failed to initialize:', err);
    process.exit(1);
  },
);
