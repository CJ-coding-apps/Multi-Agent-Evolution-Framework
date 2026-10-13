import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext, ToolInput, PolicyRule, GraphQueryRunner } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import { PolicyEngine } from '../PolicyEngine.js';

// ORACLE (F6 of the 0.3.1 sweep). A signed bundle could not say which policy governed the run: two
// runs — one with no policy file, one whose file a Deny rule never fired from — were indistinguishable
// from `toolCalls` and `securityFindings` alone. `inForce()` is that record: where the rules came from,
// what they are, and how the calls fell. These pin the parts a reader relies on: the source is named
// only when there was one, the digest is absent exactly when no file was read, and the counts move.

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

const rule = (id: string, priority: number, predicate: PolicyRule['predicate'], action: PolicyRule['action']): PolicyRule =>
  ({ id, description: '', priority, predicate, action });

test('inForce names the source and its sha when the rules came from a file, and omits the sha when they did not', () => {
  const fromFile = new PolicyEngine(stubGraph);
  fromFile.loadRules([], { path: '.maf/policy.yaml', sha256: 'abc123' });
  const named = fromFile.inForce();
  assert.equal(named.source, '.maf/policy.yaml');
  assert.equal(named.sha256, 'abc123');

  const noFile = new PolicyEngine(stubGraph);
  noFile.loadRules([], { path: '.maf/policy.yaml' });
  const bare = noFile.inForce();
  assert.equal(bare.source, '.maf/policy.yaml', 'the path was still looked at');
  assert.equal('sha256' in bare, false, 'no file was read, so there are no bytes to digest');
});

test('inForce summarises each rule as id, effect and what it matches', () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([
    rule('protect-secrets', 100, { toolId: makeToolId('fs.write'), pathGlob: '.env' }, { kind: 'Deny', reason: 'no secrets' }),
    rule('reviewers',        90, { agentRole: ['security', 'reviewer'] },                          { kind: 'Escalate', requiresApproval: true }),
    rule('scoped',           80, { allowedPathGlobs: ['src/**', 'tests/**'] },                      { kind: 'Deny', reason: 'stay in src' }),
    rule('anything',         10, {},                                                                 { kind: 'Allow' }),
  ]);

  const force = engine.inForce();
  assert.equal(force.ruleCount, 4);
  assert.deepEqual(force.rules, [
    { id: 'protect-secrets', effect: 'Deny',     matcher: 'toolId=fs.write pathGlob=.env' },
    { id: 'reviewers',       effect: 'Escalate', matcher: 'agentRole=[security, reviewer]' },
    { id: 'scoped',          effect: 'Deny',     matcher: 'allowedPathGlobs=[src/**, tests/**]' },
    { id: 'anything',        effect: 'Allow',    matcher: '(matches every call)' },
  ], 'highest priority first, and a rule with no predicate says so rather than reading blank');
});

test('inForce marks a predicate the engine ignores, so the record cannot overstate a rule\'s reach', () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([
    rule('inert-only',       50, { minFailureCount: 3 },                                  { kind: 'Deny', reason: 'no' }),
    rule('scoped-plus-inert', 40, { toolId: makeToolId('fs.write'), minFailureCount: 9 }, { kind: 'Deny', reason: 'no' }),
  ]);

  // `decide` never consults `minFailureCount`, so a rule whose only predicate is that matches every
  // call. The record names the key — a reader comparing it to the policy file must find it — but
  // marks it ignored, because this line is a claim about the rule's reach.
  assert.deepEqual(engine.inForce().rules, [
    { id: 'inert-only',       effect: 'Deny', matcher: '(matches every call) (ignored: minFailureCount=3)' },
    { id: 'scoped-plus-inert', effect: 'Deny', matcher: 'toolId=fs.write (ignored: minFailureCount=9)' },
  ]);
});

test('inForce counts every verdict the engine reached, refusals included', async () => {
  const failing = { run: async () => { throw new Error('the graph is down'); } } as unknown as GraphQueryRunner;
  const engine = new PolicyEngine(failing);
  engine.loadRules([
    rule('deny-writes', 100, { toolId: makeToolId('fs.write') }, { kind: 'Deny', reason: 'no' }),
    rule('escalate-deletes', 90, { toolId: makeToolId('fs.delete') }, { kind: 'Escalate', requiresApproval: true }),
    rule('graph-gated', 80, { toolId: makeToolId('grep'), memoryPattern: { cypher: 'MATCH (n) RETURN n' } }, { kind: 'Deny', reason: 'x' }),
  ]);
  const input: ToolInput = { path: 'a.ts' };

  assert.equal((await engine.evaluate(makeToolId('fs.read'), input, baseCtx(), ['a.ts'])).verdict, 'Allow');
  assert.equal((await engine.evaluate(makeToolId('fs.write'), input, baseCtx(), ['a.ts'])).verdict, 'Deny');
  assert.equal((await engine.evaluate(makeToolId('fs.delete'), input, baseCtx(), ['a.ts'])).verdict, 'Escalate');
  assert.equal((await engine.evaluate(makeToolId('grep'), input, baseCtx(), ['a.ts'])).verdict, 'Indeterminate');
  // A path that leaves the root is a Deny before any rule runs; it is a decision, so it is counted.
  assert.equal((await engine.evaluate(makeToolId('fs.read'), input, baseCtx(), ['../outside'])).verdict, 'Deny');

  assert.deepEqual(engine.inForce().counts, { allow: 1, deny: 2, escalate: 1, indeterminate: 1 });
});

test('inForce returns a copy of the counts, not the live object a later call would move', async () => {
  const engine = new PolicyEngine(stubGraph);
  engine.loadRules([]);
  const before = engine.inForce();
  await engine.evaluate(makeToolId('fs.read'), { path: 'a.ts' }, baseCtx(), ['a.ts']);

  assert.deepEqual(before.counts, { allow: 0, deny: 0, escalate: 0, indeterminate: 0 }, 'the record taken earlier does not change under it');
  assert.deepEqual(engine.inForce().counts, { allow: 1, deny: 0, escalate: 0, indeterminate: 0 });
});
