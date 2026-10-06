import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, PolicyRule, GraphQuery, GraphQueryRunner, GraphRow } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import { PolicyEngine } from '../PolicyEngine.js';

const stubGraph = {} as never;

const baseCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  cwd:         '/tmp',
  projectRoot: '/tmp',
  runId:       makeRunId('r1'),
  taskId:      makeTaskId('t1'),
  agentId:     makeAgentId('a1'),
  sessionId:   's1',
  policy:      { evaluate: async () => ({ verdict: 'Allow' }) },
  attestor:    { record: async () => undefined } as never,
  ...overrides,
});

const FS_WRITE = makeToolId('fs.write');
const FS_READ  = makeToolId('fs.read');
const SHELL    = makeToolId('shell.exec');

const rule = (overrides: Partial<PolicyRule>): PolicyRule => ({
  id: 'r', description: '', priority: 100,
  predicate: {}, action: { kind: 'Allow' },
  ...overrides,
});

test('no rules → default Allow', async () => {
  const engine = new PolicyEngine(stubGraph);
  const res = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx(), ['x']);
  assert.equal(res.verdict, 'Allow');
});

test('toolId array predicate matches any listed tool', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([rule({
    id: 'multi-tool',
    predicate: { toolId: [FS_WRITE, SHELL] },
    action: { kind: 'Deny', reason: 'dangerous' },
  })]);
  assert.equal((await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx(), ['x'])).verdict, 'Deny');
  assert.equal((await engine.evaluate(SHELL,    { path: 'x' }, baseCtx(), ['x'])).verdict, 'Deny');
  assert.equal((await engine.evaluate(FS_READ,  { path: 'x' }, baseCtx(), ['x'])).verdict, 'Allow');
});

test('pathGlob rule does not match a call that declares no path', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([rule({
    id: 'env-guard',
    predicate: { toolId: FS_WRITE, pathGlob: '**/.env*' },
    action: { kind: 'Deny', reason: 'env' },
  })]);
  const res = await engine.evaluate(FS_WRITE, {}, baseCtx(), []);
  assert.equal(res.verdict, 'Allow');
});

test('pathGlob matches any path the call declares, not just the first', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([rule({
    id: 'env-guard',
    predicate: { toolId: FS_WRITE, pathGlob: '**/.env*' },
    action: { kind: 'Deny', reason: 'env' },
  })]);
  const res = await engine.evaluate(
    FS_WRITE, { diff: '...' }, baseCtx(), ['src/a.ts', 'config/.env.local'],
  );
  assert.equal(res.verdict, 'Deny');
});

test('equal priority: first-loaded rule wins (stable sort)', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([
    rule({ id: 'first',  priority: 50, predicate: { toolId: FS_READ }, action: { kind: 'Deny', reason: 'first' } }),
    rule({ id: 'second', priority: 50, predicate: { toolId: FS_READ }, action: { kind: 'Deny', reason: 'second' } }),
  ]);
  const res = await engine.evaluate(FS_READ, { path: 'x' }, baseCtx(), ['x']);
  assert.equal(res.verdict, 'Deny');
  assert.equal((res as { reason?: string }).reason, 'first');
});

test('Deny decision carries reason and alternative when configured', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([rule({
    id: 'use-patch',
    predicate: { toolId: FS_WRITE },
    action: { kind: 'Deny', reason: 'direct writes forbidden', alternative: makeToolId('patch.apply') },
  })]);
  const res = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx(), ['x']);
  assert.equal(res.verdict, 'Deny');
  const deny = res as { reason?: string; alternative?: string };
  assert.equal(deny.reason, 'direct writes forbidden');
  assert.equal(deny.alternative, 'patch.apply');
});

test('Escalate decision produces a well-formed ApprovalRequest', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([rule({
    id: 'prod-deploy',
    predicate: { toolId: SHELL, pathGlob: 'deploy/**' },
    action: { kind: 'Escalate', requiresApproval: true },
  })]);
  const before = Date.now();
  const res = await engine.evaluate(SHELL, { path: 'deploy/prod.sh' }, baseCtx(), ['deploy/prod.sh']);
  assert.equal(res.verdict, 'Escalate');
  const req = (res as { approvalRequest?: import('@maf/types').ApprovalRequest }).approvalRequest;
  assert.ok(req, 'approvalRequest missing');
  assert.equal(req.runId, 'r1');
  assert.equal(req.taskId, 't1');
  assert.equal(req.toolId, SHELL);
  assert.equal(req.policyRuleId, 'prod-deploy');
  assert.ok(req.id.length > 0);
  assert.match(req.description, /deploy\/prod\.sh/);
  // Expires ~24h out
  assert.ok(req.expiresAt, 'expiresAt missing');
  const ttl = req.expiresAt.getTime() - before;
  assert.ok(ttl > 23 * 60 * 60 * 1000 && ttl <= 25 * 60 * 60 * 1000, `ttl=${ttl}`);
});

const runnerReturning = (rows: GraphRow[]): GraphQueryRunner => ({ run: async () => rows });

