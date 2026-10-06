import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunId } from '@maf/types';
import { MemoryGraph } from '../MemoryGraph.js';

// ORACLE (DEFECT_SWEEP_2026-09-25.md D-08/D-20/D-19; IMPLEMENTATION_CHECKLIST A2-3 exit
// criterion "a crafted node id does not damage the graph").
//
// These tests load the real kuzu native module and write a real database, because the claim is
// about what the driver does with a value, and a fake driver would only restate the assumption.
// The escaper they replace was exactly such an assumption: `.replace(/'/g, "''")` — SQL quote
// doubling applied to Cypher — held in three identical copies, and no test ever ran a value
// through a real binder to see whether it survived.

/**
 * A value built to end the surrounding Cypher string, close the `{…}` map, and leave a real
 * `DETACH DELETE` clause behind. It is the shape the sweep used to drop a graph.
 */
const PAYLOAD = `x'}) DETACH DELETE n //`;

/**
 * One database for the whole file, deliberately.
 *
 * Kùzu 0.7.1 does not tolerate a process that opens many of them: measured, four tests that each
 * open their own `Database` all pass and the fifth never reports — the process is gone, with no
 * error, and `node --test` blames the file. Nor can the abandoned ones be reclaimed: a `close()`
 * followed by GC of the `Database` is the crash, so "one per test" cannot be made to work by
 * tidying up harder.
 *
 * Sharing costs nothing here. Each test scopes its assertions to its own `run_id`, so they do not
 * need to be isolated from each other — and the whole file runs in ~50 ms rather than ~400.
 */
let graph: MemoryGraph;
let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'maf-graph-'));
  graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
});

after(async () => {
  graph.close();
  await rm(dir, { recursive: true, force: true });
});

async function countIn(runId: string): Promise<number> {
  const rows = await graph.run({
    cypher: 'MATCH (n:MemoryNode {run_id: $runId}) RETURN count(n) AS c',
    params: { runId },
  });
  return Number(rows[0]?.['c'] ?? -1);
}

test('a crafted value is data: bound, it leaves the graph intact and round-trips byte-for-byte', async () => {
  const runId = 'run-crafted-value' as RunId;
  await graph.addNode({ kind: 'Run', label: PAYLOAD, properties: { payload: PAYLOAD }, runId });
  await graph.addNode({ kind: 'Run', label: 'plain', properties: {}, runId });
  assert.equal(await countIn(runId), 2);

  const rows = await graph.run({
    cypher: 'MATCH (n:MemoryNode {run_id: $runId}) WHERE n.label = $label RETURN n.label AS label',
    params: { runId, label: PAYLOAD },
  });

  assert.equal(rows.length, 1, 'the payload is compared as a value, so it matches its own node');
  // Byte-for-byte, not "close enough": the old escaper rewrote the value on its way into the
  // query, so the round trip was lossy for anything containing a quote. Binding stores and
  // returns what the caller actually passed.
  assert.equal(rows[0]?.['label'], PAYLOAD);
  assert.equal(await countIn(runId), 2, 'nothing was deleted');
});

test('the same text written into the query instead of bound does delete rows', async () => {
  // Anti-vacuity: without this, the test above would pass for a payload that was harmless to
  // begin with. This is the query the old code built — value spliced in, quote doubling its only
  // guard — and it is a working statement that deletes.
  const runId = 'run-interpolated' as RunId;
  for (const label of ['x', 'keep-1', 'keep-2']) {
    await graph.addNode({ kind: 'Run', label, properties: {}, runId });
  }
  assert.equal(await countIn(runId), 3);

  await graph.run({
    cypher: `MATCH (n:MemoryNode {label: '${PAYLOAD}'}) DETACH DELETE n //'}) RETURN n`,
    params: {},
  });

  assert.equal(await countIn(runId), 2, 'the injected DETACH DELETE ran and removed the `x` node');
});

test('a crafted value as a run id does not reach past its own rows', async () => {
  const mine = 'run-mine' as RunId;
  const theirs = 'run-theirs' as RunId;
  await graph.addNode({ kind: 'Run', label: 'mine', properties: {}, runId: mine });
  await graph.addNode({ kind: 'Run', label: 'theirs', properties: {}, runId: theirs });

  // `run_id: $runId` — the one place a caller-supplied string is matched against an indexed
  // column. Bound, the payload selects nothing; spliced, it would have rewritten the query.
  const rows = await graph.run({
    cypher: 'MATCH (n:MemoryNode {run_id: $runId}) RETURN n.label AS label',
    params: { runId: `run-mine'}) DETACH DELETE n //` as RunId },
  });

  assert.deepEqual(rows, []);
  assert.equal(await countIn(mine), 1);
  assert.equal(await countIn(theirs), 1);
});

test('a generated id list binds: the edge query finds both endpoints', async () => {
  // `idListParams` generates `$nid0, $nid1, …` because Kùzu rejects an array parameter
  // (`IN $ids`), and an unused parameter is an error rather than a silent no-match. Nothing else
  // in the suite proves the driver accepts those generated names.
  const runId = 'run-edges' as RunId;
  const a = await graph.addNode({ kind: 'Run', label: 'alpha task', properties: {}, runId });
  const b = await graph.addNode({ kind: 'Run', label: 'beta task', properties: {}, runId });
  await graph.addEdge({
    fromId: a, toId: b, relation: 'DEPENDS_ON', weight: 1, metadata: { note: 'x' },
  });

  const sub = await graph.querySubgraph('alpha beta', 10);

  assert.equal(sub.nodes.length, 2);
  assert.equal(sub.edges.length, 1, 'the IN-list query returned the edge');
  assert.equal(sub.edges[0]?.relation, 'DEPENDS_ON');
  assert.equal(sub.edges[0]?.fromId, a);
  assert.equal(sub.edges[0]?.toId, b);
});
