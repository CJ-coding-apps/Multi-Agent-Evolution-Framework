import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext, ToolInput } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';
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

function graphReturning(rows: unknown[]): MemoryGraph {
  return { query: async () => rows } as unknown as MemoryGraph;
}

function graphThrowing(): MemoryGraph {
  return { query: async () => { throw new Error('kuzu down'); } } as unknown as MemoryGraph;
}

test('interpolate() substitutes $tool, $path, $runId, $taskId', () => {
  const ev = new CypherEvaluator(graphReturning([]));
  const out = ev.interpolate(
    'MATCH (t:Tool {id: $tool})-[:TOUCHED]->(f {path: $path, run: $runId, task: $taskId})',
    TOOL,
    { path: 'src/db.ts' },
    ctx(),
  );
  assert.match(out, /'fs\.write'/);
  assert.match(out, /'src\/db\.ts'/);
  assert.match(out, /'run-42'/);
  assert.match(out, /'task-7'/);
  assert.doesNotMatch(out, /\$tool|\$path|\$runId|\$taskId/);
});

test('interpolate() escapes single quotes in interpolated values (injection guard)', () => {
  const ev = new CypherEvaluator(graphReturning([]));
  const out = ev.interpolate(
    'MATCH (f {path: $path})',
    TOOL,
    { path: "a'); DETACH DELETE n; //" },
    ctx(),
  );
  // Single quotes must be doubled, so the value cannot terminate the string literal
  assert.match(out, /a''\); DETACH DELETE n; \/\//);
});

test('interpolate() falls back to filePath when path is absent', () => {
  const ev = new CypherEvaluator(graphReturning([]));
  const out = ev.interpolate('p=$path', TOOL, { filePath: 'lib/x.ts' }, ctx());
  assert.match(out, /'lib\/x\.ts'/);
});

test('interpolate() uses empty string when no path-like input present', () => {
  const ev = new CypherEvaluator(graphReturning([]));
  const out = ev.interpolate('p=$path', TOOL, {} as ToolInput, ctx());
  assert.equal(out, "p=''");
});

test('evaluate() returns true when the graph returns rows', async () => {
  const ev = new CypherEvaluator(graphReturning([{ n: 1 }]));
  assert.equal(await ev.evaluate('MATCH (n) RETURN n', TOOL, { path: 'x' }, ctx()), true);
});

test('evaluate() returns false when the graph returns no rows', async () => {
  const ev = new CypherEvaluator(graphReturning([]));
  assert.equal(await ev.evaluate('MATCH (n) RETURN n', TOOL, { path: 'x' }, ctx()), false);
});

test('evaluate() fails closed (false) when the graph throws', async () => {
  const ev = new CypherEvaluator(graphThrowing());
  assert.equal(await ev.evaluate('MATCH (n) RETURN n', TOOL, { path: 'x' }, ctx()), false);
});
