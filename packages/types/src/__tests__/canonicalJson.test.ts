import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../index.js';

// ORACLE: D-13 (part 2), D-36 — the canonicalizer the harness sha uses. These pin what it
// writes, RFC 8785 or not: changing it would change every stored harness's id.

test('canonicalJson sorts keys at every depth and keeps array order', () => {
  const a = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } };
  const b = { a: { c: 'x', d: [3, { y: 2, z: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]), 'array order is content');
});

test('canonicalJson orders keys by UTF-16 code unit, as RFC 8785 does', () => {
  // 'Z' (0x5A) < '_' (0x5F) < 'a' (0x61) < 'é' (0xE9) < '😀' (0xD83D…): no locale collation.
  assert.equal(canonicalJson({ '😀': 5, é: 4, a: 3, _: 2, Z: 1 }), '{"Z":1,"_":2,"a":3,"é":4,"😀":5}');
});

test('canonicalJson is not RFC 8785 for array-index keys or "__proto__", as its doc says', () => {
  assert.equal(canonicalJson({ '10': 1, '2': 2, '!': 3 }), '{"2":2,"10":1,"!":3}');
  assert.equal(canonicalJson(JSON.parse('{"__proto__":{"a":1},"b":2}')), '{"b":2}');
});
