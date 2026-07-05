import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normPath, isDenied, checkAccess } from '../lib/access.mjs';

const DENY = ['people', 'private/journal'];

// ── normPath ────────────────────────────────────────────────────────────────

describe('normPath', () => {
  it('joins folder and filename', () => {
    assert.equal(normPath('people', 'alice.md'), 'people/alice.md');
  });

  it('strips leading and trailing slashes', () => {
    assert.equal(normPath('/people/alice/'), 'people/alice');
  });

  it('collapses multiple slashes', () => {
    assert.equal(normPath('people//alice'), 'people/alice');
  });

  it('resolves .. segments', () => {
    assert.equal(normPath('people/../notes/foo.md'), 'notes/foo.md');
  });

  it('cannot escape above root via ..', () => {
    assert.equal(normPath('../../etc/passwd'), 'etc/passwd');
  });

  it('ignores . segments', () => {
    assert.equal(normPath('./people/./alice.md'), 'people/alice.md');
  });

  it('filters falsy parts', () => {
    assert.equal(normPath(undefined, 'alice.md'), 'alice.md');
    assert.equal(normPath('', 'alice.md'), 'alice.md');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normPath(''), '');
    assert.equal(normPath(), '');
  });
});

// ── isDenied ────────────────────────────────────────────────────────────────

describe('isDenied', () => {
  it('blocks exact match on denied path', () => {
    assert.ok(isDenied(DENY, 'people'));
  });

  it('blocks paths under denied prefix', () => {
    assert.ok(isDenied(DENY, 'people/alice.md'));
    assert.ok(isDenied(DENY, 'people/subdir/note.md'));
  });

  it('does not block sibling that shares prefix characters', () => {
    assert.ok(!isDenied(DENY, 'people-extra'));
    assert.ok(!isDenied(DENY, 'peoples'));
  });

  it('blocks nested deny path', () => {
    assert.ok(isDenied(DENY, 'private/journal'));
    assert.ok(isDenied(DENY, 'private/journal/2024.md'));
  });

  it('does not block sibling of nested deny path', () => {
    assert.ok(!isDenied(DENY, 'private/notes'));
  });

  it('does not block allowed paths', () => {
    assert.ok(!isDenied(DENY, 'projects/alpha.md'));
    assert.ok(!isDenied(DENY, 'inbox'));
  });

  it('returns false when deny list is empty', () => {
    assert.ok(!isDenied([], 'people/alice.md'));
  });

  it('returns false for empty path', () => {
    assert.ok(!isDenied(DENY, ''));
    assert.ok(!isDenied(DENY, null));
    assert.ok(!isDenied(DENY, undefined));
  });

  it('normalises path before checking', () => {
    assert.ok(isDenied(DENY, '/people/../people/alice.md'));
    assert.ok(isDenied(DENY, '//people//alice.md'));
  });
});

// ── checkAccess ─────────────────────────────────────────────────────────────

