import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ToolPlugin, ToolContext, ToolResult, ToolInput, AttestationBundle } from '@maf/types';
import { makeToolId, makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import { PolicyEngine, PolicyViolationError } from '@maf/policy-engine';
import { Attestor, componentId } from '@maf/attestation';
import { createApprovalGate, confirmationCode } from '@maf/approval-gate';
import { executeToolGated } from '@maf/tool-loop';

// ORACLE: D-02 (WP-2.2) — the real policy engine, approval gate, gatedExec and Attestor together:
// Escalate prompts on the terminal with the request hash, an approval runs the call once, a
// refusal is thrown and attested, headless refuses and leaves a pending record, and every decision
// is in the signed bundle bound to the hash the operator was shown.

/** The real engine with the shipped lock-file rule; the graph is never queried by it. */
function lockFilePolicy(): PolicyEngine {
  const engine = new PolicyEngine({ run: async () => [] } as never);
  engine.loadRules([{
    id: 'protect-lock-files', description: 'lock files need a human', priority: 95,
    predicate: { toolId: [makeToolId('fs.write')], pathGlob: '**/*.lock' },
    action: { kind: 'Escalate', requiresApproval: true },
  }]);
  return engine;
}

function countingTool(): { tool: ToolPlugin; runs: ToolInput[] } {
  const runs: ToolInput[] = [];
  const tool: ToolPlugin = {
    id: makeToolId('fs.write'), name: 'fs.write', description: 'a write the policy escalates', permissionLevel: 'write',
    declaredPaths(input): string[] { return [String(input['path'])]; },
    async execute(input): Promise<ToolResult> {
      runs.push(input);
      return { stdout: `wrote ${String(input['path'])}`, stderr: '', exitCode: 0, duration: 0, metadata: {} };
    },
  };
  return { tool, runs };
}

async function withProject(body: (root: string, attestor: Attestor) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-approval-wired-'));
  try {
    const stubGraph = { addNode: async () => 'node-1' } as never;
    await body(root, new Attestor(makeRunId('r1'), stubGraph, path.join(root, '.maf', 'attestations'), { secret: 'test-secret' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ctxFor = (root: string, attestor: Attestor, policy: PolicyEngine): ToolContext => ({
  cwd: root, projectRoot: root, runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
  sessionId: 's1', agentRole: 'coder', policy, attestor,
});

const bundleOf = (attestor: Attestor): Promise<AttestationBundle> => attestor.bundle(
  { id: 'b@1', modelVersion: 'v' },
  { configSource: { uri: '', digest: { sha256: '' } }, parameters: {}, environment: {} },
  [],
  { status: 'Succeeded', unscheduled: [] },
);

/** Waits for the `nth` prompt on `text` and returns the request id and hash it shows. */
async function nthPrompt(text: () => string, nth: number): Promise<{ requestId: string; requestHash: string }> {
  for (let i = 0; i < 1000 && (text().match(/approve> /g)?.length ?? 0) < nth; i++) await new Promise((r) => setImmediate(r));
  const prompt = [...text().matchAll(/request: (\S+)\n {2}hash:\s+sha256:([0-9a-f]{64})/g)][nth - 1];
  assert.ok(prompt?.[1] && prompt[2], `prompt ${nth} shows a request id and hash`);
  return { requestId: prompt[1], requestHash: prompt[2] };
}

test('on a terminal: the operator approves one call by its hash, refuses the next, and the bundle holds both', async () => {
  await withProject(async (root, attestor) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8'); });
    const approvalGate = createApprovalGate({
      recorder: attestor, mafDir: path.join(root, '.maf'), terminal: { input, output, isTTY: true }, env: {},
    });
    const policy = lockFilePolicy();
    const deps = { policy, attestor, approvalGate };
    const { tool, runs } = countingTool();

    const first = executeToolGated(tool, { path: 'yarn.lock', content: 'a' }, ctxFor(root, attestor, policy), deps);
    const firstPrompt = await nthPrompt(() => shown, 1);
    assert.match(shown, /tool:\s+"fs\.write"/);
    assert.match(shown, /paths:\s+"yarn\.lock"/);
    assert.equal(runs.length, 0, 'nothing runs while the operator reads');
    input.write(`${confirmationCode(firstPrompt)}\n`);
    assert.equal((await first).stdout, 'wrote yarn.lock');

    const second = executeToolGated(tool, { path: 'yarn.lock', content: 'a' }, ctxFor(root, attestor, policy), deps);
    const secondPrompt = await nthPrompt(() => shown, 2);
    assert.equal(secondPrompt.requestHash, firstPrompt.requestHash, 'the same call hashes the same; it is still asked again');
    input.write('n\n');
    await assert.rejects(second, (err: unknown) => err instanceof PolicyViolationError && err.decision.verdict === 'Escalate');
    assert.equal(runs.length, 1, 'the approval ran the call once');

    const bundle = await bundleOf(attestor);
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true);
    const [ran, refused] = bundle.toolCalls;
    assert.ok(ran && refused);
    assert.equal(ran.result.metadata['refused'], undefined);
    assert.equal(refused.result.metadata['refused'], true);
    assert.equal(refused.result.metadata['approval'], 'Rejected');
    assert.deepEqual(bundle.approvals.map((a) => a.decision.status), ['Approved', 'Rejected']);
    const requestIdOf = (call: typeof ran): string | undefined =>
      call.policyDecision.verdict === 'Escalate' ? call.policyDecision.approvalRequest.id : undefined;
    assert.equal(bundle.approvals[0]?.requestId, requestIdOf(ran), 'each decision names the call it decided');
    assert.equal(bundle.approvals[1]?.requestId, requestIdOf(refused));
    assert.equal(bundle.approvals[0]?.diffHash, firstPrompt.requestHash, 'bound to the hash the operator was shown');
    assert.equal(bundle.approvals[0]?.requestId, firstPrompt.requestId);
    // The gate names itself by the version it shipped as (D-13), never a literal.
    const builder = (JSON.parse(bundle.approvals[0]?.intotoStmt ?? '{}') as { predicate?: { builder?: { id?: unknown } } }).predicate?.builder?.id;
    assert.equal(builder, componentId('maf-approval-gate'));
    assert.match(String(builder), /^maf-approval-gate@\d+\.\d+\.\d+/);
  });
});

test('headless: refused without a prompt, a pending record written, the refusal and the decision attested', async () => {
  await withProject(async (root, attestor) => {
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8'); });
    const approvalGate = createApprovalGate({
      recorder: attestor, mafDir: path.join(root, '.maf'),
      terminal: { input: new PassThrough(), output, isTTY: false }, env: {},
    });
    const policy = lockFilePolicy();
    const { tool, runs } = countingTool();

    await assert.rejects(
      executeToolGated(tool, { path: 'yarn.lock', content: 'a' }, ctxFor(root, attestor, policy), { policy, attestor, approvalGate }),
      PolicyViolationError,
    );

    assert.equal(runs.length, 0);
    assert.equal(shown, '', 'no prompt');
    const bundle = await bundleOf(attestor);
    const decision = bundle.toolCalls[0]?.policyDecision;
    assert.ok(decision?.verdict === 'Escalate');
    const id = decision.approvalRequest.id;
    const pending = JSON.parse(await readFile(path.join(root, '.maf', 'approvals', 'pending', `${id}.json`), 'utf8')) as {
      requestHash: string; reason: string;
    };
    assert.match(pending.reason, /stdin is not a terminal/);
    assert.equal(bundle.approvals[0]?.requestId, id);
    assert.equal(bundle.approvals[0]?.decision.reviewer, 'headless');
    assert.equal(bundle.approvals[0]?.diffHash, pending.requestHash);
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true);
  });
});
