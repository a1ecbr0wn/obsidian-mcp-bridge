/**
 * Integration tests for bridge-native tool handlers.
 * Spawns the bridge HTTP server with a temp vault and a minimal stdio mock as CHILD_BIN.
 * Sends real HTTP POST requests and asserts on SSE responses.
 *
 * DENY_PATHS=private is set so access-control paths can be tested alongside
 * normal paths (which use projects/, inbox/, etc.).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE     = path.join(__dirname, '..', 'obsidian-mcp-bridge.mjs');
const MOCK_CHILD = path.join(__dirname, 'mock-child.mjs');
const PORT       = 19742;
const BASE_URL   = `http://127.0.0.1:${PORT}`;
const DENY_DIR   = 'private'; // vault-relative path that DENY_PATHS blocks

let vaultDir;
let vaultName;
let bridgeProc;

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Writes a file directly to the temp vault.
 * @param {string} relPath - Vault-relative file path.
 * @param {string} content - File content to write.
 * @returns {Promise<void>}
 */
async function writeVaultNote(relPath, content) {
  const abs = path.join(vaultDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

/**
 * Sends a POST request to /mcp and returns the response.
 * @param {object} body - Request body as JSON object.
 * @param {string} [sid] - Optional session ID header (mcp-session-id).
 * @returns {Promise<{status: number, headers: object, msgs: object[]}>} Status code, response headers, and parsed SSE messages.
 */
async function post(body, sid) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (sid) headers['mcp-session-id'] = sid;
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers },
      res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => {
          const msgs = [];
          for (const line of data.split('\n')) {
            if (line.startsWith('data: ')) {
              try { msgs.push(JSON.parse(line.slice(6))); } catch {}
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, msgs });
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Initializes an MCP session via the /mcp endpoint.
 * @returns {Promise<string>} The session ID from the mcp-session-id response header.
 */
async function initSession() {
  const r = await post({
    jsonrpc: '2.0', id: '1', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  assert.equal(r.status, 200, 'initialize should return 200');
  const sid = r.headers['mcp-session-id'];
  assert.ok(sid, 'initialize should return a session ID');
  return sid;
}

/**
 * Calls a bridge-native MCP tool with the given arguments.
 * @param {string} name - Tool name to invoke.
 * @param {object} args - Tool arguments (vault name is prepended automatically).
 * @returns {Promise<object>} The MCP result object from the tool call.
 */
async function callTool(name, args) {
  const sid = await initSession();
  const r = await post({
    jsonrpc: '2.0', id: '2', method: 'tools/call',
    params: { name, arguments: { vault: vaultName, ...args } },
  }, sid);
  assert.equal(r.msgs.length, 1, `${name}: expected exactly one SSE message`);
  return r.msgs[0].result;
}

// ── global setup / teardown ───────────────────────────────────────────────

before(async () => {
  vaultDir  = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
  vaultName = path.basename(vaultDir);

  bridgeProc = spawn('node', [BRIDGE], {
    env: {
      ...process.env,
      VAULT:        vaultDir,
      MCP_BASE_URL: BASE_URL,
      CHILD_BIN:    MOCK_CHILD,
      LISTEN_PORT:  String(PORT),
      DENY_PATHS:   DENY_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    let out = '';
    const onData = chunk => {
      out += chunk.toString();
      if (out.includes('listening')) resolve();
    };
    bridgeProc.stdout.on('data', onData);
    bridgeProc.stderr.on('data', onData);
    bridgeProc.on('exit', code => reject(new Error(`bridge exited early with code ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`bridge startup timeout\n${out}`)), 15_000);
  });
});

after(async () => {
  bridgeProc.kill();
  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ── list-available-vaults ─────────────────────────────────────────────────

describe('list-available-vaults', () => {
  it('returns the vault name', async () => {
    const sid = await initSession();
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name: 'list-available-vaults', arguments: {} },
    }, sid);
    assert.equal(r.msgs.length, 1);
    const text = r.msgs[0].result.content[0].text;
    assert.ok(text.includes(vaultName), `expected vault name in: ${text}`);
    assert.ok(!r.msgs[0].result.isError);
  });
});

// ── list-notes ────────────────────────────────────────────────────────────

describe('list-notes', () => {
  before(async () => {
    await writeVaultNote('inbox/todo.md', '# Todo');
    await writeVaultNote('projects/alpha.md', '# Alpha');
    await writeVaultNote('projects/beta.md', '# Beta');
    await writeVaultNote(`${DENY_DIR}/secret.md`, '# Secret');
  });

  it('returns all non-denied notes sorted', async () => {
    const result = await callTool('list-notes', {});
    const text = result.content[0].text;
    assert.ok(text.includes('inbox/todo.md'));
    assert.ok(text.includes('projects/alpha.md'));
    assert.ok(!text.includes(`${DENY_DIR}/secret.md`), 'denied notes must not appear');
    assert.ok(!result.isError);
  });

  it('scopes to a subfolder', async () => {
    const result = await callTool('list-notes', { path: 'projects' });
    const text = result.content[0].text;
    assert.ok(text.includes('projects/alpha.md'));
    assert.ok(text.includes('projects/beta.md'));
    assert.ok(!text.includes('inbox/todo.md'));
    assert.ok(!result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('list-notes', { path: DENY_DIR });
    assert.ok(result.isError, 'denied scope should return isError');
  });

  it('unknown vault returns isError', async () => {
    const sid = await initSession();
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name: 'list-notes', arguments: { vault: 'no-such-vault' } },
    }, sid);
    assert.ok(r.msgs[0].result.isError);
  });
});

// ── list-tags ─────────────────────────────────────────────────────────────

describe('list-tags', () => {
  before(async () => {
    await writeVaultNote('tagged/a.md', '---\ntags: [cooking, travel]\n---\nBody.');
    await writeVaultNote('tagged/b.md', '---\ntags:\n  - cooking\n  - photography\n---\nBody.');
    await writeVaultNote(`${DENY_DIR}/private-tags.md`, '---\ntags: [hidden]\n---\n');
  });

  it('returns unique sorted tags excluding denied paths', async () => {
    const result = await callTool('list-tags', {});
    const tags = result.content[0].text.split('\n');
    assert.ok(tags.includes('cooking'));
    assert.ok(tags.includes('travel'));
    assert.ok(tags.includes('photography'));
    assert.ok(!tags.includes('hidden'), 'tags from denied notes must not appear');
    assert.ok(!result.isError);
  });

  it('scopes to a subfolder', async () => {
    const result = await callTool('list-tags', { path: 'tagged' });
    const tags = result.content[0].text.split('\n');
    assert.ok(tags.includes('cooking'));
    assert.ok(!result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('list-tags', { path: DENY_DIR });
    assert.ok(result.isError);
  });
});

// ── search-tag ────────────────────────────────────────────────────────────

describe('search-tag', () => {
  before(async () => {
    await writeVaultNote('searchable/one.md', '---\ntags: [project, active]\n---\n');
    await writeVaultNote('searchable/two.md', '---\ntags: [project, archived]\n---\n');
    await writeVaultNote('searchable/three.md', '---\ntags: [personal]\n---\n');
    await writeVaultNote(`${DENY_DIR}/denied-tag.md`, '---\ntags: [project]\n---\n');
  });

  it('finds notes with a single tag', async () => {
    const result = await callTool('search-tag', { tags: ['project'] });
    const text = result.content[0].text;
    assert.ok(text.includes('searchable/one.md'));
    assert.ok(text.includes('searchable/two.md'));
    assert.ok(!text.includes(`${DENY_DIR}/denied-tag.md`));
    assert.ok(!result.isError);
  });

  it('requires ALL tags (AND logic)', async () => {
    const result = await callTool('search-tag', { tags: ['project', 'active'] });
    const text = result.content[0].text;
    assert.ok(text.includes('searchable/one.md'));
    assert.ok(!text.includes('searchable/two.md'), 'archived note should not match active+project');
    assert.ok(!result.isError);
  });

  it('returns no notes found when no match', async () => {
    const result = await callTool('search-tag', { tags: ['nonexistent-tag-xyz'] });
    assert.ok(result.content[0].text.includes('No notes found'));
    assert.ok(!result.isError);
  });

  it('returns isError for empty tags array', async () => {
    const result = await callTool('search-tag', { tags: [] });
    assert.ok(result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('search-tag', { tags: ['project'], path: DENY_DIR });
    assert.ok(result.isError);
  });
});

// ── new-notes / changed-notes ─────────────────────────────────────────────

describe('new-notes', () => {
  before(async () => {
    await writeVaultNote(`${DENY_DIR}/denied-new.md`, '# Secret');
  });

  it('returns notes created within default 7-day window', async () => {
    await writeVaultNote('recent/new-note.md', '# New');
    const result = await callTool('new-notes', {});
    assert.ok(result.content[0].text.includes('recent/new-note.md'));
    assert.ok(!result.isError);
  });

  it('returns notes created since a provided timestamp', async () => {
    await writeVaultNote('recent/since-note.md', '# Since');
    const since = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
    const result = await callTool('new-notes', { since });
    assert.ok(result.content[0].text.includes('recent/since-note.md'));
    assert.ok(!result.isError);
  });

  it('returns isError for an invalid since timestamp', async () => {
    const result = await callTool('new-notes', { since: 'not-a-date' });
    assert.ok(result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('new-notes', { path: DENY_DIR });
    assert.ok(result.isError);
  });

  it('excludes denied notes from vault-wide results', async () => {
    const result = await callTool('new-notes', {});
    assert.ok(!result.content[0].text.includes(`${DENY_DIR}/denied-new.md`));
  });
});

describe('changed-notes', () => {
  before(async () => {
    await writeVaultNote(`${DENY_DIR}/denied-changed.md`, '# Secret');
  });

  it('returns recently modified notes', async () => {
    await writeVaultNote('recent/changed-note.md', '# Changed');
    const result = await callTool('changed-notes', {});
    assert.ok(result.content[0].text.includes('recent/changed-note.md'));
    assert.ok(!result.isError);
  });

  it('excludes notes modified before the since timestamp', async () => {
    await writeVaultNote('recent/old-note.md', '# Old');
    const since = new Date(Date.now() + 5000).toISOString(); // 5 seconds in the future
    const result = await callTool('changed-notes', { since });
    assert.ok(!result.content[0].text.includes('recent/old-note.md'));
    assert.ok(!result.isError);
  });

  it('returns isError for an invalid since timestamp', async () => {
    const result = await callTool('changed-notes', { since: 'not-a-date' });
    assert.ok(result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('changed-notes', { path: DENY_DIR });
    assert.ok(result.isError);
  });

  it('excludes denied notes from vault-wide results', async () => {
    const result = await callTool('changed-notes', {});
    assert.ok(!result.content[0].text.includes(`${DENY_DIR}/denied-changed.md`));
  });
});

// ── read-note ─────────────────────────────────────────────────────────────

describe('read-note', () => {
  before(async () => {
    await writeVaultNote('readable/hello.md', '# Hello\nsome content here');
    await writeVaultNote(`${DENY_DIR}/nope.md`, '# Secret');
  });

  it('reads an existing note', async () => {
    const result = await callTool('read-note', { folder: 'readable', filename: 'hello.md' });
    assert.ok(result.content[0].text.includes('some content here'));
    assert.ok(!result.isError);
  });

  it('returns isError for a missing note', async () => {
    const result = await callTool('read-note', { filename: 'does-not-exist.md' });
    assert.ok(result.isError);
  });

  it('returns isError when note is in denied path', async () => {
    const result = await callTool('read-note', { folder: DENY_DIR, filename: 'nope.md' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });

  it('returns isError when filename is missing', async () => {
    const result = await callTool('read-note', { folder: 'readable', filename: '' });
    assert.ok(result.isError);
  });
});

// ── create-note ───────────────────────────────────────────────────────────

describe('create-note', () => {
  it('creates a new note', async () => {
    const result = await callTool('create-note', { filename: 'create-test-1.md', content: '# Created' });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('Created'));
    const content = await fs.readFile(path.join(vaultDir, 'create-test-1.md'), 'utf8');
    assert.equal(content, '# Created');
  });

  it('creates note with empty content when content is omitted', async () => {
    const result = await callTool('create-note', { filename: 'create-test-empty.md' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'create-test-empty.md'), 'utf8');
    assert.equal(content, '');
  });

  it('returns isError if note already exists', async () => {
    await writeVaultNote('create-test-exists.md', 'existing');
    const result = await callTool('create-note', { filename: 'create-test-exists.md', content: 'new' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('already exists'));
    // Verify original content is untouched
    const content = await fs.readFile(path.join(vaultDir, 'create-test-exists.md'), 'utf8');
    assert.equal(content, 'existing');
  });

  it('creates notes in subdirectories', async () => {
    const result = await callTool('create-note', { folder: 'subdir/nested', filename: 'deep.md', content: 'deep' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'subdir/nested/deep.md'), 'utf8');
    assert.equal(content, 'deep');
  });

  it('returns isError when note is in denied path', async () => {
    const result = await callTool('create-note', { folder: DENY_DIR, filename: 'blocked.md' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });
});

// ── edit-note ─────────────────────────────────────────────────────────────

describe('edit-note', () => {
  before(async () => {
    await writeVaultNote('editable/target.md', 'original content');
  });

  it('appends content', async () => {
    await writeVaultNote('editable/append-test.md', 'line one\n');
    const result = await callTool('edit-note', { folder: 'editable', filename: 'append-test.md', operation: 'append', content: 'line two\n' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'editable/append-test.md'), 'utf8');
    assert.equal(content, 'line one\nline two\n');
  });

  it('prepends content', async () => {
    await writeVaultNote('editable/prepend-test.md', 'existing\n');
    const result = await callTool('edit-note', { folder: 'editable', filename: 'prepend-test.md', operation: 'prepend', content: 'new first\n' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'editable/prepend-test.md'), 'utf8');
    assert.equal(content, 'new first\nexisting\n');
  });

  it('replaces content', async () => {
    await writeVaultNote('editable/replace-test.md', 'old content');
    const result = await callTool('edit-note', { folder: 'editable', filename: 'replace-test.md', operation: 'replace', content: 'new content' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'editable/replace-test.md'), 'utf8');
    assert.equal(content, 'new content');
  });

  it('treats absent content as empty string (null guard)', async () => {
    await writeVaultNote('editable/null-content.md', 'base\n');
    // Omit content field — args.content will be undefined
    const sid = await initSession();
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name: 'edit-note', arguments: { vault: vaultName, folder: 'editable', filename: 'null-content.md', operation: 'append' } },
    }, sid);
    const result = r.msgs[0].result;
    assert.ok(!result.isError, 'missing content should not cause an error');
    const content = await fs.readFile(path.join(vaultDir, 'editable/null-content.md'), 'utf8');
    assert.equal(content, 'base\n', 'content should be unchanged when appending empty string');
  });

  it('returns isError for invalid operation', async () => {
    const result = await callTool('edit-note', { folder: 'editable', filename: 'target.md', operation: 'upsert', content: 'x' });
    assert.ok(result.isError);
  });

  it('returns isError for a missing note', async () => {
    const result = await callTool('edit-note', { filename: 'ghost.md', operation: 'append', content: 'x' });
    assert.ok(result.isError);
  });

  it('returns isError when note is in denied path', async () => {
    await writeVaultNote(`${DENY_DIR}/edit-blocked.md`, 'content');
    const result = await callTool('edit-note', { folder: DENY_DIR, filename: 'edit-blocked.md', operation: 'replace', content: 'x' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });
});

// ── delete-note ───────────────────────────────────────────────────────────

describe('delete-note', () => {
  it('moves note to .trash by default', async () => {
    await writeVaultNote('deletable/to-trash.md', 'bye');
    const result = await callTool('delete-note', { folder: 'deletable', filename: 'to-trash.md' });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('trash'));
    // file should be gone from original location
    await assert.rejects(fs.access(path.join(vaultDir, 'deletable/to-trash.md')));
    // file should be in .trash
    const trashEntries = await fs.readdir(path.join(vaultDir, '.trash'));
    assert.ok(trashEntries.some(e => e.includes('to-trash')));
  });

  it('permanently deletes when permanent=true', async () => {
    await writeVaultNote('deletable/permanent.md', 'gone');
    const result = await callTool('delete-note', { folder: 'deletable', filename: 'permanent.md', permanent: true });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('Deleted'));
    await assert.rejects(fs.access(path.join(vaultDir, 'deletable/permanent.md')));
  });

  it('returns isError when note is in denied path', async () => {
    await writeVaultNote(`${DENY_DIR}/delete-blocked.md`, 'secret');
    const result = await callTool('delete-note', { folder: DENY_DIR, filename: 'delete-blocked.md' });
    assert.ok(result.isError);
  });

  it('returns isError for missing note', async () => {
    const result = await callTool('delete-note', { filename: 'ghost.md' });
    assert.ok(result.isError);
  });
});

// ── move-note ─────────────────────────────────────────────────────────────

describe('move-note', () => {
  it('moves a note to a new location', async () => {
    await writeVaultNote('moveable/source.md', '# Source');
    const result = await callTool('move-note', {
      folder: 'moveable', filename: 'source.md',
      newFolder: 'moved', newFilename: 'destination.md',
    });
    assert.ok(!result.isError);
    await assert.rejects(fs.access(path.join(vaultDir, 'moveable/source.md')));
    const content = await fs.readFile(path.join(vaultDir, 'moved/destination.md'), 'utf8');
    assert.equal(content, '# Source');
  });

  it('rewrites wikilinks in other notes after move', async () => {
    await writeVaultNote('wikilink-src/original.md', '# Original');
    await writeVaultNote('wikilink-ref/linker.md', 'See [[original]] for details.');
    await callTool('move-note', {
      folder: 'wikilink-src', filename: 'original.md',
      newFolder: 'wikilink-dst', newFilename: 'renamed.md',
    });
    const linker = await fs.readFile(path.join(vaultDir, 'wikilink-ref/linker.md'), 'utf8');
    assert.ok(linker.includes('[[wikilink-dst/renamed]]') || linker.includes('[[renamed]]'),
      `linker should point to new name, got: ${linker}`);
  });

  it('returns isError if destination already exists', async () => {
    await writeVaultNote('collision/a.md', 'A');
    await writeVaultNote('collision/b.md', 'B');
    const result = await callTool('move-note', {
      folder: 'collision', filename: 'a.md',
      newFolder: 'collision', newFilename: 'b.md',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.toLowerCase().includes('exist'));
  });

  it('returns isError when source is in denied path', async () => {
    await writeVaultNote(`${DENY_DIR}/move-src.md`, 'secret');
    const result = await callTool('move-note', {
      folder: DENY_DIR, filename: 'move-src.md',
      newFolder: 'inbox', newFilename: 'move-src.md',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });

  it('returns isError when destination is in denied path', async () => {
    await writeVaultNote('move-allowed-src.md', 'content');
    const result = await callTool('move-note', {
      filename: 'move-allowed-src.md',
      newFolder: DENY_DIR, newFilename: 'move-allowed-src.md',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });
});

// ── create-directory ──────────────────────────────────────────────────────

describe('create-directory', () => {
  it('creates a directory (and parents)', async () => {
    const result = await callTool('create-directory', { folder: 'newdir/nested' });
    assert.ok(!result.isError);
    const stat = await fs.stat(path.join(vaultDir, 'newdir/nested'));
    assert.ok(stat.isDirectory());
  });

  it('succeeds even if directory already exists (idempotent)', async () => {
    await fs.mkdir(path.join(vaultDir, 'already-exists'), { recursive: true });
    const result = await callTool('create-directory', { folder: 'already-exists' });
    assert.ok(!result.isError);
  });

  it('returns isError when folder is in denied path', async () => {
    const result = await callTool('create-directory', { folder: `${DENY_DIR}/subdir` });
    assert.ok(result.isError);
  });

  it('returns isError when folder is missing', async () => {
    const result = await callTool('create-directory', { folder: '' });
    assert.ok(result.isError);
  });
});

// ── search-vault ──────────────────────────────────────────────────────────

describe('search-vault', () => {
  before(async () => {
    await writeVaultNote('searchable-content/a.md', 'The quick brown fox\njumps over the lazy dog');
    await writeVaultNote('searchable-content/b.md', 'Nothing matches here');
    await writeVaultNote('searchable-content/unique-filename-xyz.md', 'content');
    await writeVaultNote(`${DENY_DIR}/hidden-content.md`, 'quick brown fox');
  });

  it('returns content matches with file and line number', async () => {
    const result = await callTool('search-vault', { query: 'quick brown fox', searchType: 'content' });
    const text = result.content[0].text;
    assert.ok(text.includes('searchable-content/a.md'));
    assert.ok(text.includes(':1:'), 'should include line number');
    assert.ok(!text.includes(`${DENY_DIR}/`), 'denied files must not appear');
    assert.ok(!result.isError);
  });

  it('returns filename matches', async () => {
    const result = await callTool('search-vault', { query: 'unique-filename-xyz', searchType: 'filename' });
    const text = result.content[0].text;
    assert.ok(text.includes('unique-filename-xyz.md'));
    assert.ok(!result.isError);
  });

  it('returns both content and filename matches', async () => {
    const result = await callTool('search-vault', { query: 'unique-filename-xyz', searchType: 'both' });
    const text = result.content[0].text;
    assert.ok(text.includes('unique-filename-xyz.md'));
    assert.ok(!result.isError);
  });

  it('returns no results found when nothing matches', async () => {
    const result = await callTool('search-vault', { query: 'zzz-no-match-guaranteed', searchType: 'content' });
    assert.ok(result.content[0].text.includes('No results found'));
    assert.ok(!result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('search-vault', { query: 'fox', searchType: 'content', path: DENY_DIR });
    assert.ok(result.isError);
  });

  it('returns isError for missing query', async () => {
    const result = await callTool('search-vault', { searchType: 'content' });
    assert.ok(result.isError);
  });
});

// ── add-tags ──────────────────────────────────────────────────────────────

describe('add-tags', () => {
  it('adds tags to frontmatter', async () => {
    await writeVaultNote('tag-ops/fm-add.md', '---\ntags: [existing]\n---\nBody.');
    const result = await callTool('add-tags', { files: ['tag-ops/fm-add.md'], tags: ['new-tag'], location: 'frontmatter' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/fm-add.md'), 'utf8');
    assert.ok(content.includes('new-tag'), 'new-tag should be in frontmatter');
    assert.ok(content.includes('existing'), 'existing tag should be preserved');
  });

  it('adds inline tags to content without duplicating existing ones', async () => {
    await writeVaultNote('tag-ops/inline-add.md', 'Hello world\n#already-there\n');
    const result = await callTool('add-tags', {
      files: ['tag-ops/inline-add.md'],
      tags: ['already-there', 'brand-new'],
      location: 'content',
    });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/inline-add.md'), 'utf8');
    // already-there should appear exactly once
    const matches = content.match(/#already-there/g) ?? [];
    assert.equal(matches.length, 1, 'duplicate inline tag should not be added');
    assert.ok(content.includes('#brand-new'));
  });

  it('adds tags to both frontmatter and content', async () => {
    await writeVaultNote('tag-ops/both-add.md', '---\ntags: []\n---\nBody.');
    const result = await callTool('add-tags', { files: ['tag-ops/both-add.md'], tags: ['mytag'], location: 'both' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/both-add.md'), 'utf8');
    const fmEnd = content.indexOf('---', 3);
    assert.ok(content.slice(0, fmEnd).includes('mytag'), 'tag should appear in frontmatter');
    assert.ok(content.includes('#mytag'), 'tag should appear inline');
  });

  it('blocks the call when all files are in denied paths', async () => {
    await writeVaultNote(`${DENY_DIR}/denied-add.md`, 'content');
    const result = await callTool('add-tags', {
      files: [`${DENY_DIR}/denied-add.md`],
      tags: ['new'],
    });
    // checkAccess pre-flights the call and returns isError before the per-file loop runs
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });
});

// ── remove-tags ───────────────────────────────────────────────────────────

describe('remove-tags', () => {
  it('removes tags from frontmatter', async () => {
    await writeVaultNote('tag-ops/fm-remove.md', '---\ntags: [keep, remove-me]\n---\nBody.');
    const result = await callTool('remove-tags', { files: ['tag-ops/fm-remove.md'], tags: ['remove-me'], location: 'frontmatter' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/fm-remove.md'), 'utf8');
    assert.ok(!content.includes('remove-me'));
    assert.ok(content.includes('keep'));
  });

  it('removes inline tags without leaving double spaces', async () => {
    await writeVaultNote('tag-ops/inline-remove.md', 'word1 #remove-me word2\n');
    const result = await callTool('remove-tags', { files: ['tag-ops/inline-remove.md'], tags: ['remove-me'], location: 'content' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/inline-remove.md'), 'utf8');
    assert.ok(!content.includes('#remove-me'));
    assert.ok(!content.includes('  '), 'should not leave double spaces');
    assert.ok(content.includes('word1') && content.includes('word2'));
  });

  it('removes standalone inline tag at start of line without leaving blank clutter', async () => {
    await writeVaultNote('tag-ops/standalone-remove.md', 'content\n#standalone-tag\nmore\n');
    const result = await callTool('remove-tags', { files: ['tag-ops/standalone-remove.md'], tags: ['standalone-tag'], location: 'content' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/standalone-remove.md'), 'utf8');
    assert.ok(!content.includes('#standalone-tag'));
  });

  it('removes tags from both frontmatter and content', async () => {
    await writeVaultNote('tag-ops/both-remove.md', '---\ntags: [zap]\n---\nBody #zap here.');
    const result = await callTool('remove-tags', { files: ['tag-ops/both-remove.md'], tags: ['zap'], location: 'both' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/both-remove.md'), 'utf8');
    assert.ok(!content.includes('zap'), 'tag should be removed from both frontmatter and content');
  });

  it('blocks the call when all files are in denied paths', async () => {
    await writeVaultNote(`${DENY_DIR}/denied-remove.md`, '---\ntags: [old]\n---\n');
    const result = await callTool('remove-tags', { files: [`${DENY_DIR}/denied-remove.md`], tags: ['old'] });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });
});

// ── rename-tag ────────────────────────────────────────────────────────────

describe('rename-tag', () => {
  it('renames a tag across the vault and reports count', async () => {
    const oldTag = 'rename-old-unique';
    const newTag = 'rename-new-unique';
    await writeVaultNote('renameables/x.md', `---\ntags: [${oldTag}]\n---\nInline #${oldTag} here.`);
    await writeVaultNote('renameables/y.md', `---\ntags: [${oldTag}, other]\n---\n`);

    const result = await callTool('rename-tag', { oldTag, newTag });
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /\bin 2 note/, 'should report 2 notes updated');

    const x = await fs.readFile(path.join(vaultDir, 'renameables/x.md'), 'utf8');
    const y = await fs.readFile(path.join(vaultDir, 'renameables/y.md'), 'utf8');
    assert.ok(!x.includes(oldTag));
    assert.ok(x.includes(newTag));
    assert.ok(!y.includes(oldTag));
    assert.ok(y.includes(newTag));
  });

  it('returns isError when oldTag is missing', async () => {
    const result = await callTool('rename-tag', { oldTag: '', newTag: 'something' });
    assert.ok(result.isError);
  });

  it('returns isError for unknown vault', async () => {
    const sid = await initSession();
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name: 'rename-tag', arguments: { vault: 'wrong-vault', oldTag: 'x', newTag: 'y' } },
    }, sid);
    assert.ok(r.msgs[0].result.isError);
  });
});
