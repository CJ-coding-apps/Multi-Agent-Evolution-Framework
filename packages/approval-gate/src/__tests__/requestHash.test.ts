import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { ApprovalAsk } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { approvalRequestHash, canonicalJson } from '../requestHash.js';

// ORACLE: D-02 — a decision is bound to sha256 over the canonical JSON of tool id + input +
// declared paths + policy rule id; one request has one hash, and two requests never share one.

const ask = (over: Partial<ApprovalAsk> = {}, ruleId = 'protect-lock-files', id = 'req-1'): ApprovalAsk => ({
  request: {
    id, runId: makeRunId('r1'), taskId: makeTaskId('t1'), requestedBy: makeAgentId('a1'),
    toolId: makeToolId('fs.write'), policyRuleId: ruleId, description: 'needs a human', createdAt: new Date(),
  },
  toolId: makeToolId('fs.write'),
  input: { path: 'yarn.lock', content: 'x' },
  declaredPaths: ['yarn.lock'],
  ...over,
});

test('canonical JSON sorts keys at every depth and keeps array order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 1], c: null } }), '{"a":{"c":null,"d":[3,1]},"b":1}');
  assert.equal(canonicalJson({ a: { c: null, d: [3, 1] }, b: 1 }), canonicalJson({ b: 1, a: { d: [3, 1], c: null } }));
  assert.notEqual(canonicalJson([1, 3]), canonicalJson([3, 1]));
});

test('canonical JSON refuses what JSON.stringify would silently collapse into another value', () => {
  const sparse: unknown[] = [];
  sparse[1] = 'x';
  const accessor = Object.defineProperty({}, 'path', { get: () => 'a.lock', enumerable: true });
  for (const [label, value] of [
    ['undefined in an object', { a: undefined }],
    ['undefined in an array', [undefined]],
    ['an array hole', sparse],
    ['NaN', { n: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['a Date', { at: new Date(0) }],
    ['a bigint', { n: 1n }],
    ['a function', { f: () => 1 }],
    ['a Map', { m: new Map() }],
    ['a getter', accessor],
  ] as const) {
    assert.throws(() => canonicalJson(value), TypeError, label);
  }
});

test('the request hash is sha256 of the canonical tool id, input, declared paths and rule id', () => {
  const expected = crypto.createHash('sha256')
    .update('{"declaredPaths":["yarn.lock"],"input":{"content":"x","path":"yarn.lock"},"policyRuleId":"protect-lock-files","toolId":"fs.write"}')
    .digest('hex');
  assert.equal(approvalRequestHash(ask()), expected);
});

test('changing any bound field changes the hash; the id, description and timestamps do not', () => {
  const base = approvalRequestHash(ask());
  assert.notEqual(approvalRequestHash(ask({ toolId: makeToolId('patch.apply') })), base, 'tool id');
  assert.notEqual(approvalRequestHash(ask({ input: { path: 'yarn.lock', content: 'y' } })), base, 'input');
  assert.notEqual(approvalRequestHash(ask({ declaredPaths: ['other.lock'] })), base, 'declared paths');
  assert.notEqual(approvalRequestHash(ask({}, 'protect-migrations')), base, 'policy rule id');

  const relabelled = ask({}, 'protect-lock-files', 'req-2');
  relabelled.request.description = 'different prose';
  relabelled.request.createdAt = new Date(0);
  assert.equal(approvalRequestHash(relabelled), base, 'which request this is does not change what it asks');
  assert.equal(approvalRequestHash(ask({ input: { content: 'x', path: 'yarn.lock' } })), base, 'key order is not content');
});
