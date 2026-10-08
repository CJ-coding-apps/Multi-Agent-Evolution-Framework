import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApprovalAsk, ReviewAttestation } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { Attestor } from '@maf/attestation';
import { ApprovalGate, DEFAULT_APPROVAL_TIMEOUT_MS } from '../ApprovalGate.js';
import type { ApprovalProvider, PendingApproval, ProviderAnswer } from '../ApprovalGate.js';
import type { ApprovalSink } from '../AttestationRecorder.js';
import { approvalRequestHash } from '../requestHash.js';

// ORACLE: D-02 — a decision is bound to the request's hash and to its id, an id is good for one
// decision, no answer in time is a refusal that clears the slot, and every decision is attested.

class SpySink implements ApprovalSink {
  approvals: ReviewAttestation[] = [];
  addApproval(attestation: ReviewAttestation): void { this.approvals.push(attestation); }
}

/** A provider answering by `script`, keeping every request it was shown and the signal it got. */
function scripted(script: (pending: PendingApproval, signal: AbortSignal) => Promise<ProviderAnswer> | ProviderAnswer): {
  provider: ApprovalProvider; asked: PendingApproval[]; signals: AbortSignal[];
} {
  const asked: PendingApproval[] = [];
  const signals: AbortSignal[] = [];
  return {
    asked, signals,
    provider: {
      async ask(pending, signal) { asked.push(pending); signals.push(signal); return script(pending, signal); },
    },
  };
}

const answer = (pending: PendingApproval, approved: boolean, over: Partial<ProviderAnswer> = {}): ProviderAnswer => ({
  requestId: pending.requestId, requestHash: pending.requestHash, approved, reviewer: 'alice', reason: 'looked at it', ...over,
});

const ask = (id = 'req-1', input: Record<string, unknown> = { path: 'yarn.lock', content: 'x' }): ApprovalAsk => ({
  request: {
    id, runId: makeRunId('r1'), taskId: makeTaskId('t1'), requestedBy: makeAgentId('a1'),
    toolId: makeToolId('fs.write'), policyRuleId: 'protect-lock-files', description: 'needs a human', createdAt: new Date(),
  },
  toolId: makeToolId('fs.write'),
  input,
  declaredPaths: ['yarn.lock'],
});

