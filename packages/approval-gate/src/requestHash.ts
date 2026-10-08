import crypto from 'node:crypto';
import type { ApprovalAsk } from '@maf/types';

/**
 * JSON with every object's keys sorted, so one request always has one spelling. Local rather than
 * `@maf/harness-config`'s `canonicalJson`: depending on that package is acyclic, but a new
 * workspace edge changes `pnpm-lock.yaml`, which this package may not. It is also stricter, on
 * purpose: `JSON.stringify` writes `undefined` in an array, `NaN` and `Infinity` as `null` and a
 * `Date` as a string, so two different inputs would share a hash — and a hash an approval is
 * bound to must not have two meanings. Anything that is not plain JSON is refused instead.
 */
export function canonicalJson(value: unknown): string {
  return write(value, '$');
}

function write(value: unknown, at: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return JSON.stringify(value);
    throw new TypeError(`Canonical JSON expected a finite number at ${at}, and found ${String(value)}.`);
  }
  // `Array.from` visits holes (as `undefined`, refused below), which `map` would skip.
  if (Array.isArray(value)) return `[${Array.from(value, (item, i) => write(item, `${at}[${i}]`)).join(',')}]`;
  if (typeof value === 'object' && isPlainObject(value)) {
    const entries = Object.keys(value).sort().map((key) => {
      // A getter could answer the hash one way and the tool another.
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError(`Canonical JSON expected a data property at ${at}.${key}, and found an accessor.`);
      }
      return `${JSON.stringify(key)}:${write(descriptor.value, `${at}.${key}`)}`;
    });
    return `{${entries.join(',')}}`;
  }
  const found = typeof value === 'object' ? `an instance of ${value.constructor?.name ?? 'an unknown class'}` : `a value of type ${typeof value}`;
  throw new TypeError(`Canonical JSON expected null, a boolean, a number, a string, an array or a plain object at ${at}, and found ${found}.`);
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The hash a decision is bound to (D-02): sha256 over the canonical JSON of what the call will do
 * — the tool, the exact input, the paths it declared — and the rule that asked. The request's id,
 * description and timestamps are not in it: they say which request this is, and the gate checks
 * the id separately.
 */
export function approvalRequestHash(ask: ApprovalAsk): string {
  if (!Array.isArray(ask.declaredPaths)) {
    throw new TypeError(`Declared paths must be a list of paths, and found ${typeof ask.declaredPaths}.`);
  }
  const subject = {
    toolId:        ask.toolId,
    input:         ask.input,
    declaredPaths: ask.declaredPaths,
    policyRuleId:  ask.request.policyRuleId,
  };
  return crypto.createHash('sha256').update(canonicalJson(subject), 'utf8').digest('hex');
}
