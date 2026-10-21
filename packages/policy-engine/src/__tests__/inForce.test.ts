import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext, ToolInput, PolicyRule, GraphQueryRunner } from '@maf/types';
import { makeRunId, makeTaskId, makeAgentId, makeToolId } from '@maf/types';
import { PolicyEngine } from '../PolicyEngine.js';

// ORACLE (F6 of the 0.3.1 sweep; F5 of the packaging sweep). A signed bundle could not say which
// policy governed the run: two runs — one with no policy file, one whose file a Deny rule never fired
// from — were indistinguishable from `toolCalls` and `securityFindings` alone. `inForce()` is that
// record: where the rules came from, what they are, and how the calls fell.
//
// D-49 gave that record three sources (a file, the shipped built-in policy, `none`). F5 keeps the
// 0.4.0 reading intact: `source` is still the file's path and is absent when no user file supplied
// the rules, so a reader written against 0.4.0 never sees a kind where it expects a path. Which kind
// chose the rules is the additive `sourceKind`; `sha256` is the digest of the bytes in force.

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

test('inForce names the file when there was one, how the rules were chosen, and a sha only when bytes were read', () => {
  const fromFile = new PolicyEngine(stubGraph);
  fromFile.loadRules([], { kind: 'file', path: '.maf/policy.yaml', sha256: 'abc123' });
  const named = fromFile.inForce();
  // A 0.4.0 reader's field keeps its 0.4.0 meaning: the path.
  assert.equal(named.source, '.maf/policy.yaml');
  assert.equal(named.sourceKind, 'file');
  assert.equal(named.sha256, 'abc123');
  assert.equal('path' in named, false, 'the source is a path, not an object with one');

  const unread = new PolicyEngine(stubGraph);
  unread.loadRules([], { kind: 'file', path: '.maf/policy.yaml' });
  const bare = unread.inForce();
  assert.equal(bare.source, '.maf/policy.yaml', 'the path was still looked at');
  assert.equal(bare.sourceKind, 'file');
  assert.equal('sha256' in bare, false, 'no file was read, so there are no bytes to digest');

  // D-49: the shipped default and the explicit opt-out are their own sources, with no user path.
  const builtIn = new PolicyEngine(stubGraph);
  builtIn.loadRules([], { kind: 'built-in', sha256: 'def456' });
  const shipped = builtIn.inForce();
  assert.equal(shipped.sourceKind, 'built-in');
  assert.equal('source' in shipped, false, 'no user file was named');
  assert.equal(shipped.sha256, 'def456', "the shipped asset's digest, so a reader knows which text applied");

  const none = new PolicyEngine(stubGraph);
  none.loadRules([], { kind: 'none' });
  const optedOut = none.inForce();
  assert.equal(optedOut.sourceKind, 'none');
  assert.equal('source' in optedOut, false);
  assert.equal('sha256' in optedOut, false, 'no rules means no bytes to digest');
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
