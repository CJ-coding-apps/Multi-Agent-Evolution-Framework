import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RoleName } from '@maf/types';
import { makeNodeId, makeRunId } from '@maf/types';
import { MemoryGraph } from '@maf/memory-graph';
import { RetrievalAugmentedPlanner } from '../RetrievalAugmentedPlanner.js';
import { FailurePatternDetector } from '../FailurePatternDetector.js';
import { rolesOf } from './roleResolver.js';

// ORACLE (D-16; audit P1 "'planner queries past failures' (README:152)"). The planner's recall
// queried a relationship table the schema does not have, caught the binder's error, and read it as
// "no history" — and its only test handed it a stub graph that answered `[]` to everything, so the
// claim was never exercised. These run the planner and the detector against a real database that
// holds a failure written the way the scheduler writes one.

/** One database for the whole file: Kùzu 0.7.1 does not survive many per process. */
let graph: MemoryGraph;
let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'maf-planner-recall-'));
  graph = new MemoryGraph(path.join(dir, 'memory.kuzu'));
  await graph.recordFailure({
    runId:   makeRunId('run-earlier'),
    nodeId:  makeNodeId('n1'),
    label:   'add limiter',
    task:    'Add rate limiting to the login endpoint',
    role:    'coder' as RoleName,
    reason:  'GateRefused',
    message: 'Security review refused the change from node n1: 1 blocking finding.',
  });
});

after(async () => {
  graph.close();
  await rm(dir, { recursive: true, force: true });
});

const noopLcm = { lcm_grep: async () => [] } as never;
const noopInjector = { assemble: async () => ({ systemPromptPrefix: '' }) } as never;

async function systemPromptFor(title: string): Promise<string> {
  let captured = '';
  const planner = new RetrievalAugmentedPlanner({
    graph, lcm: noopLcm, injector: noopInjector, roles: rolesOf(['coder']),
    generatePlan: async (systemPrompt) => { captured = systemPrompt; return 'no plan'; },
  });
  await planner.plan({ title, description: title, runId: makeRunId('run-now'), sessionId: 's' });
  return captured;
}

test('the planner recalls a recorded failure on a similar task into its prompt', async () => {
  const prompt = await systemPromptFor('add rate limiting to the signup endpoint too');

  assert.match(prompt, /<past-failures>/);
  assert.match(prompt, /Task "Add rate limiting to the login endpoint" \(coder\) → GateRefused: Security review refused the change from node n1/);
});

test('the planner recalls nothing for an unrelated task', async () => {
  const prompt = await systemPromptFor('Write the release notes');

  assert.doesNotMatch(prompt, /<past-failures>/);
});

test('FailurePatternDetector reads the same failure through the same query', async () => {
  const detector = new FailurePatternDetector(graph);

  const patterns = await detector.detectForTitle('Add rate limiting everywhere');

  assert.equal(patterns.length, 1);
  assert.equal(patterns[0]?.taskLabel, 'Add rate limiting to the login endpoint');
  assert.equal(patterns[0]?.failureType, 'GateRefused');
  assert.match(patterns[0]?.lastSeen ?? '', /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(await detector.detectForTitle('Write the release notes'), []);
});

test('FailurePatternDetector finds failures by a file the failed task modified', async () => {
  const [task] = await graph.run({
    cypher: `MATCH (t:MemoryNode {kind: 'Task', run_id: $runId}) RETURN t.id AS id`,
    params: { runId: 'run-earlier' },
  });
  const file = await graph.addNode({ kind: 'File', label: 'src/auth/login.ts', properties: {}, runId: makeRunId('run-earlier') });
  await graph.addEdge({ fromId: String(task?.['id']), toId: file, relation: 'MODIFIED', weight: 1, metadata: {} });
  const detector = new FailurePatternDetector(graph);

  const patterns = await detector.detectForPaths(['src/auth/login.ts', 'src/unrelated.ts']);

  assert.deepEqual(patterns.map((p) => [p.taskLabel, p.failureType, p.filePaths]), [
    ['Add rate limiting to the login endpoint', 'GateRefused', ['src/auth/login.ts']],
  ]);
});

test('planning-agent holds no copy of the recall query', async () => {
  // One query, in memory-graph, next to the write it must agree with. A second copy here is how
  // the planner and the schema drifted apart in the first place.
  const srcDir = path.resolve(__dirname, '../../src');
  const files = (await readdir(srcDir)).filter((f) => f.endsWith('.ts'));
  assert.ok(files.includes('RetrievalAugmentedPlanner.ts') && files.includes('FailurePatternDetector.ts'),
    `the scan must see the planner sources, found ${files.join(', ')}`);
  for (const file of files) {
    const text = await readFile(path.join(srcDir, file), 'utf8');
    assert.doesNotMatch(text, /CAUSED_FAILURE/, `${file} names the failure relation itself`);
  }
});
