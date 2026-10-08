import { test } from 'node:test';
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

test('a node that fails in one run is in the next plan\'s past-failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-cli-recall-'));
  // One database, opened once: Kùzu 0.7.1 does not survive many per process.
  const graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
  try {
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

    let systemPrompt = '';
    await new RetrievalAugmentedPlanner({
      graph,
      lcm: { lcm_grep: async () => [] } as never,
      injector: { assemble: async () => ({ systemPromptPrefix: '' }) } as never,
      roles: ROLES,
      generatePlan: async (sys) => { systemPrompt = sys; return 'no plan'; },
    }).plan({ title: 'upgrade the orm again', description: 'd', runId: makeRunId('run-second'), sessionId: 's' });

    assert.match(systemPrompt, /<past-failures>[\s\S]*Task "Upgrade the ORM to version 7" \(coder\) → adapter_failed: claude exited 1: rate limited/);
  } finally {
    graph.close();
    await rm(dir, { recursive: true, force: true });
  }
});
