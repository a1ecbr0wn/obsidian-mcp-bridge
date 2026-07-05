// Pure functions for Obsidian YAML frontmatter parsing and tag manipulation.
// All functions take and return content strings; no filesystem I/O.

import { escRe } from './utils.mjs';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const TAGS_INLINE_RE = /^tags:\s*\[([^\]]*)\]/m;
const TAGS_BLOCK_RE = /^tags:\s*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)*)/m;

function parseTagsFromBody(body) {
  const inline = TAGS_INLINE_RE.exec(body);
  if (inline) {
    return inline[1]
      .split(',')
      .map(t => t.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const block = TAGS_BLOCK_RE.exec(body);
  if (block) {
    return block[1]
      .split('\n')
      .map(l => l.replace(/^[ \t]+-\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Extracts tag list from YAML frontmatter (inline or block format).
 * @returns {string[]} Tag names, or empty array if no frontmatter or tags found.
 */
export function parseTags(content) {
  const fm = FM_RE.exec(content);
  return fm ? parseTagsFromBody(fm[1]) : [];
}

function buildTagsSection(tags) {
  if (tags.length === 0) return 'tags: []';
  return `tags:\n${tags.map(t => `  - ${t}`).join('\n')}`;
}

function replaceTagsInBody(body, tags) {
  const newSection = buildTagsSection(tags);
  if (TAGS_INLINE_RE.test(body)) {
    return body.replace(TAGS_INLINE_RE, newSection);
  }
  if (TAGS_BLOCK_RE.test(body)) {
    // Block regex captures trailing newlines in each entry; replace whole block + trailing newline
    return body.replace(TAGS_BLOCK_RE, newSection + '\n');
  }
  return body.trimEnd() + '\n' + newSection;
}

/**
 * Replaces the tags section in frontmatter, creating frontmatter if missing.
 */
export function setTags(content, tags) {
  const fm = FM_RE.exec(content);
  if (!fm) {
    return `---\n${buildTagsSection(tags)}\n---\n${content}`;
  }
  const newBody = replaceTagsInBody(fm[1], tags);
  const after = content.slice(fm.index + fm[0].length);
  return `---\n${newBody.trimEnd()}\n---${fm[2]}${after}`;
}

/**
 * Adds tags to frontmatter, skipping duplicates. Returns content unchanged if all tags already exist.
 */
export function addTags(content, tagsToAdd) {
  const existing = parseTags(content);
  const existingSet = new Set(existing);
  const toAdd = tagsToAdd.filter(t => !existingSet.has(t));
  if (!toAdd.length) return content;
  return setTags(content, [...existing, ...toAdd]);
}

/**
 * Removes tags from frontmatter. Returns content unchanged if no tags were removed.
 */
export function removeTags(content, tagsToRemove) {
  const existing = parseTags(content);
  const removeSet = new Set(tagsToRemove);
  const remaining = existing.filter(t => !removeSet.has(t));
  if (remaining.length === existing.length) return content;
  return setTags(content, remaining);
}

/**
 * Renames a tag in frontmatter only. Returns content unchanged if tag not found.
 */
export function renameFrontmatterTag(content, oldTag, newTag) {
  const tags = parseTags(content);
  if (!tags.includes(oldTag)) return content;
  return setTags(content, tags.map(t => (t === oldTag ? newTag : t)));
}

/**
 * Renames inline tags (e.g., #tag syntax) in content, respecting word boundaries.
 * Matches tags preceded by whitespace or start-of-line, not followed by tag-valid characters.
 */
export function renameInlineTag(content, oldTag, newTag) {
  // Match #tag preceded by whitespace or start-of-line, not followed by tag-valid chars
  // Tag-valid chars in Obsidian: [a-zA-Z0-9_/-]
  const re = new RegExp(`(^|[ \\t])#${escRe(oldTag)}(?![a-zA-Z0-9_/\\-])`, 'gm');
  return content.replace(re, (_, prefix) => `${prefix}#${newTag}`);
}

/**
 * Renames a tag everywhere: in frontmatter and inline (#tag syntax).
 */
export function renameTag(content, oldTag, newTag) {
  let result = renameFrontmatterTag(content, oldTag, newTag);
  result = renameInlineTag(result, oldTag, newTag);
  return result;
}
