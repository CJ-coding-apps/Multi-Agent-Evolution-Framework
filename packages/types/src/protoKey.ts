// ─────────────────────────────────────────────────────────────────────────────
// PROTOTYPE KEYS IN PARSED JSON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The key names that reach a prototype when a parsed object is copied with a plain assignment.
 * `parseYamlDocument` refuses them for every YAML configuration file (WP-3.9 F10); this module is
 * the JSON half of the same rule, shared (WP-3.9 G5) so that a file reader added later cannot
 * quietly be the one that does not check.
 */
export const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A parsed document that named one of `PROTOTYPE_KEYS`, at any depth. */
export class PrototypeKeyError extends Error {
  constructor(readonly key: string) {
    super(
      `the JSON key ${JSON.stringify(key)} names a prototype (__proto__, constructor, prototype); ` +
      'a configuration or record file may not name one at any depth',
    );
    this.name = 'PrototypeKeyError';
  }
}

/**
 * A `JSON.parse` reviver: a key that names a prototype fails the parse, wherever it sits. Given as
 * the second argument it sees every key at every depth before the object is returned, so nothing
 * downstream ever holds a document with an own `__proto__` — which is the difference between a
 * refused file and a poisoned one.
 */
export function refusePrototypeKey(key: string, value: unknown): unknown {
  if (PROTOTYPE_KEYS.has(key)) throw new PrototypeKeyError(key);
  return value;
}
