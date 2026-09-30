import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardStore } from '@maf/blackboard';
import type { BlackboardValue, DagNode, NodeId } from '@maf/types';
import { makeBlackboardKey, makeRunId } from '@maf/types';
import { DagRunner, DagParser } from '../index.js';

// ORACLE (implementation checklist A0): a 2-node DAG whose executor takes 20 ms
// must run to completion, in dependency order.

const RUN_ID = makeRunId('run-a0');

function twoNodeDag() {
  return DagParser.fromSpec(
    {
      id: 'a0-two-node',
      nodes: [
        { id: 'plan', label: 'plan', agentRole: 'planner', outputs: { out: 'plan.out' } },
        {
          id: 'implement',
          label: 'implement',
          agentRole: 'coder',
          dependencies: ['plan'],
          inputs: { in: 'plan.out' },
          outputs: { out: 'impl.out' },
        },
      ],
      config: { maxConcurrent: 4 },
    },
    RUN_ID,
    'coder',
  );
}

// 20 ms of real time, i.e. a macrotask. A scheduler that spins on microtasks
// never lets this fire.
async function slowExecutor(node: DagNode): Promise<Record<string, BlackboardValue>> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { out: { kind: 'string', value: `done:${node.id}` } };
}

test('a 2-node DAG with a 20 ms executor runs to completion', async () => {
  const dag = twoNodeDag();
  const board = new BlackboardStore();
  const started: NodeId[] = [];

  const runner = new DagRunner();
  await runner.run({ dag, board, executor: slowExecutor, onNodeStart: (id) => started.push(id) });

  assert.deepEqual(started, ['plan', 'implement']);
  for (const id of dag.nodes.keys()) {
    assert.equal(board.getDagState(id), 'Succeeded', `node ${id} should have succeeded`);
  }
  assert.deepEqual(board.getValue(makeBlackboardKey('impl.out')), {
    kind: 'string',
    value: 'done:implement',
  });
});