/** A promise and the function that settles it, for a provider that answers when the test says. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test('an approval for the request, carrying its hash, approves it and is attested with that hash', async () => {
  const sink = new SpySink();
  const { provider, asked } = scripted((p) => answer(p, true));
  const gate = new ApprovalGate({ provider, recorder: sink });
  const request = ask();

  const outcome = await gate.decide(request);

  const hash = approvalRequestHash(request);
  assert.deepEqual(
    { approved: outcome.approved, status: outcome.status, requestId: outcome.requestId, requestHash: outcome.requestHash },
    { approved: true, status: 'Approved', requestId: 'req-1', requestHash: hash },
  );
  assert.equal(asked[0]?.requestHash, hash, 'the provider was shown the hash it must answer with');
  assert.deepEqual(asked[0]?.declaredPaths, ['yarn.lock']);
  assert.equal(asked[0]?.toolId, 'fs.write');
  assert.equal(asked[0]?.timeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS);
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 120_000, 'the default timeout is 120 s');

  assert.equal(sink.approvals.length, 1);
  const recorded = sink.approvals[0];
  assert.ok(recorded);
  assert.equal(recorded.requestId, 'req-1');
  assert.equal(recorded.decision.status, 'Approved');
  assert.equal(recorded.decision.reviewer, 'alice');
  assert.equal(recorded.diffHash, hash, 'the attestation carries the hash the decision was bound to');
  const statement = JSON.parse(recorded.intotoStmt) as { subject: Array<{ digest: { sha256: string } }> };
  assert.equal(statement.subject[0]?.digest.sha256, hash);
  assert.deepEqual(gate.pendingIds(), []);
});

test('a decision whose hash does not match the request is refused, and attested as refused', async () => {
  const sink = new SpySink();
  const forged = 'f'.repeat(64);
  const { provider } = scripted((p) => answer(p, true, { requestHash: forged }));
  const gate = new ApprovalGate({ provider, recorder: sink });

  const outcome = await gate.decide(ask());

  assert.equal(outcome.approved, false);
  assert.equal(outcome.status, 'Rejected');
  assert.match(outcome.reason, new RegExp(`bound to hash ${forged} but the request hashes to ${outcome.requestHash}`));
  assert.equal(sink.approvals[0]?.decision.status, 'Rejected');
});

test('an input that changes while the human is deciding is refused: they did not decide on this one', async () => {
  const sink = new SpySink();
  const input: Record<string, unknown> = { path: 'yarn.lock', content: 'x' };
  const { provider } = scripted((p) => { input['content'] = 'swapped'; return answer(p, true); });
  const gate = new ApprovalGate({ provider, recorder: sink });

  const outcome = await gate.decide(ask('req-1', input));

  assert.equal(outcome.approved, false);
  assert.match(outcome.reason, /the request hashes to/);
});

test('a request id is good for one decision: reusing it is refused without asking anyone', async () => {
  const sink = new SpySink();
  const { provider, asked } = scripted((p) => answer(p, true));
  const gate = new ApprovalGate({ provider, recorder: sink });

  assert.equal((await gate.decide(ask('req-1'))).approved, true);
  const reused = await gate.decide(ask('req-1'));

  assert.equal(reused.approved, false);
  assert.match(reused.reason, /request id "req-1" was already used/);
  assert.equal(asked.length, 1, 'nobody was asked the second time');
  assert.deepEqual(sink.approvals.map((a) => a.decision.status), ['Approved', 'Rejected'], 'both decisions are attested');
});

test('a request id still pending cannot be asked about a second time', async () => {
  const sink = new SpySink();
  const later = deferred<boolean>();
  const { provider, asked } = scripted(async (p) => answer(p, await later.promise));
  const gate = new ApprovalGate({ provider, recorder: sink });

  const first = gate.decide(ask('req-1'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(gate.pendingIds(), ['req-1']);

  const second = await gate.decide(ask('req-1'));
  assert.equal(second.approved, false, 'refused while the first is still waiting');
  later.resolve(true);
  assert.equal((await first).approved, true, 'and the first is unaffected');
  assert.equal(asked.length, 1);
});

test('a decision replayed from an earlier request is refused', async () => {
  const sink = new SpySink();
  let firstAnswer: ProviderAnswer | undefined;
  const { provider } = scripted((p) => {
    firstAnswer ??= answer(p, true);
    return firstAnswer; // the same approval, offered again for the next request
  });
  const gate = new ApprovalGate({ provider, recorder: sink });

  assert.equal((await gate.decide(ask('req-1'))).approved, true);
  const replayed = await gate.decide(ask('req-2'));

  assert.equal(replayed.approved, false);
  assert.match(replayed.reason, /the decision is for request "req-1", an id already used, not "req-2"/);
  assert.deepEqual(sink.approvals.map((a) => [a.requestId, a.decision.status]), [['req-1', 'Approved'], ['req-2', 'Rejected']]);
});

test('an id that is not a file-name-safe token is refused before anyone is asked', async () => {
  for (const id of ['', '../../etc/passwd', '.hidden', 'a/b', 'a\\b', 'x'.repeat(129), 'line\nbreak']) {
    const sink = new SpySink();
    const { provider, asked } = scripted((p) => answer(p, true));
    const outcome = await new ApprovalGate({ provider, recorder: sink }).decide(ask(id));
    assert.equal(outcome.approved, false, JSON.stringify(id));
    assert.match(outcome.reason, /is not usable/);
    assert.equal(asked.length, 0);
    assert.equal(sink.approvals.length, 1, 'the refusal is attested');
  }
});

test('a request that names a different tool from the call is refused', async () => {
  const sink = new SpySink();
  const { provider, asked } = scripted((p) => answer(p, true));
  const mismatched = { ...ask(), toolId: makeToolId('fs.delete') };

  const outcome = await new ApprovalGate({ provider, recorder: sink }).decide(mismatched);

  assert.equal(outcome.approved, false);
  assert.match(outcome.reason, /names tool "fs.write" but the call is to "fs.delete"/);
  assert.equal(asked.length, 0);
});

test('a request that cannot be hashed is refused and attested, not thrown', async () => {
  const notAList = { ...ask('req-2'), declaredPaths: 'yarn.lock' } as unknown as ApprovalAsk;
  for (const unhashable of [ask('req-1', { size: Number.NaN }), notAList]) {
    const sink = new SpySink();
    const { provider, asked } = scripted((p) => answer(p, true));

    const outcome = await new ApprovalGate({ provider, recorder: sink }).decide(unhashable);

    assert.equal(outcome.approved, false);
    assert.match(outcome.reason, /cannot be bound to a hash/);
    assert.equal(asked.length, 0);
    assert.equal(sink.approvals[0]?.decision.status, 'Rejected');
  }
});

test('timeout: no answer in time is TimedOut, attested, the slot cleared and the provider told to stop', async () => {
  const sink = new SpySink();
  const { provider, signals } = scripted(() => new Promise<ProviderAnswer>(() => undefined));
  const gate = new ApprovalGate({ provider, recorder: sink, timeoutMs: 25 });

  const decided = gate.decide(ask('req-1'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(gate.pendingIds(), ['req-1'], 'pending while it waits');
  const outcome = await decided;

  assert.equal(outcome.approved, false);
  assert.equal(outcome.status, 'TimedOut');
  assert.match(outcome.reason, /no decision within 25 ms/);
  assert.deepEqual(gate.pendingIds(), [], 'the slot is cleared');
  assert.equal(signals[0]?.aborted, true, 'the provider was told to stop listening');
  assert.equal(sink.approvals[0]?.decision.status, 'TimedOut');
  assert.equal((await gate.decide(ask('req-1'))).approved, false, 'and the timed-out id cannot be asked again');
});

test('a timeout the timer cannot honour is refused when the gate is built', () => {
  const { provider } = scripted((p) => answer(p, true));
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
    assert.throws(() => new ApprovalGate({ provider, recorder: new SpySink(), timeoutMs }), RangeError, String(timeoutMs));
  }
});

test('a provider that fails, or answers anything but approved: true, has not approved', async () => {
  const scripts: Array<(p: PendingApproval) => Promise<ProviderAnswer> | ProviderAnswer> = [
    () => { throw new Error('terminal gone'); },
    () => Promise.reject(new Error('terminal gone')),
    (p) => ({ ...answer(p, false), approved: 'yes' } as unknown as ProviderAnswer),
    (p) => ({ ...answer(p, false), approved: 1 } as unknown as ProviderAnswer),
    (p) => answer(p, false),
  ];
  for (const script of scripts) {
    const sink = new SpySink();
    const outcome = await new ApprovalGate({ provider: scripted(script).provider, recorder: sink }).decide(ask());
    assert.equal(outcome.approved, false);
    assert.equal(outcome.status, 'Rejected');
    assert.equal(sink.approvals.length, 1);
  }
});

test('every decision reaches a real Attestor bundle as a ReviewAttestation, and the bundle verifies', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-approval-bundle-'));
  try {
    const stubGraph = { addNode: async () => 'node-1' } as never;
    const attestor = new Attestor(makeRunId('r1'), stubGraph, dir, { secret: 'test-secret' });
    let calls = 0;
    const { provider } = scripted((p) => {
      calls++;
      if (calls === 3) return new Promise<ProviderAnswer>(() => undefined);
      return answer(p, calls === 1);
    });
    const gate = new ApprovalGate({ provider, recorder: attestor, timeoutMs: 25 });

    await gate.decide(ask('req-1'));
    await gate.decide(ask('req-2'));
    await gate.decide(ask('req-3'));

    const bundle = await attestor.bundle(
      { id: 'b@1', modelVersion: 'v' },
      { configSource: { uri: '', digest: { sha256: '' } }, parameters: {}, environment: {} },
      [],
      { status: 'Succeeded', unscheduled: [] },
    );
    assert.deepEqual(bundle.approvals.map((a) => [a.requestId, a.decision.status]),
      [['req-1', 'Approved'], ['req-2', 'Rejected'], ['req-3', 'TimedOut']]);
    assert.equal(Attestor.verify(bundle, { secret: 'test-secret' }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
