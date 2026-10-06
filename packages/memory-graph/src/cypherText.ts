// The two things a Cypher query needs that cannot be a bound parameter.
//
// Everything else in this package is bound. These are the exceptions, they are named, they are
// validated, and they are the only reason any value is written into a query's text.

/**
 * A non-negative integer, as text, for a position that cannot take a parameter: `LIMIT` (Kùzu's
 * binder rejects `LIMIT $n`) and a variable-length path's hop count (no Cypher dialect binds it).
 *
 * It throws rather than coercing. A literal is the one place a value becomes query text, so a
 * value that is not a small non-negative integer must not reach it — coercing with `Number()`
 * would turn an attacker-supplied string into a statement, which is the defect this replaces.
 */
export function intLiteral(value: number, what: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative integer, got ${String(value)}`);
  }
  return String(value);
}

/**
 * A list of ids as bound parameters. `IN $ids` is rejected — a parameter may not be an array — so
 * one parameter is generated per element under a shared prefix, paired with the placeholders that
 * name them. The two are produced together, so a placeholder can never name a parameter that was
 * not supplied (Kùzu rejects a statement that declares a parameter it was not given).
 *
 * An empty list has no valid expansion; callers return before asking for one.
 */
export function idListParams(
  prefix: string,
  ids: readonly string[],
): { placeholders: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const placeholders = ids
    .map((id, i) => {
      const name = `${prefix}${i}`;
      params[name] = id;
      return `$${name}`;
    })
    .join(', ');
  return { placeholders, params };
}
