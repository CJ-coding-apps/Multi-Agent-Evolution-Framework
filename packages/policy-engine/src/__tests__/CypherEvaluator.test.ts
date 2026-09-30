import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphQuery, GraphQueryRunner, GraphRow, ToolContext, ToolInput } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import { CypherEvaluator } from '../CypherEvaluator.js';

const ctx = (): ToolContext => ({
  cwd:         '/tmp',
  projectRoot: '/tmp',
  runId:       makeRunId('run-42'),
  taskId:      makeTaskId('task-7'),
  agentId:     makeAgentId('a1'),
  sessionId:   's1',
  policy:      { evaluate: async () => ({ verdict: 'Allow' }) },
  attestor:    { record: async () => undefined } as never,
});

const TOOL = makeToolId('fs.write');

/** A runner that records what it was asked, so the query itself is observable. */
function recordingRunner(rows: GraphRow[] = []): { runner: GraphQueryRunner; seen: GraphQuery[] } {
  const seen: GraphQuery[] = [];
  return {
    runner: { run: async (q: GraphQuery) => { seen.push(q); return rows; } },
    seen,
  };
}

const throwingRunner: GraphQueryRunner = {
  run: async () => { throw new Error('kuzu down'); },
};

test('a value is bound, never written into the query', async () => {
  // This replaces four tests that locked `interpolate()`, the method that built the query by
  // substituting values into it — the point of A2-3 is that no such method exists, so the test
  // is of the guarantee rather than of the mechanism it used.
  const { runner, seen } = recordingRunner([]);
  const ev = new CypherEvaluator(runner);
  await ev.evaluate('MATCH (f {path: $path}) RETURN f', TOOL, { path: 'src/db.ts' }, ctx());

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.params['path'], 'src/db.ts', 'the value travels as a parameter');
  assert.match(seen[0]!.cypher, /\$path/, 'the template keeps its placeholder');
  assert.doesNotMatch(seen[0]!.cypher, /src\/db\.ts/, 'and the value is not in the query text');
});

test('a crafted path cannot change the query', async () => {
  const { runner, seen } = recordingRunner([]);
  const ev = new CypherEvaluator(runner);
  const crafted = "a'); DETACH DELETE n; //";
  await ev.evaluate('MATCH (f {path: $path}) RETURN f', TOOL, { path: crafted }, ctx());

  assert.equal(seen[0]!.params['path'], crafted, 'the crafted text arrives verbatim, as data');
  assert.equal(seen[0]!.cypher, 'MATCH (f {path: $path}) RETURN f', 'the query is unchanged');
});

test('only the names the template uses are bound', async () => {
  // Kùzu refuses a statement given a parameter it does not reference, so a template that names
  // one of the four must be given exactly that one.
  const { runner, seen } = recordingRunner([]);
  const ev = new CypherEvaluator(runner);
  await ev.evaluate('MATCH (r:Run {id: $runId}) RETURN r', TOOL, { path: 'x' }, ctx());
  assert.deepEqual(Object.keys(seen[0]!.params), ['runId']);
});

test('a template naming something unbindable is refused, not left for the driver', async () => {
  const { runner } = recordingRunner([]);
  const ev = new CypherEvaluator(runner);
  await assert.rejects(
    () => ev.evaluate('MATCH (f {path: $filePath}) RETURN f', TOOL, { path: 'x' }, ctx()),
    (e: Error) => {
      assert.match(e.message, /\$filePath/);
      assert.match(e.message, /\$tool, \$path, \$runId, \$taskId/);
      return true;
    },
  );
});

test('a path-less input binds an empty path', async () => {
  const { runner, seen } = recordingRunner([]);
  const ev = new CypherEvaluator(runner);
  await ev.evaluate('p=$path', TOOL, {} as ToolInput, ctx());
  assert.equal(seen[0]!.params['path'], '');
});

test('filePath is the path when path is absent', async () => {
  const { runner, seen } = recordingRunner([]);
  const ev = new CypherEvaluator(runner);
  await ev.evaluate('p=$path', TOOL, { filePath: 'lib/x.ts' }, ctx());
  assert.equal(seen[0]!.params['path'], 'lib/x.ts');
});

test('evaluate() returns true when the graph returns rows', async () => {
  const ev = new CypherEvaluator(recordingRunner([{ n: 1 }]).runner);
  assert.equal(await ev.evaluate('MATCH (n) RETURN n', TOOL, { path: 'x' }, ctx()), true);
});

test('evaluate() returns false when the graph returns no rows', async () => {
  const ev = new CypherEvaluator(recordingRunner([]).runner);
  assert.equal(await ev.evaluate('MATCH (n) RETURN n', TOOL, { path: 'x' }, ctx()), false);
});

test('a graph failure is an error, not a false', async () => {
  // The test this replaces asserted `false` and called it "fails closed" — but for a boolean
  // meaning "the pattern matched", `false` is read by a Deny rule as "carry on". A helper that
  // cannot say "unknown" must not answer at all.
  const ev = new CypherEvaluator(throwingRunner);
  await assert.rejects(
    () => ev.evaluate('MATCH (n) RETURN n', TOOL, { path: 'x' }, ctx()),
    /kuzu down/,
  );
});
