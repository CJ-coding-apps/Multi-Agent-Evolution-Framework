import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyRule, ToolContext } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { PolicyEngine } from '../PolicyEngine.js';
import type { PolicyEventRecorder } from '../PolicyEngine.js';

// ORACLE (WP-3.7 amendment item 2): "No code anywhere writes `PolicyEvent`." The digester reads
// these nodes; before this, the evidence it was built to consume could not exist. The engine is
// where a decision is made, so the engine writes it — and a recorder that throws must not change
// the verdict it was asked for.

const FS_WRITE = makeToolId('fs.write');

const DENY_ENV: PolicyRule = {
  id: 'deny-env',
  description: '',
  priority: 100,
  predicate: { toolId: [FS_WRITE], pathGlob: '**/.env' },
  action: { kind: 'Deny', reason: 'secrets are off-limits' },
};

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  cwd:         '/tmp',
  projectRoot: '/tmp',
  runId:       makeRunId('run-1'),
  taskId:      makeTaskId('task-1'),
  agentId:     makeAgentId('a1'),
  sessionId:   's1',
  agentRole:   'coder',
  policy:      { evaluate: async () => ({ verdict: 'Allow' }) },
  attestor:    { record: async () => undefined } as never,
  ...overrides,
});

function recordingEngine(): { engine: PolicyEngine; nodes: Parameters<PolicyEventRecorder['addNode']>[0][] } {
  const nodes: Parameters<PolicyEventRecorder['addNode']>[0][] = [];
  const recorder: PolicyEventRecorder = {
    addNode: async (node) => { nodes.push(node); return `node-${nodes.length}`; },
  };
  const engine = new PolicyEngine({} as never, { recorder });
  engine.loadRules([DENY_ENV]);
  return { engine, nodes };
}

test('every decision is written as a PolicyEvent naming the tool, verdict and run', async () => {
  const { engine, nodes } = recordingEngine();

  await engine.evaluate(FS_WRITE, { path: '/tmp/.env' }, ctx(), ['/tmp/.env']);
  await engine.evaluate(FS_WRITE, { path: '/tmp/notes.txt' }, ctx(), ['/tmp/notes.txt']);

  assert.equal(nodes.length, 2, 'one event per call, allowed calls included');
  const [deny, allow] = nodes as [typeof nodes[number], typeof nodes[number]];
  assert.equal(deny.kind, 'PolicyEvent');
  assert.equal(deny.runId, 'run-1');
  assert.equal(deny.properties['toolId'], 'fs.write');
  assert.equal(deny.properties['verdict'], 'Deny');
  assert.match(String(deny.properties['reason']), /secrets are off-limits/);
  assert.equal(deny.properties['ruleId'], 'deny-env');
  assert.equal(deny.properties['role'], 'coder');
  assert.equal(deny.properties['taskId'], 'task-1');

  assert.equal(allow.properties['verdict'], 'Allow');
  assert.equal(allow.properties['reason'], undefined, 'an allow has no reason to record');
});

test('a recorder that fails changes nothing about the verdict', async () => {
  const engine = new PolicyEngine({} as never, {
    recorder: { addNode: async () => { throw new Error('graph unavailable'); } },
  });
  engine.loadRules([DENY_ENV]);

  const decision = await engine.evaluate(FS_WRITE, { path: '/tmp/.env' }, ctx(), ['/tmp/.env']);
  assert.equal(decision.verdict, 'Deny', 'the refusal still happens; evidence is best-effort');
});

test('without a recorder nothing is written and nothing is required of the graph', async () => {
  const engine = new PolicyEngine({} as never);
  engine.loadRules([DENY_ENV]);
  const decision = await engine.evaluate(FS_WRITE, { path: '/tmp/.env' }, ctx(), ['/tmp/.env']);
  assert.equal(decision.verdict, 'Deny');
});
