import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NodeFailureRecord, RoleName } from '@maf/types';
import { makeNodeId, makeRunId } from '@maf/types';
import { MemoryGraph, recallFailures } from '../MemoryGraph.js';

// ORACLE (D-16; audit P1 "planner queries past failures"). The planner's recall asked for
// `-[:CAUSED_FAILURE]->`, a relationship table this schema never had, and nothing wrote a Task or
// a Failure for it to find — so recall answered every run with "no history", and the only test of
// it was a stub that answered `[]` to everything. These run the write and the read against a real
// database, because the defect was a disagreement between a query and the schema it ran on.

/** One database for the whole file: Kùzu 0.7.1 does not survive many per process (see graph-parameters.test.ts). */
let graph: MemoryGraph;
let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'maf-recall-'));
  graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
});

after(async () => {
  graph.close();
  await rm(dir, { recursive: true, force: true });
});

function record(over: Partial<NodeFailureRecord> & Pick<NodeFailureRecord, 'runId' | 'task'>): NodeFailureRecord {
  return {
    nodeId:  makeNodeId('n1'),
    label:   'implement',
    role:    'coder' as RoleName,
    reason:  'adapter_failed',
    message: 'claude exited 1: not logged in',
    ...over,
  };
}

test('a recorded failure is a Task and a Failure joined by a CAUSED_FAILURE MemoryEdge', async () => {
  const runId = makeRunId('run-record-shape');
  await graph.recordFailure(record({
    runId, task: 'Add rate limiting to the login endpoint', exitCode: 1,
  }));

  const rows = await graph.run({
    cypher: `MATCH (t:MemoryNode)-[e:MemoryEdge]->(f:MemoryNode)
             WHERE t.run_id = $runId
             RETURN t.kind AS tkind, t.label AS task, t.properties AS tprops, t.run_id AS trun,
                    e.relation AS relation,
                    f.kind AS fkind, f.properties AS fprops, f.run_id AS frun`,
    params: { runId },
  });

  assert.equal(rows.length, 1, 'exactly one edge leaves the Task');
  const row = rows[0]!;
  assert.equal(row['tkind'], 'Task');
  assert.equal(row['fkind'], 'Failure');
  assert.equal(row['relation'], 'CAUSED_FAILURE');
  assert.equal(row['task'], 'Add rate limiting to the login endpoint');
  assert.equal(row['trun'], runId);
  assert.equal(row['frun'], runId);
  assert.deepEqual(JSON.parse(String(row['tprops'])), { nodeId: 'n1', nodeLabel: 'implement', role: 'coder' });
  assert.deepEqual(JSON.parse(String(row['fprops'])), {
    nodeId: 'n1', role: 'coder', reason: 'adapter_failed', message: 'claude exited 1: not logged in', exitCode: 1,
  });
});

test('recall finds a recorded failure by the first words of a similar title, ignoring case', async () => {
  const runId = makeRunId('run-recall');
  await graph.recordFailure(record({
    runId, nodeId: makeNodeId('migrate'), task: 'Migrate the billing tables to Postgres 16',
    reason: 'GateRefused', message: 'the security gate refused the diff',
  }));

  const recalled = await recallFailures(graph, { title: 'migrate THE billing service too', limit: 5 });

  assert.equal(recalled.length, 1);
  assert.deepEqual({ ...recalled[0], recordedAt: undefined }, {
    task:       'Migrate the billing tables to Postgres 16',
    role:       'coder',
    reason:     'GateRefused',
    message:    'the security gate refused the diff',
    nodeId:     'migrate',
    runId,
    recordedAt: undefined,
  });
  assert.match(recalled[0]!.recordedAt, /^\d{4}-\d\d-\d\dT/);

  // The method on the graph is the same query.
  assert.deepEqual(await graph.recallFailures({ title: 'Migrate the billing', limit: 5 }), recalled);
  assert.deepEqual(await recallFailures(graph, { title: 'Migrate the payroll tables', limit: 5 }), [],
    'the phrase must match, not any one of its words');
});

