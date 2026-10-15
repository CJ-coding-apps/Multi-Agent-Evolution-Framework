import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardStore } from '@maf/blackboard';
import type { BlackboardValue, DagNode } from '@maf/types';
import { makeNodeId, makeRunId, NodeFailure } from '@maf/types';
import { DagRunner, DagParser, DagValidationError } from '../index.js';
import { testRoleResolver } from './roleResolver.js';

// ORACLE (implementation checklist A2): a DAG run must report
// Succeeded / Failed / Unschedulable, and malformed input must be refused
// before any node is dispatched.

const RUN_ID = makeRunId('run-outcome');
const ROLES = testRoleResolver(['planner', 'coder'], 'coder');

const ok = async (): Promise<Record<string, BlackboardValue>> => ({});
const boom = async (node: DagNode): Promise<Record<string, BlackboardValue>> => {
  throw new Error(`executor refused ${node.id}`);
};

type NodeSpec = Parameters<typeof DagParser.fromSpec>[0]['nodes'];

function dagOf(nodes: NodeSpec, maxConcurrent?: number) {
  return DagParser.fromSpec(
    { id: 'x', nodes, ...(maxConcurrent === undefined ? {} : { config: { maxConcurrent } }) },
    RUN_ID,
    ROLES,
  );
}

const CHAIN: NodeSpec = [
  { id: 'a', label: 'a' },
  { id: 'b', label: 'b', dependencies: ['a'] },
];

test('a fully successful run is Succeeded with nothing unscheduled', async () => {
  const outcome = await new DagRunner().run({
    dag: dagOf(CHAIN), board: new BlackboardStore(), executor: ok,
  });

  assert.equal(outcome.status, 'Succeeded');
  assert.deepEqual(outcome.unscheduled, []);
  assert.deepEqual(outcome.nodes?.map((n) => n.status), ['Succeeded', 'Succeeded']);
});

test('one failed node makes the run Failed and names the nodes that never ran', async () => {
  // maxAttempts 1: the retry policy is not what this test is about, and the default
  // backoff would add seconds of sleeping to every run of the suite.
  const dag = dagOf([
    { id: 'a', label: 'a', retry: { maxAttempts: 1 } },
    { id: 'b', label: 'b', dependencies: ['a'] },
  ]);

  const outcome = await new DagRunner().run({
    dag, board: new BlackboardStore(), executor: boom,
  });

  assert.equal(outcome.status, 'Failed');
  assert.deepEqual(outcome.unscheduled, ['b'], 'the dependent of a failed node can never run');
  assert.equal(outcome.nodes?.find((n) => n.nodeId === makeNodeId('a'))?.error, 'executor refused a');
});

test('a cyclic DAG runs nothing and reports Unschedulable, naming the nodes', async () => {
  const dag = dagOf([
    { id: 'a', label: 'a', dependencies: ['b'] },
    { id: 'b', label: 'b', dependencies: ['a'] },
  ]);

  let dispatched = 0;
  const outcome = await new DagRunner().run({
    dag,
    board: new BlackboardStore(),
    executor: async () => { dispatched++; return {}; },
  });

  assert.equal(dispatched, 0, 'a cycle can never make a node ready');
  assert.equal(outcome.status, 'Unschedulable');
  assert.deepEqual(outcome.unscheduled, ['a', 'b']);
});

test('malformed DAGs are refused before any node is dispatched', async () => {
  const refusals: Array<[NodeSpec, number | undefined, RegExp]> = [
    [[], undefined, /no nodes/],
    [[{ id: 'a', label: 'a', dependencies: ['ghost'] }], undefined, /unknown node "ghost"/],
    [CHAIN, 0, /maxConcurrent must be a positive safe integer \(1 or more\), got 0\./],
  ];

  for (const [nodes, maxConcurrent, expected] of refusals) {
    let dispatched = 0;
    await assert.rejects(
      () => new DagRunner().run({
        dag: dagOf(nodes, maxConcurrent),
        board: new BlackboardStore(),
        executor: async () => { dispatched++; return {}; },
      }),
      (err: unknown) => err instanceof DagValidationError && expected.test((err as Error).message),
    );
    assert.equal(dispatched, 0, `no node may run for ${expected}`);
  }
});

test('DagParser refuses a duplicate node id instead of keeping the last one', () => {
  assert.throws(
    () => dagOf([{ id: 'a', label: 'first' }, { id: 'a', label: 'second' }]),
    /duplicate node id "a"/,
  );
});

// ── L3: a failed node's *kind* is a field, not a phrase to be grepped out of the prose ────────
// The run outcome carried a node failure as `status: "Failed"` plus prose, so a machine check of the
// reason had to grep the message. The kind the dispatcher already decided is surfaced beside it.

/** A one-node DAG whose only node fails by throwing `err`. maxAttempts 1: the throw is not retried. */
async function outcomeOfThrown(err: unknown) {
  return new DagRunner().run({
    dag: dagOf([{ id: 'a', label: 'a', retry: { maxAttempts: 1 } }]),
    board: new BlackboardStore(),
    executor: async () => { throw err; },
  });
}

test('a failed node carries its failure kind, and the rule and tool that refused it (L3)', async () => {
  const outcome = await outcomeOfThrown(
    new NodeFailure('no_change', 'role "coder" changed nothing', undefined,
      { ruleId: 'deny-env-files', toolId: 'patch.apply' }),
  );

  assert.equal(outcome.status, 'Failed');
  assert.deepEqual(outcome.nodes?.[0]?.failure, {
    kind: 'no_change', ruleId: 'deny-env-files', toolId: 'patch.apply',
  });
});

test('a no_work failure carries its kind and nothing else: no rule, no tool (L3)', async () => {
  const outcome = await outcomeOfThrown(new NodeFailure('no_work', 'role "analyst" made no tool call'));

  assert.deepEqual(outcome.nodes?.[0]?.failure, { kind: 'no_work' });
});

test('a node that failed with a plain Error carries no failure kind: there was no verdict (L3)', async () => {
  const outcome = await outcomeOfThrown(new Error('boom'));

  assert.equal(outcome.status, 'Failed');
  assert.equal(outcome.nodes?.[0]?.error, 'boom', 'the prose is still there');
  assert.equal(outcome.nodes?.[0]?.failure, undefined, 'and no kind was invented for it');
});
