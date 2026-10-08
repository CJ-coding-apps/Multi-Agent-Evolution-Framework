import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../index.js';

// ORACLE: D-13 (part 2) — the canonicalizer the harness sha uses is the one the attestation
// signs with, so it lives in the package both already depend on. These pin what it writes.

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
