import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ToolPlugin, ToolContext, ToolResult, ToolCallRecord, ApprovalRequest,
  PolicyDecision, PolicyEngineHandle, AttestorHandle,
} from '@maf/types';
import { makeToolId, makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import { PolicyViolationError } from '@maf/policy-engine';
import { Attestor } from '@maf/attestation';
import { executeToolGated } from '../index.js';

// ORACLE: D-13 + audit P0 #12 — every refused call is attested, before the refusal is thrown, and
// only `Allow` runs a tool.

class SpyAttestor implements AttestorHandle {
  records: Array<Omit<ToolCallRecord, 'id'>> = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> { this.records.push(call); }
}

const answering = (decision: PolicyDecision): PolicyEngineHandle => ({
  async evaluate(): Promise<PolicyDecision> { return decision; },
});

/** A tool that counts its own executions, so "it did not run" is observed rather than assumed. */
function countingTool(): { tool: ToolPlugin; runs: () => number } {
  let runs = 0;
  const tool: ToolPlugin = {
    id: makeToolId('fs.write'),
    name: 'fs.write',
    description: 'stands in for a write the policy is asked about',
    permissionLevel: 'write',
    declaredPaths(): string[] { return ['src/a.ts']; },
    async execute(): Promise<ToolResult> {
      runs++;
      return { stdout: 'wrote src/a.ts', stderr: '', exitCode: 0, duration: 0, metadata: {} };
    },
  };
  return { tool, runs: () => runs };
}

const ctxWith = (attestor: AttestorHandle, policy: PolicyEngineHandle): ToolContext => ({
  cwd: tmpdir(),
  projectRoot: tmpdir(),
  runId: makeRunId('r1'),
  taskId: makeTaskId('t1'),
  agentId: makeAgentId('a1'),
  sessionId: 's1',
  policy,
  attestor,
});

const approvalRequest = (policyRuleId: string): ApprovalRequest => ({
  id: 'req-1',
  runId: makeRunId('r1'),
  taskId: makeTaskId('t1'),
  requestedBy: makeAgentId('a1'),
  toolId: makeToolId('fs.write'),
  policyRuleId,
  description: 'needs a human',
  createdAt: new Date(),
});

const refusals: Array<{ decision: PolicyDecision; ruleId: string | undefined }> = [
  { decision: { verdict: 'Deny', reason: 'writes are off', ruleId: 'deny-env-files' }, ruleId: 'deny-env-files' },
  // A Deny the engine reached without a rule (a path outside the root) has no id to record.
  { decision: { verdict: 'Deny', reason: 'path escapes the project root' }, ruleId: undefined },
  {
    decision: { verdict: 'Escalate', reason: 'Policy requires approval', approvalRequest: approvalRequest('protect-lock-files') },
    ruleId: 'protect-lock-files',
  },
  {
    decision: { verdict: 'Indeterminate', reason: 'graph unavailable', ruleId: 'deny-after-failures' },
    ruleId: 'deny-after-failures',
  },
];

for (const { decision, ruleId } of refusals) {
  test(`${decision.verdict}: the call is attested with its verdict${ruleId ? ' and rule id' : ''} before PolicyViolationError, and does not run`, async () => {
    const attestor = new SpyAttestor();
    const policy = answering(decision);
    const { tool, runs } = countingTool();
    let recordedWhenThrown = -1;

    await assert.rejects(
      async () => {
        try {
          await executeToolGated(tool, { path: 'src/a.ts', content: 'x' }, ctxWith(attestor, policy), { policy, attestor });
        } catch (err) {
          // Code after a throw never runs, so a record present here was made before it.
          recordedWhenThrown = attestor.records.length;
          throw err;
        }
      },
      (err: unknown) => err instanceof PolicyViolationError && err.decision.verdict === decision.verdict,
    );

    assert.equal(runs(), 0, 'the tool never executed');
    assert.equal(recordedWhenThrown, 1, 'the refusal was recorded before the error reached the caller');
    const record = attestor.records[0];
    assert.ok(record, 'the refused call is in the attestation');
    assert.equal(record.toolId, 'fs.write');
    assert.deepEqual(record.policyDecision, decision, 'the decision is recorded as the policy gave it');
    assert.equal(record.result.metadata['refused'], true, 'marked refused, not a call that ran and failed');
    assert.equal(record.result.metadata['ruleId'], ruleId);
    assert.equal('ruleId' in record.result.metadata, ruleId !== undefined, 'no rule id is invented');
    assert.equal(record.result.stdout, '', 'a refused call produced no output');
    assert.notEqual(record.result.exitCode, 0);
  });
}

test('allow-list: a verdict kind gatedExec has never heard of refuses, and is attested', async () => {
  // Under the old deny-list this matched none of Deny/Escalate/Indeterminate and executed.
  const unknown = { verdict: 'Defer', reason: 'a verdict from a newer policy engine' } as unknown as PolicyDecision;
  const attestor = new SpyAttestor();
  const policy = answering(unknown);
  const { tool, runs } = countingTool();

  await assert.rejects(
    () => executeToolGated(tool, { path: 'src/a.ts', content: 'x' }, ctxWith(attestor, policy), { policy, attestor }),
    PolicyViolationError,
  );

  assert.equal(runs(), 0, 'only Allow runs a tool');
  assert.equal(attestor.records.length, 1);
  assert.equal(attestor.records[0]?.policyDecision.verdict, 'Defer');
  assert.equal(attestor.records[0]?.result.metadata['refused'], true);
});

test('an allowed call still executes and is attested as today, with no refusal marker', async () => {
  const attestor = new SpyAttestor();
  const policy = answering({ verdict: 'Allow' });
  const { tool, runs } = countingTool();

  const result = await executeToolGated(tool, { path: 'src/a.ts', content: 'x' }, ctxWith(attestor, policy), { policy, attestor });

  assert.equal(runs(), 1);
  assert.equal(result.stdout, 'wrote src/a.ts');
  assert.equal(attestor.records.length, 1);
  assert.equal(attestor.records[0]?.policyDecision.verdict, 'Allow');
  assert.equal(attestor.records[0]?.result.stdout, 'wrote src/a.ts');
  assert.equal(attestor.records[0]?.result.metadata['refused'], undefined);
});

test('a refused call reaches the signed bundle of a real Attestor, which still verifies', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-refusal-bundle-'));
  try {
    // Only record() touches the graph, and only through addNode.
    const stubGraph = { addNode: async () => 'node-1' } as never;
    const attestor = new Attestor(makeRunId('r1'), stubGraph, dir, { secret: 'test-secret' });
    const deny = answering({ verdict: 'Deny', reason: 'writes are off' });
    const allow = answering({ verdict: 'Allow' });
    const { tool } = countingTool();

    await assert.rejects(
      () => executeToolGated(tool, { path: 'src/a.ts', content: 'x' }, ctxWith(attestor, deny), { policy: deny, attestor }),
      PolicyViolationError,
    );
    await executeToolGated(tool, { path: 'src/a.ts', content: 'x' }, ctxWith(attestor, allow), { policy: allow, attestor });

    const bundle = await attestor.bundle(
      { id: 'b@1', modelVersion: 'v' },
      { configSource: { uri: '', digest: { sha256: '' } }, parameters: {}, environment: {} },
      [],
      { status: 'Succeeded', unscheduled: [] },
    );

    assert.deepEqual(bundle.toolCalls.map((c) => c.policyDecision.verdict), ['Deny', 'Allow'],
      'the refusal and the executed call are both in the bundle, in order');
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