test('memoryPattern: rule fires when graph query returns rows', async () => {
  const engine = new PolicyEngine(runnerReturning([{ hit: 1 }]));
  engine.loadRules([rule({
    id: 'past-failure',
    predicate: { toolId: FS_WRITE, memoryPattern: { cypher: 'MATCH (f {path: $path}) RETURN f' } },
    action: { kind: 'Deny', reason: 'file failed before' },
  })]);
  const res = await engine.evaluate(FS_WRITE, { path: 'flaky.ts' }, baseCtx(), ['flaky.ts']);
  assert.equal(res.verdict, 'Deny');
});

test('memoryPattern: the rule binds the confined path, it does not write it in', async () => {
  const seen: GraphQuery[] = [];
  const engine = new PolicyEngine({
    run: async (q) => { seen.push(q); return []; },
  });
  engine.loadRules([rule({
    id: 'past-failure',
    predicate: { toolId: FS_WRITE, memoryPattern: { cypher: 'MATCH (f {path: $path}) RETURN f' } },
    action: { kind: 'Deny', reason: 'nope' },
  })]);

  // A payload built to close the surrounding string literal and comment out the rest of the query.
  const payload = "x'}) DETACH DELETE n //";
  await engine.evaluate(FS_WRITE, { path: payload }, baseCtx(), [payload]);

  // The template is what runs. Nothing from the payload is spliced into the query, so there is no
  // literal for the payload to close.
  assert.equal(seen[0]!.cypher, 'MATCH (f {path: $path}) RETURN f');
  assert.doesNotMatch(seen[0]!.cypher, /DETACH|x'/);

  // The payload travels as data, and it is the **confined** path that travels — the same value the
  // `pathGlob` predicate matched, so a rule's glob and its Cypher cannot disagree about which file
  // they are asking about. Confinement is what the expectation below derives from: path resolution
  // reads a trailing `//` as a separator and drops it (`a//` and `a` name one file), and touches
  // nothing else — the quote, the brace and the `DETACH DELETE` all arrive intact, as data.
  const confined = payload.slice(0, -'//'.length);
  assert.equal(seen[0]!.params['path'], confined);
});

test('memoryPattern: rule falls through when graph returns no rows', async () => {
  const engine = new PolicyEngine(runnerReturning([]));
  engine.loadRules([rule({
    id: 'past-failure',
    predicate: { toolId: FS_WRITE, memoryPattern: { cypher: 'MATCH (f) RETURN f' } },
    action: { kind: 'Deny', reason: 'nope' },
  })]);
  const res = await engine.evaluate(FS_WRITE, { path: 'clean.ts' }, baseCtx(), ['clean.ts']);
  assert.equal(res.verdict, 'Allow');
});

test('memoryPattern: a graph failure refuses the call instead of skipping the rule', async () => {
  // This replaces "graph failure fails open for the rule (falls through)", which asserted the
  // verdict was Allow. That was the defect stated as a test: a Deny rule stopped firing the
  // moment the graph could be broken, and breaking the graph is the easiest thing for the party
  // the rule is aimed at to arrange. The guarantee now is that an unevaluatable policy refuses.
  const engine = new PolicyEngine({
    run: async () => { throw new Error('kuzu down'); },
  });
  engine.loadRules([rule({
    id: 'graph-gated',
    predicate: { toolId: FS_WRITE, memoryPattern: { cypher: 'MATCH (f) RETURN f' } },
    action: { kind: 'Deny', reason: 'nope' },
  })]);
  const res = await engine.evaluate(FS_WRITE, { path: 'x.ts' }, baseCtx(), ['x.ts']);
  assert.equal(res.verdict, 'Indeterminate');
  const indeterminate = res as { reason?: string; ruleId?: string };
  assert.equal(indeterminate.ruleId, 'graph-gated');
  assert.match(String(indeterminate.reason), /graph-gated/);
  assert.match(String(indeterminate.reason), /kuzu down/, 'the operator is told why, not just that');
});

test('memoryPattern: a rule whose template is malformed refuses rather than never matching', async () => {
  const engine = new PolicyEngine(runnerReturning([{ hit: 1 }]));
  engine.loadRules([rule({
    id: 'typo',
    predicate: { toolId: FS_WRITE, memoryPattern: { cypher: 'MATCH (f {path: $filePath}) RETURN f' } },
    action: { kind: 'Deny', reason: 'nope' },
  })]);
  const res = await engine.evaluate(FS_WRITE, { path: 'x.ts' }, baseCtx(), ['x.ts']);
  assert.equal(res.verdict, 'Indeterminate');
  assert.match(String((res as { reason?: string }).reason), /\$filePath/);
});

test('fromYaml() loads rules from a JSON policy file with comments', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-engine-'));
  const file = path.join(dir, 'policy.yaml');
  const doc = [
    '# generated policy',
    JSON.stringify({
      rules: [{
        id: 'from-file', description: '', priority: 10,
        predicate: { toolId: 'fs.write' },
        action: { kind: 'Deny', reason: 'from file' },
      }],
    }),
  ].join('\n');
  await writeFile(file, doc, 'utf8');
  try {
    const engine = await PolicyEngine.fromYaml(file, stubGraph);
    const res = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx(), ['x']);
    assert.equal(res.verdict, 'Deny');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fromYaml() tolerates a missing policy file (no rules)', async () => {
  const engine = await PolicyEngine.fromYaml('/no/such/policy.yaml', stubGraph);
  const res = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx(), ['x']);
  assert.equal(res.verdict, 'Allow');
});
