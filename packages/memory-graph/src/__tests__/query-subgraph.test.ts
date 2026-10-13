import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeRunId } from '@maf/types';
import { MemoryGraph } from '../MemoryGraph.js';

// ORACLE (D-16; audit P2 "`querySubgraph` filters after an unordered first-120"). The query took
// the first `maxNodes * 3` nodes in storage order and only then looked for the keywords, so on a
// graph past that size whatever was written last — the most recent memory — could never be found.
// The filter and the ranking now happen in the query, before the limit.

/** One database for the whole file (see graph-parameters.test.ts for why). */
let graph: MemoryGraph;
let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'maf-subgraph-'));
  graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
});

after(async () => {
  graph.close();
  await rm(dir, { recursive: true, force: true });
});

test('matches written after more than maxNodes * 3 other nodes are still found', async () => {
  const runId = makeRunId('run-subgraph-filter');
  const maxNodes = 40;
  // 130 > 120 = maxNodes * 3, written first so they fill the old unordered window.
  for (let i = 0; i < 130; i++) {
    await graph.addNode({ kind: 'Run', label: `filler ${i}`, properties: { i }, runId });
  }
  const one = await graph.addNode({ kind: 'Task', label: 'Tune the ZEPPELIN cache', properties: {}, runId });
  const two = await graph.addNode({ kind: 'Task', label: 'zeppelin cache eviction', properties: { area: 'zeppelin' }, runId });
  const props = await graph.addNode({ kind: 'File', label: 'src/cache.ts', properties: { note: 'ZEPPELIN' }, runId });

  const sub = await graph.querySubgraph('zeppelin eviction', maxNodes);

  assert.deepEqual(new Set(sub.nodes.map((n) => n.id)), new Set([one, two, props]),
    'every node naming a keyword is found, wherever it sits in storage order');
  assert.equal(sub.nodes[0]?.id, two, 'the node matching both keywords ranks first');
  assert.equal(sub.relevanceScores.get(two), 2);
  assert.equal(sub.relevanceScores.get(one), 1, 'the label is searched ignoring case');
  assert.equal(sub.relevanceScores.get(props), 1, 'properties are searched too, ignoring case');
});

test('a keyword matches a node kind, ignoring case', async () => {
  const runId = makeRunId('run-subgraph-kind');
  const approval = await graph.addNode({ kind: 'Approval', label: 'merge allowed', properties: {}, runId });

  const sub = await graph.querySubgraph('approval', 10);

  assert.deepEqual(sub.nodes.map((n) => n.id), [approval], 'only the kind names the keyword');
});

test('the limit applies to the matches, best first', async () => {
  const runId = makeRunId('run-subgraph-limit');
  for (let i = 0; i < 5; i++) {
    await graph.addNode({ kind: 'Task', label: `quokka ${i}`, properties: {}, runId });
  }
  const best = await graph.addNode({ kind: 'Task', label: 'quokka wombat', properties: {}, runId });

  const sub = await graph.querySubgraph('quokka wombat', 3);

  assert.equal(sub.nodes.length, 3);
  assert.equal(sub.nodes[0]?.id, best);
  assert.ok(sub.nodes.every((n) => n.label.startsWith('quokka')));
});
