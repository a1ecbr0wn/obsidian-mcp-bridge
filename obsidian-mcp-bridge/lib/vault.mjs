// Filesystem operations for vault notes.
// Callers are responsible for path validation and access control.

import fs from 'node:fs/promises';
import path from 'node:path';
import { rewriteLinks } from './wikilinks.mjs';
import { isDenied } from './access.mjs';

/**
 * Recursively walks vault directories, calling callback for each markdown file.
 * Skips directories and files starting with '.' (e.g., .trash, .obsidian, .git).
 * @param {string} dir - Directory to walk
 * @param {Function} cb - Async callback receiving absolute path of each .md file
 */
export async function walkVault(dir, cb) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip .trash, .obsidian, .git, etc.
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkVault(full, cb);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      await cb(full);
    }
  }
}

/**
 * Reads note content from disk.
 */
export async function readNote(absPath) {
  return fs.readFile(absPath, 'utf8');
}

/**
 * Writes note content to disk, creating parent directories as needed.
 */
export async function writeNote(absPath, content) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf8');
}

/**
 * Deletes a note permanently or moves to .trash. On filename collision, appends timestamp suffix.
 * @param {string} absPath - Absolute path to note
 * @param {boolean} permanent - If true, permanently delete; if false, move to .trash
 * @param {string} vaultPath - Absolute path to vault root
 */
export async function deleteNote(absPath, permanent, vaultPath) {
  if (permanent) {
    await fs.unlink(absPath);
  } else {
    const trashDir = path.join(vaultPath, '.trash');
    await fs.mkdir(trashDir, { recursive: true });
    const baseName = path.basename(absPath, '.md');
    let dest = path.join(trashDir, path.basename(absPath));
    try {
      await fs.access(dest);
      // Collision — suffix with timestamp to avoid silent overwrite
      dest = path.join(trashDir, `${baseName}_${Date.now()}.md`);
    } catch {
      // ENOENT: destination free, use it
    }
    await fs.rename(absPath, dest);
  }
}

/**
 * Moves note from srcAbs to dstAbs, then rewrites all vault-wide wikilinks to the old path.
 * Throws if destination already exists. Updates are best-effort; fails silently for inaccessible notes.
 * @param {string} vaultPath - Absolute path to vault root
 * @param {string} srcAbs - Absolute path to source note
 * @param {string} dstAbs - Absolute path to destination note
 * @param {string[]} denyPaths - Vault-relative paths to exclude from rewriting
 */
export async function moveNote(vaultPath, srcAbs, dstAbs, denyPaths) {
  // Guard against silently clobbering an existing note
  try {
    await fs.access(dstAbs);
    throw new Error(`Destination already exists: ${path.relative(vaultPath, dstAbs)}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.mkdir(path.dirname(dstAbs), { recursive: true });

  const oldRel = path.relative(vaultPath, srcAbs).replace(/\.md$/, '');
  const newRel = path.relative(vaultPath, dstAbs).replace(/\.md$/, '');

  await fs.rename(srcAbs, dstAbs);

  // Rewrite links in every other vault note
  await walkVault(vaultPath, async filePath => {
    if (filePath === dstAbs) return;
    const rel = path.relative(vaultPath, filePath);
    if (isDenied(denyPaths, rel)) return;
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return;
    }
    const updated = rewriteLinks(content, oldRel, newRel);
    if (updated !== content) {
      try {
        await fs.writeFile(filePath, updated, 'utf8');
      } catch {
        return; // best-effort: log failure without aborting remaining rewrites
      }
    }
  });
}

/**
 * Searches note content for query (case-insensitive).
 * @returns {Promise<Array<{path: string, matches: Array<{line: number, text: string}>}>>} Results sorted by path.
 */
export async function searchContent(vaultPath, query, scopeDir, denyPaths) {
  const lower = query.toLowerCase();
  const results = [];

  await walkVault(scopeDir, async filePath => {
    const rel = path.relative(vaultPath, filePath);
    if (isDenied(denyPaths, rel)) return;
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return;
    }
    const matches = content
      .split('\n')
      .reduce((acc, text, i) => {
        if (text.toLowerCase().includes(lower)) acc.push({ line: i + 1, text });
        return acc;
      }, []);
    if (matches.length > 0) {
      results.push({ path: rel, matches });
    }
  });

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * Searches note filenames and vault-relative paths for query (case-insensitive).
 * @returns {Promise<string[]>} Vault-relative paths, sorted.
 */
export async function searchFilename(vaultPath, query, scopeDir, denyPaths) {
  const lower = query.toLowerCase();
  const results = [];

  await walkVault(scopeDir, async filePath => {
    const rel = path.relative(vaultPath, filePath);
    if (isDenied(denyPaths, rel)) return;
    if (rel.toLowerCase().includes(lower)) {
      results.push(rel);
    }
  });

  results.sort();
  return results;
}