test('recall finds a planned step by the title of the run it was planned for', async () => {
  // F1: a planned node's label is its own step ("Implement a token bucket…"), so matching the next
  // run's title against the label alone found nothing for any real JSON plan. The run's title is
  // kept in the Task's properties; the label stays the instruction.
  const runId = makeRunId('run-recall-title');
  await graph.recordFailure(record({
    runId, nodeId: makeNodeId('bucket'), task: 'Implement a token bucket in src/auth/login.ts',
    runTitle: 'Throttle the "login" endpoint (C:\\auth)',
  }));

  const [stored] = await graph.run({
    cypher: `MATCH (t:MemoryNode {kind: 'Task', run_id: $runId}) RETURN t.label AS label, t.properties AS props`,
    params: { runId },
  });
  assert.equal(stored?.['label'], 'Implement a token bucket in src/auth/login.ts', 'the label stays the instruction');
  assert.equal(JSON.parse(String(stored?.['props']))['runTitle'], 'Throttle the "login" endpoint (C:\\auth)');

  for (const title of ['Throttle the "login" endpoint (C:\\auth)', 'throttle THE "LOGIN" again', '"LOGIN" endpoint (c:\\auth)']) {
    assert.deepEqual((await recallFailures(graph, { title, limit: 5 })).map((f) => f.nodeId), ['bucket'],
      `the run title is matched, ignoring case, quotes and backslashes included: ${title}`);
  }
  assert.deepEqual(await recallFailures(graph, { title: 'Throttle the signup endpoint', limit: 5 }), []);
});

test('a Task joined to a Failure by any relation but CAUSED_FAILURE is not recalled', async () => {
  // F3: `RESOLVED_BY` is a declared relation that can join a Task to a Failure; only the
  // relation's value tells the two apart.
  const runId = makeRunId('run-resolved-by');
  const task = await graph.addNode({ kind: 'Task', label: 'Reindex the search shards', properties: {}, runId });
  const failure = await graph.addNode({ kind: 'Failure', label: 'n9', properties: { reason: 'adapter_failed' }, runId });
  await graph.addEdge({ fromId: task, toId: failure, relation: 'RESOLVED_BY', weight: 1, metadata: {} });

  assert.deepEqual(await recallFailures(graph, { title: 'Reindex the search shards', limit: 5 }), []);
});

test('recall returns the most recent failures first, up to the limit', async () => {
  const runId = makeRunId('run-recency');
  for (const n of [1, 2, 3]) {
    await graph.recordFailure(record({ runId, nodeId: makeNodeId(`r${n}`), task: `Rotate signing keys attempt ${n}` }));
    // created_at has millisecond resolution; keep the three apart.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const recalled = await recallFailures(graph, { title: 'rotate signing keys', limit: 2 });

  assert.deepEqual(recalled.map((f) => f.nodeId), ['r3', 'r2']);
});

test('recall by path finds failures whose task MODIFIED that file', async () => {
  const runId = makeRunId('run-recall-path');
  await graph.recordFailure(record({ runId, nodeId: makeNodeId('touch'), task: 'Refactor session storage' }));
  const [task] = await graph.run({
    cypher: `MATCH (t:MemoryNode {kind: 'Task', run_id: $runId}) RETURN t.id AS id`,
    params: { runId },
  });
  const file = await graph.addNode({ kind: 'File', label: 'src/session.ts', properties: {}, runId });
  await graph.addEdge({ fromId: String(task?.['id']), toId: file, relation: 'MODIFIED', weight: 1, metadata: {} });

  const recalled = await recallFailures(graph, { path: 'src/session.ts', limit: 5 });

  assert.deepEqual(recalled.map((f) => f.nodeId), ['touch']);
  assert.deepEqual(await recallFailures(graph, { path: 'src/other.ts', limit: 5 }), []);
});

test('a title with no words recalls nothing rather than every failure', async () => {
  assert.deepEqual(await recallFailures(graph, { title: '   ', limit: 5 }), []);
});

test('a crafted title is bound: it matches nothing and damages nothing', async () => {
  const runId = makeRunId('run-crafted-title');
  await graph.recordFailure(record({ runId, task: 'Harden the parser' }));

  const recalled = await recallFailures(graph, { title: `x'}) DETACH DELETE t //`, limit: 5 });

  assert.deepEqual(recalled, []);
  assert.equal((await recallFailures(graph, { title: 'Harden the parser', limit: 5 })).length, 1);
});

test('the query this replaces does not run against this schema at all', async () => {
  // Anti-vacuity for the shape fix: `CAUSED_FAILURE` is a value of `MemoryEdge.relation`, not a
  // table, and the binder says so. The planner caught this error and read it as "no history".
  await assert.rejects(
    () => graph.run({
      cypher: `MATCH (t:MemoryNode {kind: 'Task'})-[:CAUSED_FAILURE]->(f:MemoryNode {kind: 'Failure'})
               WHERE t.label CONTAINS $kw RETURN t.label AS task LIMIT 5`,
      params: { kw: 'Migrate the billing' },
    }),
    /CAUSED_FAILURE does not exist/,
  );
});
