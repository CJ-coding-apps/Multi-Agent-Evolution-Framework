import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPTED_ADAPTER_NAME } from '@maf/eval-harness';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';

// ORACLE: WP-2.7 integration — `maf run --adapter scripted` resolves through the same registry as
// every other adapter. Without a script it answers the security gate and refuses every task: an
// unscripted prompt is an error, never an empty answer that would read as a success.

test('the registry offers the scripted adapter, which reviews diffs and refuses unscripted tasks', async () => {
  const adapter = await resolveAdapter(SCRIPTED_ADAPTER_NAME, createAdapterRegistry());
  assert.equal(adapter.name, SCRIPTED_ADAPTER_NAME);
  assert.equal(adapter.capabilities().inProcessLoop, true, 'it can drive the in-process loop');

  const review = await adapter.invoke({ prompt: 'Audit this diff for security issues.\n+x', workingDir: '/nonexistent', timeoutMs: 1_000 });
  assert.equal(review.success, true);
  assert.match(review.output, /"passed":true/);

  const task = await adapter.invoke({ prompt: 'fix the bug', workingDir: '/nonexistent', timeoutMs: 1_000 });
  assert.equal(task.success, false, 'a task with no script fails');
  assert.match(task.output, /no script answers the task/);
});
