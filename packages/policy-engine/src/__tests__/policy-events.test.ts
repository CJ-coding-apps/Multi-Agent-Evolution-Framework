import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

// MED-2: a refusal is evidence and an allow is not. One Allow per tool call — 62 of them for two
// golden runs — filled the digester's newest-first window and pushed the one Deny a proposal could
// act on out of the planner's view.
test('a refusal is written as a PolicyEvent; an allow is not evidence', async () => {
  const { engine, nodes } = recordingEngine();

  await engine.evaluate(FS_WRITE, { path: '/tmp/.env' }, ctx(), ['/tmp/.env']);
  await engine.evaluate(FS_WRITE, { path: '/tmp/notes.txt' }, ctx(), ['/tmp/notes.txt']);

  assert.equal(nodes.length, 1, 'the denial only; allowed calls are the tally, not the evidence');
  const [deny] = nodes as [typeof nodes[number]];
  assert.equal(deny.kind, 'PolicyEvent');
  assert.equal(deny.runId, 'run-1');
  assert.equal(deny.properties['toolId'], 'fs.write');
  assert.equal(deny.properties['verdict'], 'Deny');
  assert.match(String(deny.properties['reason']), /secrets are off-limits/);
  assert.equal(deny.properties['ruleId'], 'deny-env');
  assert.equal(deny.properties['role'], 'coder');
  assert.equal(deny.properties['taskId'], 'task-1');
});

// MED-1: a confinement refusal quotes the path it refused and the root it resolved against, and
// this node is read into the evolver planner's prompt — a real model in WP-3.7b. The verifier's case:
// a secret-shaped directory name inside an escaping path, under an absolute project root.
test('a refusal reason is masked at write: no credential and no absolute path reaches the graph', async () => {
  const { engine, nodes } = recordingEngine();
  const secretDir = 'ghp_Zq9Xr2LmN4pQ7sT1vW3yA5bC8dE0fG';
  // `resolveInside` resolves the root, so it has to be a directory that exists.
  const root = await mkdtemp(path.join(tmpdir(), 'maf-policy-root-'));
  try {
    const decision = await engine.evaluate(
      FS_WRITE,
      { path: `../${secretDir}/creds.txt` },
      ctx({ projectRoot: root }),
      [`../${secretDir}/creds.txt`],
    );
    assert.equal(decision.verdict, 'Deny', 'the verdict is unchanged by masking');
    const callerReason = 'reason' in decision ? decision.reason : '';
    assert.match(callerReason, new RegExp(secretDir), 'the caller still gets the reason it must act on');

    const [node] = nodes as [typeof nodes[number]];
    assert.ok(node, 'the denial was recorded');
    const reason = String(node.properties['reason']);
    assert.doesNotMatch(reason, /ghp_/, 'no credential-shaped text is stored');
    assert.match(reason, /\[REDACTED:github-pat\]/, 'the segment is masked, not silently dropped');
    assert.ok(!reason.includes(root), 'the project root does not leak');
    assert.doesNotMatch(reason, /(?:^|\s)"?\/(?!\[REDACTED)/, 'no absolute path remains');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-L3: masking must not blind the planner. A refusal that names a file INSIDE the repository
// keeps the repo-relative name, so a proposal can act on it; the machine's root goes. The engine
// is given the project root, so this is measured at the boundary it writes from.
test('a refusal naming an in-repo file keeps the repo-relative name and drops the root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-policy-inroot-'));
  try {
    const nodes: Parameters<PolicyEventRecorder['addNode']>[0][] = [];
    const engine = new PolicyEngine({} as never, {
      recorder: { addNode: async (node) => { nodes.push(node); return 'n'; } },
    });
    engine.loadRules([{
      id: 'deny-sum', description: '', priority: 100,
      predicate: { toolId: [FS_WRITE] },
      action: { kind: 'Deny', reason: `cannot write ${root}/src/sum.js` },
    }]);

    await engine.evaluate(
      FS_WRITE, { path: path.join(root, 'src', 'sum.js') }, ctx({ projectRoot: root }),
      [path.join(root, 'src', 'sum.js')],
    );

    const [node] = nodes as [typeof nodes[number]];
    assert.ok(node, 'the denial was recorded');
    const reason = String(node.properties['reason']);
    assert.match(reason, /cannot write src\/sum\.js/, `the file is still nameable: ${reason}`);
    assert.ok(!reason.includes(root), 'the project root does not leak');
    assert.ok(!reason.includes('[REDACTED:path]'), 'the path was relativized, not masked away');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an Escalate event carries the rule that escalated it (L3)', async () => {
  const escalate: PolicyRule = {
    id: 'review-lockfiles',
    description: '',
    priority: 100,
    predicate: { toolId: [FS_WRITE], pathGlob: '**/pnpm-lock.yaml' },
    action: { kind: 'Escalate', requiresApproval: true },
  };
  const nodes: Parameters<PolicyEventRecorder['addNode']>[0][] = [];
  const engine = new PolicyEngine({} as never, {
    recorder: { addNode: async (node) => { nodes.push(node); return 'n'; } },
  });
  engine.loadRules([escalate]);

  const decision = await engine.evaluate(
    FS_WRITE, { path: '/tmp/pnpm-lock.yaml' }, ctx(), ['/tmp/pnpm-lock.yaml'],
  );
  assert.equal(decision.verdict, 'Escalate');
  const [node] = nodes as [typeof nodes[number]];
  assert.ok(node);
  assert.equal(node.properties['ruleId'], 'review-lockfiles',
    'the id lives on the approval request; the event must lift it out');
});

test('a golden dispatch names its corpus task on the event (L5)', async () => {
  const { engine, nodes } = recordingEngine();
  await engine.evaluate(
    FS_WRITE, { path: '/tmp/.env' }, ctx({ goldenTaskId: 'coder-sum' }), ['/tmp/.env'],
  );
  const [node] = nodes as [typeof nodes[number]];
  assert.ok(node);
  assert.equal(node.properties['goldenTaskId'], 'coder-sum');
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
