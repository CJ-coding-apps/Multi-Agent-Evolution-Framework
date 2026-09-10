import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, PolicyRule } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';
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
  const res = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx());
  assert.equal(res.verdict, 'Allow');
});

test('toolId array predicate matches any listed tool', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([rule({
    id: 'multi-tool',
    predicate: { toolId: [FS_WRITE, SHELL] },
    action: { kind: 'Deny', reason: 'dangerous' },
  })]);
  assert.equal((await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx())).verdict, 'Deny');
  assert.equal((await engine.evaluate(SHELL,    { path: 'x' }, baseCtx())).verdict, 'Deny');
  assert.equal((await engine.evaluate(FS_READ,  { path: 'x' }, baseCtx())).verdict, 'Allow');
});

test('pathGlob rule does not match when input carries no path', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([rule({
    id: 'env-guard',
    predicate: { toolId: FS_WRITE, pathGlob: '**/.env*' },
    action: { kind: 'Deny', reason: 'env' },
  })]);
  const res = await engine.evaluate(FS_WRITE, {}, baseCtx());
  assert.equal(res.verdict, 'Allow');
});

test('pathGlob matches against a paths[] array input', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([rule({
    id: 'env-guard',
    predicate: { toolId: FS_WRITE, pathGlob: '**/.env*' },
    action: { kind: 'Deny', reason: 'env' },
  })]);
  const res = await engine.evaluate(FS_WRITE, { paths: ['src/a.ts', 'config/.env.local'] }, baseCtx());
  assert.equal(res.verdict, 'Deny');
});

test('equal priority: first-loaded rule wins (stable sort)', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([
    rule({ id: 'first',  priority: 50, predicate: { toolId: FS_READ }, action: { kind: 'Deny', reason: 'first' } }),
    rule({ id: 'second', priority: 50, predicate: { toolId: FS_READ }, action: { kind: 'Deny', reason: 'second' } }),
  ]);
  const res = await engine.evaluate(FS_READ, { path: 'x' }, baseCtx());
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
  const res = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx());
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
  const res = await engine.evaluate(SHELL, { path: 'deploy/prod.sh' }, baseCtx());
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

test('memoryPattern: rule fires when graph query returns rows', async () => {
  const graph = { query: async () => [{ hit: 1 }] } as unknown as MemoryGraph;
  const engine = new PolicyEngine(graph);
  engine.loadRules([rule({
    id: 'past-failure',
    predicate: { toolId: FS_WRITE, memoryPattern: { cypher: 'MATCH (f {path: $path}) RETURN f' } },
    action: { kind: 'Deny', reason: 'file failed before' },
  })]);
  const res = await engine.evaluate(FS_WRITE, { path: 'flaky.ts' }, baseCtx());
  assert.equal(res.verdict, 'Deny');
});

test('memoryPattern: rule falls through when graph returns no rows', async () => {
  const graph = { query: async () => [] } as unknown as MemoryGraph;
  const engine = new PolicyEngine(graph);
  engine.loadRules([rule({
    id: 'past-failure',
    predicate: { toolId: FS_WRITE, memoryPattern: { cypher: 'MATCH (f) RETURN f' } },
    action: { kind: 'Deny', reason: 'nope' },
  })]);
  const res = await engine.evaluate(FS_WRITE, { path: 'clean.ts' }, baseCtx());
  assert.equal(res.verdict, 'Allow');
});

test('memoryPattern: graph failure fails open for the rule (falls through)', async () => {
  const graph = { query: async () => { throw new Error('kuzu down'); } } as unknown as MemoryGraph;
  const engine = new PolicyEngine(graph);
  engine.loadRules([rule({
    id: 'graph-gated',
    predicate: { toolId: FS_WRITE, memoryPattern: { cypher: 'MATCH (f) RETURN f' } },
    action: { kind: 'Deny', reason: 'nope' },
  })]);
  const res = await engine.evaluate(FS_WRITE, { path: 'x.ts' }, baseCtx());
  assert.equal(res.verdict, 'Allow');
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
    const res = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx());
    assert.equal(res.verdict, 'Deny');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fromYaml() tolerates a missing policy file (no rules)', async () => {
  const engine = await PolicyEngine.fromYaml('/no/such/policy.yaml', stubGraph);
  const res = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx());
  assert.equal(res.verdict, 'Allow');
});
