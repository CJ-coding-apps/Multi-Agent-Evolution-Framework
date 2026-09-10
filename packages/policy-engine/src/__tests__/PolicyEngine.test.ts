import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext, ToolInput, PolicyRule } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import { PolicyEngine } from '../PolicyEngine.js';

// MemoryGraph is only touched via evaluateCypher (predicate.memoryPattern path);
// none of these tests set memoryPattern, so a typed stub is sufficient.
const stubGraph = {} as never;

const baseCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  cwd:         '/tmp',
  projectRoot: '/tmp',
  runId:       makeRunId('r1'),
  taskId:      makeTaskId('t1'),
  agentId:     makeAgentId('a1'),
  sessionId:   's1',
  policy:      { evaluate: async () => ({ verdict: 'Allow' }) },
  attestor:    { record: async () => undefined, recordDiffHash: () => undefined, addApproval: () => undefined } as never,
  ...overrides,
});

const FS_WRITE = makeToolId('fs.write');
const FS_READ  = makeToolId('fs.read');
const PATCH_APPLY = makeToolId('patch.apply');

test('rule with agentRole matches only when context role matches', async () => {
  const engine = new PolicyEngine(stubGraph);
  const rule: PolicyRule = {
    id: 'tester-only',
    description: '',
    priority: 100,
    predicate: { agentRole: 'tester', toolId: FS_WRITE },
    action: { kind: 'Deny', reason: 'no' },
  };
  engine.loadRules([rule]);
  const input: ToolInput = { path: 'src/foo.ts' };

  const allowResult = await engine.evaluate(FS_WRITE, input, baseCtx({ agentRole: 'coder' }));
  assert.equal(allowResult.verdict, 'Allow');

  const denyResult = await engine.evaluate(FS_WRITE, input, baseCtx({ agentRole: 'tester' }));
  assert.equal(denyResult.verdict, 'Deny');
});

test('rule with agentRole array matches when context role is in array', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([{
    id: 'readonly',
    description: '',
    priority: 100,
    predicate: { agentRole: ['security', 'reviewer'], toolId: FS_WRITE },
    action: { kind: 'Deny', reason: 'read-only' },
  }]);

  const res1 = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx({ agentRole: 'security' }));
  assert.equal(res1.verdict, 'Deny');

  const res2 = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx({ agentRole: 'reviewer' }));
  assert.equal(res2.verdict, 'Deny');

  const res3 = await engine.evaluate(FS_WRITE, { path: 'x' }, baseCtx({ agentRole: 'coder' }));
  assert.equal(res3.verdict, 'Allow');
});

test('rule omitting agentRole matches every role (backward compat)', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([{
    id: 'global',
    description: '',
    priority: 100,
    predicate: { toolId: FS_WRITE, pathGlob: '**/.env*' },
    action: { kind: 'Deny', reason: 'no env files' },
  }]);

  for (const role of ['coder', 'tester', 'security', 'reviewer', undefined]) {
    const ctx = role ? baseCtx({ agentRole: role }) : baseCtx();
    const res = await engine.evaluate(FS_WRITE, { path: '.env' }, ctx);
    assert.equal(res.verdict, 'Deny', `role=${role}`);
  }
});

test('allowedPathGlobs Deny: blocks writes outside the allowed patterns', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([{
    id: 'tester-write-only-tests',
    description: '',
    priority: 100,
    predicate: {
      agentRole: 'tester',
      toolId: FS_WRITE,
      allowedPathGlobs: ['**/*test*', '**/tests/**', '**/__tests__/**'],
    },
    action: { kind: 'Deny', reason: 'tester role' },
  }]);

  const ctx = baseCtx({ agentRole: 'tester' });
  // Inside allowed → no match → fall through → Allow
  const inside = await engine.evaluate(FS_WRITE, { path: 'src/foo.test.ts' }, ctx);
  assert.equal(inside.verdict, 'Allow');

  const insideDir = await engine.evaluate(FS_WRITE, { path: 'src/tests/util.ts' }, ctx);
  assert.equal(insideDir.verdict, 'Allow');

  // Outside allowed → matches → Deny
  const outside = await engine.evaluate(FS_WRITE, { path: 'src/foo.ts' }, ctx);
  assert.equal(outside.verdict, 'Deny');
});

test('allowedPathGlobs with multi-file paths input', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([{
    id: 'tester-multi',
    description: '',
    priority: 100,
    predicate: {
      agentRole: 'tester',
      toolId: PATCH_APPLY,
      allowedPathGlobs: ['**/*test*', '**/__tests__/**'],
    },
    action: { kind: 'Deny', reason: 'tester' },
  }]);

  const ctx = baseCtx({ agentRole: 'tester' });
  // All inside → Allow
  const allInside = await engine.evaluate(
    PATCH_APPLY,
    { paths: ['a.test.ts', '__tests__/b.ts'] },
    ctx,
  );
  assert.equal(allInside.verdict, 'Allow');

  // Mixed: one outside → Deny
  const mixed = await engine.evaluate(
    PATCH_APPLY,
    { paths: ['a.test.ts', 'src/bad.ts'] },
    ctx,
  );
  assert.equal(mixed.verdict, 'Deny');
});

test('higher priority rule wins', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([
    {
      id: 'low-allow',
      description: '',
      priority: 10,
      predicate: { toolId: FS_READ },
      action: { kind: 'Allow' },
    },
    {
      id: 'high-deny',
      description: '',
      priority: 100,
      predicate: { toolId: FS_READ },
      action: { kind: 'Deny', reason: 'high wins' },
    },
  ]);
  const res = await engine.evaluate(FS_READ, { path: 'x' }, baseCtx());
  assert.equal(res.verdict, 'Deny');
});
