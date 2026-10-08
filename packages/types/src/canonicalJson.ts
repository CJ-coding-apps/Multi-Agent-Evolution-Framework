// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL JSON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic serialization: recursively sort object keys, keep array order.
 * Two values differing only in key insertion order must produce the same string.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Keys sorted by UTF-16 code unit at every depth, no whitespace, strings and numbers as
 * `JSON.stringify` writes them — RFC 8785's form for a value that is already plain JSON.
 *
 * Plain JSON only: an object's own enumerable keys are what is sorted, so a `Date` (which has
 * none) becomes `{}`. A caller holding live objects round-trips through `JSON.parse(JSON.stringify(…))`
 * first. Left that way because the harness sha is computed with it, and changing what it
 * writes for any input would change every stored harness's id.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