describe('checkAccess', () => {
  it('returns null when deny list is empty', () => {
    assert.equal(checkAccess([], 'read-note', { folder: 'people', filename: 'alice.md' }), null);
  });

  it('returns null for unrecognised tool', () => {
    assert.equal(checkAccess(DENY, 'list-available-vaults', {}), null);
  });

  describe('read-note / create-note / edit-note', () => {
    it('blocks denied folder', () => {
      const r = checkAccess(DENY, 'read-note', { folder: 'people', filename: 'alice.md' });
      assert.ok(r?.includes('restricted'));
    });

    it('allows permitted folder', () => {
      assert.equal(checkAccess(DENY, 'read-note', { folder: 'projects', filename: 'alpha.md' }), null);
    });

    it('blocks via .. traversal into denied folder', () => {
      const r = checkAccess(DENY, 'edit-note', { folder: 'projects/../people', filename: 'alice.md' });
      assert.ok(r?.includes('restricted'));
    });

    it('handles missing folder (filename only)', () => {
      assert.equal(checkAccess(DENY, 'create-note', { filename: 'inbox.md' }), null);
    });
  });

  describe('delete-note', () => {
    it('blocks denied path', () => {
      const r = checkAccess(DENY, 'delete-note', { folder: 'people', filename: 'alice.md' });
      assert.ok(r?.includes('restricted'));
    });

    it('allows permitted path', () => {
      assert.equal(checkAccess(DENY, 'delete-note', { folder: 'inbox', filename: 'todo.md' }), null);
    });

    it('reflects normalised path in message, not raw input', () => {
      const r = checkAccess(DENY, 'delete-note', { folder: '//people', filename: 'alice.md' });
      assert.ok(r?.includes("'people/alice.md'"));
      assert.ok(!r?.includes('//'));
    });

    it('handles missing folder (filename only)', () => {
      assert.equal(checkAccess(DENY, 'delete-note', { filename: 'inbox.md' }), null);
    });
  });

  describe('move-note', () => {
    it('blocks denied source', () => {
      const r = checkAccess(DENY, 'move-note', { folder: 'people', filename: 'alice.md', newFilename: 'alice.md' });
      assert.ok(r?.includes('source'));
    });

    it('blocks denied destination', () => {
      const r = checkAccess(DENY, 'move-note', { filename: 'alice.md', newFolder: 'people', newFilename: 'alice.md' });
      assert.ok(r?.includes('destination'));
    });

    it('allows permitted source and destination', () => {
      assert.equal(checkAccess(DENY, 'move-note', { filename: 'a.md', newFolder: 'projects', newFilename: 'a.md' }), null);
    });

    it('allows when source has no folder (root-level file)', () => {
      assert.equal(checkAccess(DENY, 'move-note', { filename: 'inbox.md', newFolder: 'projects', newFilename: 'inbox.md' }), null);
    });

    it('allows when destination has no folder (root-level destination)', () => {
      assert.equal(checkAccess(DENY, 'move-note', { folder: 'projects', filename: 'a.md', newFilename: 'a.md' }), null);
    });
  });

  describe('add-tags / remove-tags', () => {
    it('blocks when any file is in denied path', () => {
      const r = checkAccess(DENY, 'add-tags', { files: ['inbox/a.md', 'people/alice.md'] });
      assert.ok(r?.includes('restricted'));
    });

    it('allows when all files are permitted', () => {
      assert.equal(checkAccess(DENY, 'add-tags', { files: ['inbox/a.md', 'projects/b.md'] }), null);
    });

    it('handles non-array files gracefully', () => {
      assert.equal(checkAccess(DENY, 'add-tags', { files: 'people/alice.md' }), null);
      assert.equal(checkAccess(DENY, 'add-tags', {}), null);
    });

    it('handles empty files array', () => {
      assert.equal(checkAccess(DENY, 'remove-tags', { files: [] }), null);
    });
  });

  describe('create-directory', () => {
    it('blocks denied path', () => {
      const r = checkAccess(DENY, 'create-directory', { folder: 'people/new' });
      assert.ok(r?.includes('restricted'));
    });

    it('allows permitted path', () => {
      assert.equal(checkAccess(DENY, 'create-directory', { folder: 'projects/new' }), null);
    });

    it('blocks .. traversal into denied path', () => {
      const r = checkAccess(DENY, 'create-directory', { folder: 'projects/../people/new' });
      assert.ok(r?.includes('restricted'));
    });
  });

  describe('search-vault', () => {
    it('blocks denied path scope', () => {
      const r = checkAccess(DENY, 'search-vault', { query: 'foo', path: 'people' });
      assert.ok(r?.includes('restricted'));
    });

    it('allows permitted path scope', () => {
      assert.equal(checkAccess(DENY, 'search-vault', { query: 'foo', path: 'projects' }), null);
    });

    it('allows vault-wide search with no path', () => {
      assert.equal(checkAccess(DENY, 'search-vault', { query: 'foo' }), null);
    });
  });
});
