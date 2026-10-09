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
 * Keys sorted at every depth, no whitespace, strings and numbers as `JSON.stringify` writes them.
 * Not RFC 8785: the sorted keys are rebuilt into a JS object, which lists array-index keys
 * (canonical integers 0 to 2³²−2) first in numeric order and the rest by UTF-16 code unit —
 * `{"10":1,"2":2,"!":3}` comes out
 * `{"2":2,"10":1,"!":3}`, where RFC 8785 writes `{"!":3,"10":1,"2":2}` — and drops a `"__proto__"`
 * key. The attestation signs with RFC 8785 (`@maf/attestation`'s `jcs.ts`), not with this.
 *
 * Plain JSON only: an object's own enumerable keys are what is sorted, so a `Date` (which has
 * none) becomes `{}`. A caller holding live objects round-trips through `JSON.parse(JSON.stringify(…))`
 * first. Left that way because the harness sha is computed with it, and changing what it
 * writes for any input would change every stored harness's id.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
