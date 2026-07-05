import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  walkVault,
  readNote,
  writeNote,
  deleteNote,
  moveNote,
  searchContent,
  searchFilename,
} from '../lib/vault.mjs';

// ── test vault setup ─────────────────────────────────────────────────────────

let vault;

async function setup() {
  vault = await fs.mkdtemp(path.join(tmpdir(), 'vault-test-'));
  await fs.mkdir(path.join(vault, 'food'));
  await fs.mkdir(path.join(vault, 'private'));
  await fs.writeFile(path.join(vault, 'food', 'pasta.md'), `---\ntags: [cooking]\n---\n# Pasta\n\nSee [[sauce]] for the sauce recipe.\n`);
  await fs.writeFile(path.join(vault, 'food', 'sauce.md'), `---\ntags: [cooking]\n---\n# Sauce\n\nA tomato sauce.\n`);
  await fs.writeFile(path.join(vault, 'private', 'journal.md'), `# Journal\n\nPrivate notes.\n`);
  await fs.writeFile(path.join(vault, 'inbox.md'), `# Inbox\n\nLinks: [[pasta]] and [[private/journal]].\n`);
}

async function teardown() {
  await fs.rm(vault, { recursive: true });
}

// ── walkVault ─────────────────────────────────────────────────────────────────

describe('walkVault', () => {
  before(setup);
  after(teardown);

  it('visits all .md files recursively', async () => {
    const visited = [];
    await walkVault(vault, f => visited.push(path.relative(vault, f)));
    visited.sort();
    assert.deepEqual(visited, ['food/pasta.md', 'food/sauce.md', 'inbox.md', 'private/journal.md']);
  });

  it('visits files in a subdirectory', async () => {
    const visited = [];
    await walkVault(path.join(vault, 'food'), f => visited.push(path.relative(vault, f)));
    visited.sort();
    assert.deepEqual(visited, ['food/pasta.md', 'food/sauce.md']);
  });

  it('handles non-existent directory gracefully', async () => {
    await assert.doesNotReject(() => walkVault(path.join(vault, 'missing'), () => {}));
  });
});

// ── readNote ──────────────────────────────────────────────────────────────────

describe('readNote', () => {
  before(setup);
  after(teardown);

  it('reads note content', async () => {
    const content = await readNote(path.join(vault, 'food', 'pasta.md'));
    assert.ok(content.includes('# Pasta'));
  });

  it('throws on missing file', async () => {
    await assert.rejects(() => readNote(path.join(vault, 'missing.md')));
  });
});

// ── writeNote ─────────────────────────────────────────────────────────────────

describe('writeNote', () => {
  before(setup);
  after(teardown);

  it('writes note content', async () => {
    const p = path.join(vault, 'food', 'new.md');
    await writeNote(p, '# New Note\n');
    const content = await fs.readFile(p, 'utf8');
    assert.equal(content, '# New Note\n');
  });

  it('creates parent directories', async () => {
    const p = path.join(vault, 'deep', 'nested', 'note.md');
    await writeNote(p, '# Deep\n');
    const content = await fs.readFile(p, 'utf8');
    assert.equal(content, '# Deep\n');
  });

  it('overwrites existing file', async () => {
    const p = path.join(vault, 'food', 'pasta.md');
    await writeNote(p, '# Updated\n');
    const content = await fs.readFile(p, 'utf8');
    assert.equal(content, '# Updated\n');
  });
});

// ── deleteNote ────────────────────────────────────────────────────────────────

describe('deleteNote', () => {
  before(setup);
  after(teardown);

  it('moves note to .trash (default)', async () => {
    // Create a note to delete
    const p = path.join(vault, 'to-delete.md');
    await fs.writeFile(p, '# Delete me\n');
    await deleteNote(p, false, vault);
    // File should be gone from original location
    await assert.rejects(() => fs.access(p));
    // Should exist in .trash
    const trashed = path.join(vault, '.trash', 'to-delete.md');
    await assert.doesNotReject(() => fs.access(trashed));
  });

  it('deletes note permanently', async () => {
    const p = path.join(vault, 'to-delete-perm.md');
    await fs.writeFile(p, '# Delete me permanently\n');
    await deleteNote(p, true, vault);
    await assert.rejects(() => fs.access(p));
    // Should NOT be in .trash
    const trashed = path.join(vault, '.trash', 'to-delete-perm.md');
    await assert.rejects(() => fs.access(trashed));
  });
});

// ── moveNote ──────────────────────────────────────────────────────────────────

