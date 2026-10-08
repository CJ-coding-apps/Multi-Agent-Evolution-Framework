import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type {
  ToolPlugin, ToolContext, ToolResult, ToolCallRecord, ToolInput, ApprovalRequest, ApprovalAsk,
  ApprovalGateHandle, ApprovalOutcome, PolicyDecision, PolicyEngineHandle, AttestorHandle,
} from '@maf/types';
import { makeToolId, makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import { PolicyViolationError } from '@maf/policy-engine';
import { executeToolGated } from '../index.js';

// ORACLE: D-02 — with an approval gate, `Escalate` asks it: an approval runs the call once, a
// refusal is attested and thrown as PolicyViolationError. Only Escalate is a question for a human.

class SpyAttestor implements AttestorHandle {
  records: Array<Omit<ToolCallRecord, 'id'>> = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> { this.records.push(call); }
}

/** A gate answering by `decide`, keeping every ask it was given. */
function gateAnswering(decide: (ask: ApprovalAsk, n: number) => Partial<ApprovalOutcome>): {
  gate: ApprovalGateHandle; asks: ApprovalAsk[];
} {
  const asks: ApprovalAsk[] = [];
  return {
    asks,
    gate: {
      async decide(ask: ApprovalAsk): Promise<ApprovalOutcome> {
        asks.push(ask);
        return {
          approved: false, status: 'Rejected', requestId: ask.request.id, requestHash: 'h'.repeat(64),
          reason: 'refused at the terminal', ...decide(ask, asks.length),
        };
      },
    },
  };
}

const approveFirstOnly = (_ask: ApprovalAsk, n: number): Partial<ApprovalOutcome> =>
  n === 1 ? { approved: true, status: 'Approved', reason: 'approved at the terminal' } : {};

let nextId = 0;
const request = (): ApprovalRequest => ({
  id: `req-${++nextId}`, runId: makeRunId('r1'), taskId: makeTaskId('t1'), requestedBy: makeAgentId('a1'),
  toolId: makeToolId('fs.write'), policyRuleId: 'protect-lock-files', description: 'needs a human', createdAt: new Date(),
});

/** Escalates every call with a fresh request, as the policy engine does. */
const escalating = (): PolicyEngineHandle => ({
  async evaluate(): Promise<PolicyDecision> {
    return { verdict: 'Escalate', reason: 'Policy requires approval', approvalRequest: request() };
  },
});

const answering = (decision: PolicyDecision): PolicyEngineHandle => ({
  async evaluate(): Promise<PolicyDecision> { return decision; },
});

function countingTool(): { tool: ToolPlugin; inputs: ToolInput[] } {
  const inputs: ToolInput[] = [];
  const tool: ToolPlugin = {
    id: makeToolId('fs.write'),
    name: 'fs.write',
    description: 'stands in for a write to a lock file',
    permissionLevel: 'write',
    declaredPaths(input): string[] { return [String(input['path'])]; },
    async execute(input): Promise<ToolResult> {
      inputs.push(input);
      return { stdout: 'wrote yarn.lock', stderr: '', exitCode: 0, duration: 0, metadata: {} };
    },
  };
  return { tool, inputs };
}

const ctxWith = (attestor: AttestorHandle, policy: PolicyEngineHandle): ToolContext => ({
  cwd: tmpdir(), projectRoot: tmpdir(), runId: makeRunId('r1'), taskId: makeTaskId('t1'),
  agentId: makeAgentId('a1'), sessionId: 's1', policy, attestor,
});

test('Escalate with a gate that approves: the call runs once, on the input the gate was shown', async () => {
  const attestor = new SpyAttestor();
  const policy = escalating();
  const { gate, asks } = gateAnswering(approveFirstOnly);
  const { tool, inputs } = countingTool();
  const input = { path: 'yarn.lock', content: 'x' };

  const result = await executeToolGated(tool, input, ctxWith(attestor, policy), { policy, attestor, approvalGate: gate });

  assert.equal(result.stdout, 'wrote yarn.lock');
  assert.equal(inputs.length, 1, 'executed exactly once');
  assert.equal(asks.length, 1);
  const shown = asks[0];
  assert.ok(shown);
  assert.equal(shown.toolId, 'fs.write');
  assert.equal(shown.input, inputs[0], 'the gate saw the very object the tool ran on');
  assert.ok(Object.isFrozen(shown.input), 'frozen, so what was approved is what runs');
  assert.deepEqual(shown.declaredPaths, ['yarn.lock']);
  assert.equal(shown.request.policyRuleId, 'protect-lock-files');

  assert.equal(attestor.records.length, 1);
  assert.equal(attestor.records[0]?.policyDecision.verdict, 'Escalate', 'the policy verdict is recorded as given');
  assert.equal(attestor.records[0]?.result.metadata['refused'], undefined, 'it ran: no refusal marker');
});

test('an approval is good for one call: the next identical call asks again, and is refused when refused', async () => {
  const attestor = new SpyAttestor();
  const policy = escalating();
  const { gate, asks } = gateAnswering(approveFirstOnly);
  const { tool, inputs } = countingTool();
  const deps = { policy, attestor, approvalGate: gate };

  await executeToolGated(tool, { path: 'yarn.lock', content: 'x' }, ctxWith(attestor, policy), deps);
  await assert.rejects(
    () => executeToolGated(tool, { path: 'yarn.lock', content: 'x' }, ctxWith(attestor, policy), deps),
    PolicyViolationError,
  );

  assert.equal(asks.length, 2, 'asked twice: no approval is cached');
  assert.notEqual(asks[0]?.request.id, asks[1]?.request.id);
  assert.equal(inputs.length, 1, 'ran once');
});

test('Escalate with a gate that refuses: PolicyViolationError, the tool never runs, the refusal is attested first', async () => {
  const attestor = new SpyAttestor();
  const policy = escalating();
  const { gate } = gateAnswering(() => ({ status: 'TimedOut', reason: 'no decision within 120000 ms, so the call is refused' }));
  const { tool, inputs } = countingTool();
  let recordedWhenThrown = -1;

  await assert.rejects(
    async () => {
      try {
        await executeToolGated(tool, { path: 'yarn.lock', content: 'x' }, ctxWith(attestor, policy), { policy, attestor, approvalGate: gate });
      } catch (err) {
        recordedWhenThrown = attestor.records.length;
        throw err;
      }
    },
    (err: unknown) => err instanceof PolicyViolationError && err.decision.verdict === 'Escalate',
  );

  assert.equal(inputs.length, 0);
  assert.equal(recordedWhenThrown, 1);
  const record = attestor.records[0];
  assert.ok(record);
  assert.equal(record.result.metadata['refused'], true);
  assert.equal(record.result.metadata['ruleId'], 'protect-lock-files');
  assert.equal(record.result.metadata['approval'], 'TimedOut', 'the refusal says what the gate decided');
  assert.match(record.result.stderr, /^policy Escalate: Policy requires approval — approval TimedOut: no decision within/);
});

test('an outcome that is not for this request, or not strictly approved, does not run the call', async () => {
  const outcomes: Array<Partial<ApprovalOutcome>> = [
    { approved: true, status: 'Approved', requestId: 'some-other-request' },
    { approved: 'yes', status: 'Approved' } as unknown as Partial<ApprovalOutcome>,
    { approved: 1, status: 'Approved' } as unknown as Partial<ApprovalOutcome>,
  ];
  for (const outcome of outcomes) {
    const attestor = new SpyAttestor();
    const policy = escalating();
    const { gate } = gateAnswering(() => outcome);
    const { tool, inputs } = countingTool();

    await assert.rejects(
      () => executeToolGated(tool, { path: 'yarn.lock', content: 'x' }, ctxWith(attestor, policy), { policy, attestor, approvalGate: gate }),
      PolicyViolationError,
      JSON.stringify(outcome),
    );
    assert.equal(inputs.length, 0, JSON.stringify(outcome));
    assert.equal(attestor.records[0]?.result.metadata['refused'], true);
  }
});

test('Deny and Indeterminate never reach the gate: they are not questions for a human', async () => {
  for (const decision of [
    { verdict: 'Deny', reason: 'writes are off', ruleId: 'deny-env-files' },
    { verdict: 'Indeterminate', reason: 'graph unavailable', ruleId: 'deny-after-failures' },
  ] as const) {
    const attestor = new SpyAttestor();
    const policy = answering(decision);
    const { gate, asks } = gateAnswering(() => ({ approved: true, status: 'Approved' }));
    const { tool, inputs } = countingTool();

    await assert.rejects(
      () => executeToolGated(tool, { path: 'yarn.lock', content: 'x' }, ctxWith(attestor, policy), { policy, attestor, approvalGate: gate }),
      PolicyViolationError,
    );
    assert.equal(asks.length, 0, decision.verdict);
    assert.equal(inputs.length, 0);
    assert.equal(attestor.records[0]?.result.metadata['approval'], undefined);
  }
});

test('without a gate, Escalate is refused as before, and the refusal carries no approval status', async () => {
  const attestor = new SpyAttestor();
  const policy = escalating();
  const { tool, inputs } = countingTool();

  await assert.rejects(
    () => executeToolGated(tool, { path: 'yarn.lock', content: 'x' }, ctxWith(attestor, policy), { policy, attestor, approvalGate: undefined }),
    PolicyViolationError,
  );
  assert.equal(inputs.length, 0);
  assert.equal('approval' in (attestor.records[0]?.result.metadata ?? {}), false);
  assert.equal(attestor.records[0]?.result.stderr, 'policy Escalate: Policy requires approval');
});
