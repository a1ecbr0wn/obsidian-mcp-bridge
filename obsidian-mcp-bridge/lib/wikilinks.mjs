// Pure functions for Obsidian wikilink parsing and rewriting.
// All functions take and return strings; no filesystem I/O.

import path from 'node:path';
import { escRe } from './utils.mjs';

/**
 * Parses all wikilinks in content and returns their components.
 * Handles format: [[target#heading|alias]] (heading and alias optional).
 * @returns {Array<{target: string, heading: string, alias: string}>} Parsed wikilinks.
 */
export function extractLinks(content) {
  const re = /\[\[([^\]#|]+?)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g;
  const links = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    links.push({
      target: m[1].trim(),
      heading: m[2] ?? '',
      alias: m[3] ?? '',
    });
  }
  return links;
}

/**
 * Rewrites wikilinks pointing to oldPath to point to newPath instead (vault-relative, no .md).
 * Preserves heading anchors and aliases.
 *
 * Matches both exact vault-relative path and bare basename (e.g., "recipe" from "food/recipe").
 * Does not match partial names or headings-only links ([[#heading]]).
 */
export function rewriteLinks(content, oldPath, newPath) {
  const oldBasename = path.posix.basename(oldPath);
  const escapedPath = escRe(oldPath);
  const escapedBase = escRe(oldBasename);

  // Alternate on full path first (more specific), then basename
  const targetPattern =
    escapedPath === escapedBase
      ? escapedPath
      : `(?:${escapedPath}|${escapedBase})`;

  // Pattern: [[target#heading|alias]] where #heading and |alias are optional
  // The target must be followed by #, |, or ]] — not by other path chars
  const re = new RegExp(
    `\\[\\[(${targetPattern})(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`,
    'g',
  );

  return content.replace(re, (_match, _target, heading, alias) => {
    return `[[${newPath}${heading ?? ''}${alias ?? ''}]]`;
  });
}
