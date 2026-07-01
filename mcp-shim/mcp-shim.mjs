#!/usr/bin/env node
import https from "node:https";
import { createInterface } from "node:readline";

// Config — MCP_URL takes precedence over the positional arg (Claude Desktop sets env vars).
const rawUrl = process.env.MCP_URL ?? process.argv[2];
if (!rawUrl) {
  process.stderr.write("Usage: mcp-shim.mjs <url>  (or set MCP_URL)\n");
  process.exit(1);
}

let parsedUrl;
try {
  parsedUrl = new URL(rawUrl);
} catch {
  process.stderr.write(`shim: invalid URL: ${rawUrl}\n`);
  process.exit(1);
}
const { hostname, port, pathname } = parsedUrl;

let TIMEOUT = 60_000;
if (process.env.MCP_TIMEOUT !== undefined) {
  const n = Number(process.env.MCP_TIMEOUT);
  if (Number.isFinite(n) && n > 0) {
    TIMEOUT = n;
  } else {
    process.stderr.write(`shim: invalid MCP_TIMEOUT "${process.env.MCP_TIMEOUT}", using default 60000ms\n`);
  }
}

const TOKEN = process.env.MCP_TOKEN ?? null;
const BASE_HEADERS = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

let sessionId = null;
let sseReq = null; // retained so the GET stream can be aborted on session expiry
let sseOpen = false;
let lastEventId = null;
let reconnectDelay = 1000;

// Returns { data, id } from one SSE event block; either field may be null.
// MCP messages are always single-line JSON, so we take only the first data: line.
// A bare "id:" line (no value) resets the last-event-id per the SSE spec.
function parseSseBlock(block) {
  let data = null;
  let id = null;
  for (const line of block.split("\n")) {
    if (data === null && line.startsWith("data: ")) data = line.slice(6);
    if (id === null && (line.startsWith("id: ") || line === "id:"))
      id = line.length > 3 ? line.slice(4) : "";
  }
  return { data, id };
}

// Parses an SSE stream incrementally, writing each event's data to stdout.
// Calls onDone(err?) when the stream ends or errors.
// Calls onFirstData() once on receipt of the first chunk, if provided.
function streamSse(res, onDone, onFirstData) {
  let buf = "";
  let notifiedFirstData = false;
  res.on("data", (chunk) => {
    if (!notifiedFirstData && onFirstData) { onFirstData(); notifiedFirstData = true; }
    buf += chunk.toString();
    const blocks = buf.split("\n\n");
    buf = blocks.pop(); // retain incomplete trailing block
    for (const block of blocks) {
      const { data, id } = parseSseBlock(block);
      if (id !== null) lastEventId = id;
      if (data !== null) process.stdout.write(data + "\n");
    }
  });
  res.on("end", () => {
    // Flush any unterminated final event sent without a trailing "\n\n".
    if (buf.trim()) {
      const { data, id } = parseSseBlock(buf);
      if (id !== null) lastEventId = id;
      if (data !== null) process.stdout.write(data + "\n");
    }
    onDone(null);
  });
  res.on("error", (err) => {
    process.stderr.write(`shim: SSE stream error: ${err.message}\n`);
    onDone(err);
  });
}

function abortSse() {
  if (sseReq) { sseReq.destroy(); sseReq = null; }
  sseOpen = false;
}

// Opens the SSE GET stream and forwards events to stdout.
// Reconnects automatically with exponential backoff on drop.
function openSse() {
  if (sseOpen || !sessionId) return;
  sseOpen = true;
  const headers = {
    ...BASE_HEADERS,
    Accept: "text/event-stream",
    "mcp-session-id": sessionId,
  };
  if (lastEventId !== null) headers["Last-Event-ID"] = lastEventId;
  const req = https.request(
    { hostname, port: port || 443, path: pathname, method: "GET", headers },
    (res) => {
      const status = res.statusCode;
      if (status === 405) {
        // Server does not support GET SSE — do not reconnect.
        res.resume();
        sseOpen = false;
        sseReq = null;
        return;
      }
      if (status !== 200) {
        process.stderr.write(`shim: SSE GET returned HTTP ${status}\n`);
        res.resume();
        sseOpen = false;
        sseReq = null;
        if (status >= 400 && status < 500) return; // client error — do not reconnect
        if (sessionId) {
          reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
          setTimeout(openSse, reconnectDelay);
        }
        return;
      }
      streamSse(
        res,
        (err) => {
          sseOpen = false;
          sseReq = null;
          if (sessionId) {
            if (err) reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
            setTimeout(openSse, reconnectDelay);
          }
        },
        () => { reconnectDelay = 1000; }, // reset backoff only after first data, not on headers
      );
    },
  );
  req.on("error", (err) => {
    sseOpen = false;
    sseReq = null;
    // sessionId is null during intentional teardown (deleteSession clears it first) — skip log/reconnect.
    if (sessionId) {
      process.stderr.write(`shim: SSE request error: ${err.message}\n`);
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
      setTimeout(openSse, reconnectDelay);
    }
  });
  req.end();
  sseReq = req;
}

