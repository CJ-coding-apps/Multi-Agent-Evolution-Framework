import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardStore } from '@maf/blackboard';
import type { BlackboardValue, DagNode } from '@maf/types';
import { makeNodeId, makeRunId } from '@maf/types';
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
    [CHAIN, 0, /maxConcurrent must be at least 1, got 0/],
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
