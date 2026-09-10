import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PolicyRule } from '@maf/types';
import { PolicyLoader } from '../PolicyLoader.js';

async function withTempFile(content: string, fn: (p: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-policy-'));
  const file = path.join(dir, 'policy.yaml');
  await writeFile(file, content, 'utf8');
  try { await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('load() returns [] for a missing file', async () => {
  const rules = await PolicyLoader.load('/nonexistent/definitely/policy.yaml');
  assert.deepEqual(rules, []);
});

test('load() parses JSON-formatted policy files', async () => {
  const doc = JSON.stringify({
    rules: [{
      id: 'r1', description: 'd', priority: 10,
      predicate: { toolId: 'fs.write' },
      action: { kind: 'Deny', reason: 'no' },
    }],
  });
  await withTempFile(doc, async (file) => {
    const rules = await PolicyLoader.load(file);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.id, 'r1');
    assert.equal(rules[0]?.action.kind, 'Deny');
  });
});

test('load() strips full-line # comments before JSON parse', async () => {
  const doc = [
    '# maf policy file',
    '  # another comment',
    JSON.stringify({ rules: [{ id: 'c1', description: '', priority: 1, predicate: {}, action: { kind: 'Allow' } }] }),
  ].join('\n');
  await withTempFile(doc, async (file) => {
    const rules = await PolicyLoader.load(file);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.id, 'c1');
  });
});

test('load() returns [] for unparseable content rather than throwing', async () => {
  await withTempFile('this is: not json {{{', async (file) => {
    const rules = await PolicyLoader.load(file);
    assert.deepEqual(rules, []);
  });
});

test('load() returns [] when document has no rules key', async () => {
  await withTempFile(JSON.stringify({ other: true }), async (file) => {
    const rules = await PolicyLoader.load(file);
    assert.deepEqual(rules, []);
  });
});

test('validate() passes well-formed rules', () => {
  const rules: PolicyRule[] = [{
    id: 'ok', description: '', priority: 5,
    predicate: { toolId: 'fs.write' as never },
    action: { kind: 'Allow' },
  }];
  assert.deepEqual(PolicyLoader.validate(rules), []);
});

test('validate() reports missing id, action.kind, and predicate', () => {
  const bad = [
    { description: '', priority: 1, predicate: {}, action: { kind: 'Allow' } },      // no id
    { id: 'no-action', description: '', priority: 1, predicate: {}, action: {} },    // no action.kind
    { id: 'no-pred', description: '', priority: 1, action: { kind: 'Allow' } },      // no predicate
  ] as unknown as PolicyRule[];
  const errors = PolicyLoader.validate(bad);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => /missing id/i.test(e)));
  assert.ok(errors.some((e) => /no-action.*action\.kind/i.test(e)));
  assert.ok(errors.some((e) => /no-pred.*predicate/i.test(e)));
});
