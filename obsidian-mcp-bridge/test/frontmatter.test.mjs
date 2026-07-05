import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTags, setTags, addTags, removeTags, renameTag } from '../lib/frontmatter.mjs';

const FM_INLINE = `---\ntags: [type/recipe, cooking]\ntitle: Pasta\n---\n# Pasta\n`;
const FM_BLOCK = `---\ntags:\n  - type/recipe\n  - cooking\ntitle: Pasta\n---\n# Pasta\n`;
const FM_NONE = `---\ntitle: Pasta\n---\n# Pasta\n`;
const NO_FM = `# Pasta\n\nNo frontmatter here.\n`;

// ── parseTags ────────────────────────────────────────────────────────────────

describe('parseTags', () => {
  it('parses inline array tags', () => {
    assert.deepEqual(parseTags(FM_INLINE), ['type/recipe', 'cooking']);
  });

  it('parses block sequence tags', () => {
    assert.deepEqual(parseTags(FM_BLOCK), ['type/recipe', 'cooking']);
  });

  it('returns empty array when no tags key', () => {
    assert.deepEqual(parseTags(FM_NONE), []);
  });

  it('returns empty array when no frontmatter', () => {
    assert.deepEqual(parseTags(NO_FM), []);
  });

  it('handles quoted tags in inline array', () => {
    assert.deepEqual(parseTags(`---\ntags: ['type/recipe', "cooking"]\n---\n`), ['type/recipe', 'cooking']);
  });

  it('handles single tag in inline array', () => {
    assert.deepEqual(parseTags(`---\ntags: [cooking]\n---\n`), ['cooking']);
  });

  it('handles empty inline array', () => {
    assert.deepEqual(parseTags(`---\ntags: []\n---\n`), []);
  });

  it('parses hierarchical tags', () => {
    assert.deepEqual(parseTags(`---\ntags:\n  - type/recipe\n  - tech/node\n---\n`), ['type/recipe', 'tech/node']);
  });
});

// ── setTags ──────────────────────────────────────────────────────────────────

describe('setTags', () => {
  it('replaces inline array with block sequence', () => {
    const result = setTags(FM_INLINE, ['tech/node', 'cooking']);
    assert.deepEqual(parseTags(result), ['tech/node', 'cooking']);
  });

  it('replaces block sequence', () => {
    const result = setTags(FM_BLOCK, ['tech/node']);
    assert.deepEqual(parseTags(result), ['tech/node']);
  });

  it('preserves other frontmatter keys when replacing tags', () => {
    const result = setTags(FM_BLOCK, ['new-tag']);
    assert.ok(result.includes('title: Pasta'), 'other keys preserved');
  });

  it('adds tags section when frontmatter has none', () => {
    const result = setTags(FM_NONE, ['new-tag']);
    assert.deepEqual(parseTags(result), ['new-tag']);
    assert.ok(result.includes('title: Pasta'), 'other keys preserved');
  });

  it('adds frontmatter when note has none', () => {
    const result = setTags(NO_FM, ['new-tag']);
    assert.ok(result.startsWith('---\n'));
    assert.deepEqual(parseTags(result), ['new-tag']);
    assert.ok(result.includes('# Pasta'), 'body preserved');
  });

  it('handles empty tags array', () => {
    const result = setTags(FM_BLOCK, []);
    assert.deepEqual(parseTags(result), []);
  });

  it('preserves body content after frontmatter', () => {
    const result = setTags(FM_BLOCK, ['tag']);
    assert.ok(result.endsWith('# Pasta\n'));
  });
});

// ── addTags ──────────────────────────────────────────────────────────────────