// Best-effort session teardown per MCP spec ("SHOULD send DELETE").
function deleteSession() {
  if (!sessionId) return;
  const sid = sessionId;
  sessionId = null; // clear before abortSse so the error handler won't log or reconnect
  abortSse();
  const req = https.request({
    hostname,
    port: port || 443,
    path: pathname,
    method: "DELETE",
    headers: { ...BASE_HEADERS, "mcp-session-id": sid },
    timeout: TIMEOUT,
  });
  req.on("timeout", () => req.destroy()); // best-effort cleanup; don't log or wait
  req.on("error", () => {}); // best-effort cleanup; silently discard errors
  req.end();
}

// POST a JSON request and handle both SSE and JSON responses.
// Returns { status, body?, ct? } for JSON, or { status } for SSE (streamed to stdout).
// Initializes SSE subscription if the response includes an mcp-session-id header.
async function post(json) {
  return new Promise((resolve, reject) => {
    const headers = {
      ...BASE_HEADERS,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const req = https.request(
      { hostname, port: port || 443, path: pathname, method: "POST", headers, timeout: TIMEOUT },
      (res) => {
        req.setTimeout(0); // headers received — disarm timeout so it won't fire mid-stream
        if (res.headers["mcp-session-id"]) {
          sessionId = res.headers["mcp-session-id"];
          openSse();
        }
        const status = res.statusCode;
        const ct = res.headers["content-type"] ?? "";
        if (ct.includes("text/event-stream")) {
          // Stream events to stdout as they arrive; resolve when the stream closes.
          streamSse(res, (err) => (err ? reject(err) : resolve({ status })));
        } else {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () =>
            resolve({ status, body: Buffer.concat(chunks).toString(), ct }),
          );
        }
      },
    );
    req.on("timeout", () => req.destroy(new Error(`POST request timed out after ${TIMEOUT}ms`)));
    req.on("error", reject);
    req.end(json);
  });
}

process.on("SIGINT", () => { deleteSession(); process.exit(0); });
process.on("SIGTERM", () => { deleteSession(); process.exit(0); });

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("close", deleteSession);
rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const { status, body } = await post(line);
    if (status === 202) return;
    if (status === 404 || (status === 400 && sessionId)) {
      // Session expired or not recognised: 404 per spec, or 400 when sessionId is set. Client MUST re-initialize.
      process.stderr.write(`shim: session rejected (${status}): ${(body ?? "").slice(0, 200)}; cleared session ID\n`);
      abortSse();
      sessionId = null;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32000, message: "MCP session expired; reinitialize." },
            }) + "\n",
          );
        }
      } catch (e) { process.stderr.write(`shim: could not parse request line: ${e.message}\n`); }
      return;
    }
    // Requests with an id must always receive a response — send a JSON-RPC error so the
    // client doesn't hang. Body is kept in stderr only to avoid leaking server internals.
    if (status >= 400) {
      process.stderr.write(`shim: POST returned HTTP ${status}: ${(body ?? "").slice(0, 200)}\n`);
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32000, message: `Upstream error (HTTP ${status}); see shim log for details.` },
            }) + "\n",
          );
        }
      } catch (e) { process.stderr.write(`shim: could not parse request line: ${e.message}\n`); }
      return;
    }
    // SSE POST responses are already written to stdout inside post(); only JSON arrives here.
    if (body && body.trim()) process.stdout.write(body.trim() + "\n");
  } catch (e) {
    process.stderr.write(`shim: ${e.message}\n`);
  }
});
