import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlackboardStore } from '@maf/blackboard';
import { DagRunner, DagParser } from '@maf/dag-runner';
import { MemoryGraph } from '@maf/memory-graph';
import { RetrievalAugmentedPlanner } from '@maf/planning-agent';
import type { RoleName } from '@maf/types';
import { NodeFailure, err, makeRunId, ok } from '@maf/types';

// ORACLE (D-16), end to end: the scheduler writes a failed node into a real graph through the
// recorder seam, and the next plan for a similar task finds it. The pieces are tested on their own
// in dag-runner, memory-graph and planning-agent; this is the one place they are composed the way
// `maf run` composes them (`failureRecorder: graph`), which is the call WP-2.10 wires in.

const ROLES = {
  defaultRole: 'coder' as RoleName,
  resolveRole: (raw: string) => raw === 'coder' ? ok(raw as RoleName) : err({ requested: raw, known: ['coder' as RoleName] }),
};

/** One database for the whole file, opened once: Kùzu 0.7.1 does not survive many per process. */
let graph: MemoryGraph;
let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'maf-cli-recall-'));
  graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
});

after(async () => {
  graph.close();
  await rm(dir, { recursive: true, force: true });
});

function planner(planText: string, seen: { systemPrompt: string }): RetrievalAugmentedPlanner {
  return new RetrievalAugmentedPlanner({
    graph,
    lcm: { lcm_grep: async () => [] } as never,
    injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as never,
    roles: ROLES,
    generatePlan: async (sys) => { seen.systemPrompt = sys; return planText; },
  });
}

test('a step of a planned run that fails is recalled when the same title is planned again', async () => {
  // F1, the verifier's scenario: the planner's own JSON plan, whose node instruction shares no
  // words with the run title, run by the scheduler into the graph, then the same title re-planned.
  const title = 'Add rate limiting to the login endpoint';
  const plan = '```json\n' + JSON.stringify({
    nodes: [{ id: 'n1', label: 'token bucket', description: 'Implement a token bucket in src/auth/login.ts', agentRole: 'coder' }],
  }) + '\n```';
  const firstRun = makeRunId('run-planned-first');
  const first = { systemPrompt: '' };
  const dag = await planner(plan, first).plan({ title, description: title, runId: firstRun, sessionId: 's' });
  assert.doesNotMatch(first.systemPrompt, /<past-failures>/, 'nothing has failed yet');
  for (const node of dag.nodes.values()) node.retryPolicy = { ...node.retryPolicy, maxAttempts: 1 };

  const outcome = await new DagRunner().run({
    dag,
    board: new BlackboardStore(),
    failureRecorder: graph,
    executor: async () => { throw new NodeFailure('adapter_failed', 'claude exited 1: not logged in', 1); },
  });
  assert.equal(outcome.status, 'Failed');

  const second = { systemPrompt: '' };
  await planner(plan, second).plan({ title, description: title, runId: makeRunId('run-planned-second'), sessionId: 's' });

  assert.match(second.systemPrompt,
    /<past-failures>[\s\S]*Task "Implement a token bucket in src\/auth\/login\.ts" \(coder\) → adapter_failed: claude exited 1: not logged in/);
});

test('a node that fails in one run is in the next plan\'s past-failures', async () => {
  const firstRun = makeRunId('run-first');
  const dag = DagParser.fromSpec(
    { id: 'x', nodes: [{ id: 'impl', label: 'implement', retry: { maxAttempts: 1 } }] },
    firstRun,
    ROLES,
  );
  dag.nodes.values().next().value!.metadata['taskDescription'] = 'Upgrade the ORM to version 7';

  const outcome = await new DagRunner().run({
    dag,
    board: new BlackboardStore(),
    failureRecorder: graph,
    executor: async () => { throw new NodeFailure('adapter_failed', 'claude exited 1: rate limited', 1); },
  });
  assert.equal(outcome.status, 'Failed');

  const rows = await graph.run({
    cypher: `MATCH (t:MemoryNode {kind: 'Task', run_id: $runId})-[e:MemoryEdge {relation: 'CAUSED_FAILURE'}]->(f:MemoryNode {kind: 'Failure'})
             RETURN t.label AS task, f.properties AS failure`,
    params: { runId: firstRun },
  });
  assert.equal(rows.length, 1, 'the failed node is one Task joined to one Failure');
  assert.equal(rows[0]?.['task'], 'Upgrade the ORM to version 7');
  assert.deepEqual(JSON.parse(String(rows[0]?.['failure'])), {
    nodeId: 'impl', role: 'coder', reason: 'adapter_failed', message: 'claude exited 1: rate limited', exitCode: 1,
  });

  const seen = { systemPrompt: '' };
  await planner('no plan', seen)
    .plan({ title: 'upgrade the orm again', description: 'd', runId: makeRunId('run-second'), sessionId: 's' });

  assert.match(seen.systemPrompt, /<past-failures>[\s\S]*Task "Upgrade the ORM to version 7" \(coder\) → adapter_failed: claude exited 1: rate limited/);
});