describe('addTags', () => {
  it('adds new tags', () => {
    const result = addTags(FM_BLOCK, ['new-tag']);
    const tags = parseTags(result);
    assert.ok(tags.includes('new-tag'));
    assert.ok(tags.includes('type/recipe'));
    assert.ok(tags.includes('cooking'));
  });

  it('does not duplicate existing tags', () => {
    const result = addTags(FM_BLOCK, ['cooking', 'new-tag']);
    const tags = parseTags(result);
    assert.equal(tags.filter(t => t === 'cooking').length, 1);
    assert.ok(tags.includes('new-tag'));
  });

  it('returns unchanged content if all tags already present', () => {
    const result = addTags(FM_BLOCK, ['cooking', 'type/recipe']);
    assert.equal(result, FM_BLOCK);
  });

  it('adds tags to note with no frontmatter', () => {
    const result = addTags(NO_FM, ['new-tag']);
    assert.deepEqual(parseTags(result), ['new-tag']);
  });
});

// ── removeTags ───────────────────────────────────────────────────────────────

describe('removeTags', () => {
  it('removes specified tags', () => {
    const result = removeTags(FM_BLOCK, ['cooking']);
    const tags = parseTags(result);
    assert.ok(!tags.includes('cooking'));
    assert.ok(tags.includes('type/recipe'));
  });

  it('removes multiple tags', () => {
    const result = removeTags(FM_BLOCK, ['cooking', 'type/recipe']);
    assert.deepEqual(parseTags(result), []);
  });

  it('returns unchanged content if tag not present', () => {
    const result = removeTags(FM_BLOCK, ['nonexistent']);
    assert.equal(result, FM_BLOCK);
  });

  it('removes from inline array', () => {
    const result = removeTags(FM_INLINE, ['cooking']);
    assert.ok(!parseTags(result).includes('cooking'));
  });
});

// ── renameTag ────────────────────────────────────────────────────────────────

describe('renameTag', () => {
  it('renames tag in frontmatter block sequence', () => {
    const result = renameTag(FM_BLOCK, 'cooking', 'food/cooking');
    const tags = parseTags(result);
    assert.ok(tags.includes('food/cooking'));
    assert.ok(!tags.includes('cooking'));
  });

  it('renames tag in frontmatter inline array', () => {
    const result = renameTag(FM_INLINE, 'cooking', 'food/cooking');
    const tags = parseTags(result);
    assert.ok(tags.includes('food/cooking'));
    assert.ok(!tags.includes('cooking'));
  });

  it('renames inline body tags', () => {
    const content = `---\ntags: [cooking]\n---\n# Note\n\nSee #cooking for more.\n`;
    const result = renameTag(content, 'cooking', 'food/cooking');
    assert.ok(result.includes('#food/cooking'));
    assert.ok(!result.includes('\n#cooking') && !result.includes(' #cooking'));
  });

  it('renames body tag at start of line', () => {
    const content = `---\ntags: [cooking]\n---\n#cooking is used here.\n`;
    const result = renameTag(content, 'cooking', 'food/cooking');
    assert.ok(result.includes('#food/cooking'));
  });

  it('does not rename hierarchical subtags in body', () => {
    const content = `---\ntags: [type/recipe]\n---\nUse #type/recipe here.\n`;
    const result = renameTag(content, 'type', 'category');
    assert.deepEqual(parseTags(result), ['type/recipe'], 'frontmatter unchanged');
    assert.ok(result.includes('#type/recipe'), 'inline tag unchanged');
    assert.ok(!result.includes('#category'), 'no spurious rename');
  });

  it('does not rename tag that is a prefix of a hyphenated tag', () => {
    const content = `---\ntags: [cooking]\n---\nUse #cooking-notes here.\n`;
    const result = renameTag(content, 'cooking', 'food');
    // cooking-notes is a separate tag; should not be renamed
    assert.ok(result.includes('#cooking-notes'));
    assert.ok(!result.includes('#food-notes'));
  });

  it('does not rename partial word matches in body', () => {
    const content = `---\ntags: [type]\n---\n#typing is different from #type.\n`;
    const result = renameTag(content, 'type', 'category');
    assert.ok(result.includes('#typing'), '#typing preserved');
    assert.ok(result.includes('#category'), '#type renamed');
  });

  it('returns unchanged content when tag not present', () => {
    const result = renameTag(FM_BLOCK, 'nonexistent', 'new-name');
    assert.equal(result, FM_BLOCK);
  });
});
