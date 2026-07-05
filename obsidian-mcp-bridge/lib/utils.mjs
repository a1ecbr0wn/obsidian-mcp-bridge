// Shared utilities for lib modules.

/**
 * Escapes regex metacharacters in a string.
 */
export function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