describe('moveNote', () => {
  before(setup);
  after(teardown);

  it('moves note to new location', async () => {
    const src = path.join(vault, 'food', 'sauce.md');
    const dst = path.join(vault, 'cooking', 'sauce.md');
    await moveNote(vault, src, dst, []);
    await assert.rejects(() => fs.access(src), 'source removed');
    await assert.doesNotReject(() => fs.access(dst), 'destination created');
  });

  it('rewrites wikilinks in other notes after move', async () => {
    // inbox.md has [[pasta]] — move pasta.md to cooking/pasta.md
    // Reset setup for clean state
    await fs.writeFile(path.join(vault, 'inbox.md'), `# Inbox\n\nLinks: [[pasta]] and [[private/journal]].\n`);
    await fs.mkdir(path.join(vault, 'food'), { recursive: true });
    await fs.writeFile(path.join(vault, 'food', 'pasta.md'), `---\ntags: [cooking]\n---\n# Pasta\n`);

    const src = path.join(vault, 'food', 'pasta.md');
    const dst = path.join(vault, 'cooking', 'pasta.md');
    await moveNote(vault, src, dst, []);

    const inbox = await fs.readFile(path.join(vault, 'inbox.md'), 'utf8');
    assert.ok(inbox.includes('[[cooking/pasta]]'), 'link rewritten');
    assert.ok(!inbox.includes('[[pasta]]') || inbox.includes('[[cooking/pasta]]'), 'old link gone');
  });

  it('creates destination directory if needed', async () => {
    await fs.writeFile(path.join(vault, 'new-note.md'), '# New\n');
    const src = path.join(vault, 'new-note.md');
    const dst = path.join(vault, 'archive', 'new-note.md');
    await moveNote(vault, src, dst, []);
    await assert.doesNotReject(() => fs.access(dst));
  });
});

// ── searchContent ─────────────────────────────────────────────────────────────

describe('searchContent', () => {
  before(setup);
  after(teardown);

  it('finds notes containing query', async () => {
    const results = await searchContent(vault, 'tomato', vault, []);
    const paths = results.map(r => r.path);
    assert.ok(paths.some(p => p.includes('sauce')), 'sauce.md found');
  });

  it('is case-insensitive', async () => {
    const results = await searchContent(vault, 'TOMATO', vault, []);
    assert.ok(results.length > 0);
  });

  it('returns empty array when no matches', async () => {
    const results = await searchContent(vault, 'xyzzy-no-match', vault, []);
    assert.deepEqual(results, []);
  });

  it('scopes search to subdirectory', async () => {
    const results = await searchContent(vault, 'Private', path.join(vault, 'food'), []);
    assert.equal(results.length, 0, 'private not in food scope');
  });

  it('excludes denied paths', async () => {
    const results = await searchContent(vault, 'Private', vault, ['private']);
    const paths = results.map(r => r.path);
    assert.ok(!paths.some(p => p.includes('private')));
  });

  it('includes matching line with line number in result', async () => {
    const results = await searchContent(vault, 'tomato', vault, []);
    const sauce = results.find(r => r.path.includes('sauce'));
    assert.ok(sauce?.matches?.length > 0);
    assert.ok(typeof sauce.matches[0].line === 'number');
    assert.ok(sauce.matches[0].text.toLowerCase().includes('tomato'));
  });
});

// ── searchFilename ────────────────────────────────────────────────────────────

describe('searchFilename', () => {
  before(setup);
  after(teardown);

  it('finds notes by filename', async () => {
    const results = await searchFilename(vault, 'pasta', vault, []);
    assert.ok(results.some(p => p.includes('pasta')));
  });

  it('is case-insensitive', async () => {
    const results = await searchFilename(vault, 'PASTA', vault, []);
    assert.ok(results.length > 0);
  });

  it('returns empty array when no matches', async () => {
    const results = await searchFilename(vault, 'xyzzy-no-match', vault, []);
    assert.deepEqual(results, []);
  });

  it('scopes search to subdirectory', async () => {
    const results = await searchFilename(vault, 'journal', path.join(vault, 'food'), []);
    assert.equal(results.length, 0);
  });

  it('excludes denied paths', async () => {
    const results = await searchFilename(vault, 'journal', vault, ['private']);
    assert.equal(results.length, 0);
  });

  it('returns vault-relative paths', async () => {
    const results = await searchFilename(vault, 'pasta', vault, []);
    assert.ok(results.every(p => !path.isAbsolute(p)));
  });
});
