import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessRoleSet } from '../index.js';
import { HarnessStore, HarnessConfigError, assertHarnessConfig, mintHarnessConfig } from '../index.js';

// ORACLE: WP-2.3 — `reviewGate: { required: boolean }` is part of the harness: validated as
// exactly a boolean, hashed with the rest, and kept through the store.

const ROLE_SET: HarnessRoleSet = {
  version: 1,
  defaultRole: 'coder',
  roles: [{ role: 'coder', systemPrompt: 'be a coder', allowedTools: ['fs.read', 'fs.write'] }],
};

test('reviewGate is hashed: requiring review is a different harness from not saying', () => {
  const plain    = mintHarnessConfig({ id: 'x', roleSet: ROLE_SET, processorBundles: [] });
  const required = mintHarnessConfig({ id: 'x', roleSet: ROLE_SET, processorBundles: [], reviewGate: { required: true } });
  const advisory = mintHarnessConfig({ id: 'x', roleSet: ROLE_SET, processorBundles: [], reviewGate: { required: false } });
  assert.notEqual(required.sha, plain.sha);
  assert.notEqual(required.sha, advisory.sha);
  assert.doesNotThrow(() => assertHarnessConfig(required));
  assert.doesNotThrow(() => assertHarnessConfig(advisory));
});

test('reviewGate.required must be exactly a boolean', () => {
  const base = mintHarnessConfig({ id: 'x', roleSet: ROLE_SET, processorBundles: [] });
  // The string "false" is truthy: read loosely, it would require the review it meant to waive.
  for (const reviewGate of [{ required: 'false' }, { required: 1 }, {}, null, true, 'required']) {
    assert.throws(
      () => assertHarnessConfig({ ...base, reviewGate }),
      (err: unknown) => err instanceof HarnessConfigError && /reviewGate must be \{ required: true \| false \}/.test(err.message),
      `reviewGate ${JSON.stringify(reviewGate)} must be refused`,
    );
  }
});

test('the store keeps reviewGate through save and load', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-harness-review-'));
  try {
    const store = new HarnessStore(dir);
    const config = mintHarnessConfig({ id: 'reviewed', roleSet: ROLE_SET, processorBundles: [], reviewGate: { required: true } });
    await store.save(config);
    const loaded = await store.load('reviewed');
    assert.deepEqual(loaded.reviewGate, { required: true });
    assert.equal(loaded.sha, config.sha);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
