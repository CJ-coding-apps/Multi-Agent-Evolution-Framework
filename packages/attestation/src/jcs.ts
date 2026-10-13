// RFC 8785, the JSON Canonicalization Scheme: the bytes a signature covers, written so that a
// third party with any conforming JCS library reproduces them. Built as a string, never as a JS
// object, because a JS object lists array-index keys ("2", "10") first in numeric order
// whatever order they were inserted in, and an assigned "__proto__" key sets the prototype.

// §3.2.2.2: these seven have a two-character escape; the rest of U+0000–U+001F are \u00hh.
const SHORT_ESCAPE: Record<string, string> = {
  '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r',
};

// Without the `u` flag a regex sees UTF-16 code units, so a lone surrogate is one match.
// RFC 8785 admits only strings that are Unicode, which a lone surrogate is not; it is written as
// `JSON.stringify` writes it (\udxxx), so signing never fails on an agent's text and two different
// strings never sign alike.
const NEEDS_ESCAPE = /["\\\u0000-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function escapeUnit(unit: string): string {
  return SHORT_ESCAPE[unit] ?? `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

function serializeString(value: string): string {
  return `"${value.replace(NEEDS_ESCAPE, escapeUnit)}"`;
}

/**
 * `value` in RFC 8785 form: object keys sorted by UTF-16 code unit at every depth (§3.2.3),
 * numbers as ECMAScript's Number::toString writes them (§3.2.2.3; `-0` is `0`), strings escaped
 * per §3.2.2.2, no whitespace.
 *
 * Plain JSON only — what `JSON.parse` returns. A non-finite number, `undefined`, a function, a
 * bigint, a symbol or an object that is not a plain object or array (a `Date`) throws: RFC 8785
 * has no form for it, and guessing one would sign bytes no third party writes.
 */
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`RFC 8785 has no form for the number ${String(value)}; expected a finite number.`);
      }
      return String(value);
    case 'string':
      return serializeString(value);
    case 'object': {
      if (Array.isArray(value)) return `[${Array.from(value, (item: unknown) => jcs(item)).join(',')}]`;
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        const found = (value as { constructor?: { name?: unknown } }).constructor?.name;
        throw new Error(`RFC 8785 canonicalizes plain JSON; expected a plain object, found ${
          typeof found === 'string' ? `a ${found}` : 'an object with a prototype'}.`);
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record).sort().map((key) => `${serializeString(key)}:${jcs(record[key])}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new Error(`RFC 8785 canonicalizes plain JSON; expected a JSON value, found ${typeof value}.`);
  }
}
