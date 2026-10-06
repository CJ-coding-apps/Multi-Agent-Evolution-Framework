import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardStore } from '@maf/blackboard';
import type { BlackboardValue } from '@maf/types';
import { makeRunId } from '@maf/types';
import { DagRunner, DagParser } from '../index.js';
import { testRoleResolver } from './roleResolver.js';

// ORACLE (implementation checklist A3): nodes that write to the shared working tree
// are serialized — two independent writers must never overlap — and the deferral is
// recorded rather than silent.

const RUN_ID = makeRunId('writer-lock');
const ROLES = testRoleResolver(['coder'], 'coder');

// Two nodes with no dependency path between them: the shape a model actually emits.
const TWO_INDEPENDENT_NODES = [
  { id: 'w1', label: 'w1' },
  { id: 'w2', label: 'w2' },
];

function twoIndependentNodes() {
  return DagParser.fromSpec({ id: 'x', nodes: TWO_INDEPENDENT_NODES }, RUN_ID, ROLES);
}

/** Runs the DAG and reports the highest number of nodes ever executing at once. */
async function peakConcurrency(isWriter?: () => boolean) {
  let active = 0;
  let peak = 0;
  const executor = async (): Promise<Record<string, BlackboardValue>> => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return {};
  };

  const outcome = await new DagRunner().run({
    dag: twoIndependentNodes(),
    board: new BlackboardStore(),
    executor,
    ...(isWriter ? { isWriter } : {}),
  });

  return { peak, outcome };
}

test('two independent writers never overlap, and the deferral is recorded', async () => {
  const { peak, outcome } = await peakConcurrency();

  assert.equal(peak, 1, 'the second writer must wait for the first');
  assert.equal(outcome.status, 'Succeeded');
  assert.equal(outcome.deferredWriters?.length, 1, 'the held-back writer must be named');
});

test('the same DAG runs concurrently when no node is a writer', async () => {
  // Proves the lock is what serialized the run above, not the scheduler's shape.
  const { peak, outcome } = await peakConcurrency(() => false);

  assert.equal(peak, 2, 'non-writers are not serialized');
  assert.deepEqual(outcome.deferredWriters, []);
});
