import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteLinks, extractLinks } from '../lib/wikilinks.mjs';

// ── extractLinks ─────────────────────────────────────────────────────────────

describe('extractLinks', () => {
  it('extracts bare filename links', () => {
    const links = extractLinks('See [[note]] for details.');
    assert.deepEqual(links, [{ target: 'note', heading: '', alias: '' }]);
  });

  it('extracts path links', () => {
    const links = extractLinks('See [[folder/note]] here.');
    assert.deepEqual(links, [{ target: 'folder/note', heading: '', alias: '' }]);
  });

  it('extracts links with alias', () => {
    const links = extractLinks('See [[note|My Note]] here.');
    assert.deepEqual(links, [{ target: 'note', heading: '', alias: 'My Note' }]);
  });

  it('extracts links with heading', () => {
    const links = extractLinks('See [[note#section]] here.');
    assert.deepEqual(links, [{ target: 'note', heading: 'section', alias: '' }]);
  });

  it('extracts links with path, heading, and alias', () => {
    const links = extractLinks('See [[folder/note#section|label]] here.');
    assert.deepEqual(links, [{ target: 'folder/note', heading: 'section', alias: 'label' }]);
  });

  it('extracts multiple links', () => {
    const links = extractLinks('[[a]] and [[b|B]] and [[c#h]].');
    assert.equal(links.length, 3);
    assert.equal(links[0].target, 'a');
    assert.equal(links[1].target, 'b');
    assert.equal(links[2].target, 'c');
  });

  it('returns empty array when no links', () => {
    assert.deepEqual(extractLinks('No links here.'), []);
  });
});

// ── rewriteLinks ─────────────────────────────────────────────────────────────

describe('rewriteLinks', () => {
  it('rewrites bare filename link when note moves to a folder', () => {
    const content = 'See [[recipe]] here.';
    // note was at recipe.md (vault root), now at food/recipe.md
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, 'See [[food/recipe]] here.');
  });

  it('rewrites full path link', () => {
    const content = 'See [[food/recipe]] here.';
    const result = rewriteLinks(content, 'food/recipe', 'cooking/recipe');
    assert.equal(result, 'See [[cooking/recipe]] here.');
  });

  it('rewrites link by basename when note moves between folders', () => {
    const content = 'See [[recipe]] here.';
    // note was at old/recipe.md, now at new/recipe.md — bare link matches basename
    const result = rewriteLinks(content, 'old/recipe', 'new/recipe');
    assert.equal(result, 'See [[new/recipe]] here.');
  });

  it('preserves alias', () => {
    const content = 'See [[recipe|My Recipe]] here.';
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, 'See [[food/recipe|My Recipe]] here.');
  });

  it('preserves heading anchor', () => {
    const content = 'See [[recipe#ingredients]] here.';
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, 'See [[food/recipe#ingredients]] here.');
  });

  it('preserves heading and alias together', () => {
    const content = 'See [[folder/recipe#ingredients|label]] here.';
    const result = rewriteLinks(content, 'folder/recipe', 'food/recipe');
    assert.equal(result, 'See [[food/recipe#ingredients|label]] here.');
  });

  it('rewrites multiple occurrences', () => {
    const content = '[[recipe]] and [[recipe|alias]] and [[recipe#h]]';
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, '[[food/recipe]] and [[food/recipe|alias]] and [[food/recipe#h]]');
  });

  it('does not rewrite links to other notes with similar names', () => {
    const content = '[[recipe-book]] and [[my-recipe]] and [[recipe]]';
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, '[[recipe-book]] and [[my-recipe]] and [[food/recipe]]');
  });

  it('does not rewrite heading-only links (same-file anchors)', () => {
    const content = 'See [[#section]] here.';
    const result = rewriteLinks(content, 'section', 'other/section');
    assert.equal(result, 'See [[#section]] here.');
  });

  it('handles note with spaces in name', () => {
    const content = 'See [[my note]] here.';
    const result = rewriteLinks(content, 'my note', 'folder/my note');
    assert.equal(result, 'See [[folder/my note]] here.');
  });

  it('returns content unchanged when no matching links', () => {
    const content = 'See [[other-note]] here.';
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, content);
  });

  it('handles note rename (same folder, different name)', () => {
    const content = '[[pasta]] and [[pasta|Pasta Dish]]';
    const result = rewriteLinks(content, 'pasta', 'spaghetti');
    assert.equal(result, '[[spaghetti]] and [[spaghetti|Pasta Dish]]');
  });
});
