import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeNodeId, makeRunId, GateRefused, ReviewRefused, TransportError, VerdictError } from '@maf/types';
import { ReviewGate } from '../ReviewGate.js';
import type { ReviewDecision, ReviewRequest, ReviewSubject, Reviewer } from '../ReviewGate.js';

// ORACLE: WP-2.3 — the human review gate takes the diff itself, and only an approval from a
// named reviewer is an approval. A denial, silence past the timeout, a reviewer that fails and an
// answer that is not a decision are all non-approvals, and a required gate turns each into a
// ReviewRefused verdict. The gate this replaces read the diff itself and approved when it could
// not (`harvest(...).catch(() => '')` then "No changes to review").

const DIFF = 'diff --git a/hello.txt b/hello.txt\n-hello\n+hello, changed\n';
const BASE = 'a'.repeat(40);

const SUBJECT: ReviewSubject = {
  runId: makeRunId('run-review'), nodeId: makeNodeId('c1'), role: 'coder', baseCommit: BASE, diff: DIFF,
};

/** A reviewer that answers `decision` and keeps every request it was asked. */
function answering(decision: unknown, asked: ReviewRequest[] = []): Reviewer {
  return async (request) => {
    asked.push(request);
    return decision as ReviewDecision;
  };
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

test('an approval from a named reviewer is recorded against the whole diff, its hash and its base', async () => {
  const asked: ReviewRequest[] = [];
  // The default timeout is ten minutes: if the gate left its timer running, this file would
  // hold the test process open that long.
  const gate = new ReviewGate({ reviewer: answering({ verdict: 'Approve', reviewer: 'alice', comment: 'fine' }, asked) });
  const outcome = await gate.review(SUBJECT);

  assert.equal(asked.length, 1);
  const request = asked[0];
  assert.ok(request);
  assert.equal(request.diff, DIFF, 'the reviewer sees the whole diff');
  assert.equal(request.diffHash, sha256(DIFF));
  assert.equal(request.baseCommit, BASE);
  assert.equal(request.nodeId, SUBJECT.nodeId);
  assert.equal(request.required, false, 'advisory by default');
  assert.equal(request.expiresAt.getTime() - request.requestedAt.getTime(), 10 * 60_000);

  assert.equal(outcome.decision.status, 'Approved');
  assert.equal(outcome.decision.reviewer, 'alice');
  assert.equal(outcome.decision.comment, 'fine');
  assert.equal(outcome.decision.requestId, request.id);
  assert.equal(outcome.refusal, undefined);

  const att = outcome.attestation;
  assert.equal(att.requestId, request.id);
  assert.equal(att.diffHash, sha256(DIFF));
  assert.equal(att.commitHash, BASE);
  assert.deepEqual(att.decision, outcome.decision);
  const stmt = JSON.parse(att.intotoStmt) as {
    _type: string; subject: Array<{ digest: { sha256: string } }>;
    predicate: { status: string; reviewer: string; requestId: string; required: boolean };
  };
  assert.equal(stmt._type, 'https://in-toto.io/Statement/v0.1');
  assert.equal(stmt.subject[0]?.digest.sha256, sha256(DIFF), 'the statement names the diff it decided on');
  assert.equal(stmt.predicate.status, 'Approved');
  assert.equal(stmt.predicate.reviewer, 'alice');
  assert.equal(stmt.predicate.requestId, request.id);
});

test('required: a denial is a ReviewRefused verdict naming the reviewer and the reason', async () => {
  const gate = new ReviewGate({
    reviewer: answering({ verdict: 'Deny', reviewer: 'bob', comment: 'deletes the tests' }), required: true,
  });
  const outcome = await gate.review(SUBJECT);
  assert.equal(outcome.decision.status, 'Rejected');
  const refusal = outcome.refusal;
  assert.ok(refusal instanceof ReviewRefused, 'a required denial carries the refusal');
  // A verdict, never a transport failure: the scheduler must not retry it (D-06), and the
  // dispatcher must not review the diff again on the way out of a failing backend.
  assert.ok(refusal instanceof GateRefused);
  assert.ok(refusal instanceof VerdictError);
  assert.ok(!(refusal instanceof TransportError));
  assert.equal(refusal.requestId, outcome.request.id);
  assert.deepEqual(refusal.findings, []);
  assert.match(refusal.message, /node c1: bob denied it \(deletes the tests\)\. The review gate is required/);
});

test('advisory: a denial is recorded and refuses nothing', async () => {
  const gate = new ReviewGate({ reviewer: answering({ verdict: 'Deny', reviewer: 'bob' }) });
  const outcome = await gate.review(SUBJECT);
  assert.equal(outcome.decision.status, 'Rejected');
  assert.equal(outcome.attestation.decision.status, 'Rejected', 'the denial is in the record');
  assert.equal(outcome.refusal, undefined, 'and the node is not failed for it');
});

test('required: a reviewer that never answers times out, the request is withdrawn, and the change is refused', async () => {
  let signal: AbortSignal | undefined;
  const gate = new ReviewGate({
    reviewer: (_request, s) => { signal = s; return new Promise<ReviewDecision>(() => {}); },
    required: true,
    timeoutMs: 20,
  });
  const outcome = await gate.review(SUBJECT);
  assert.equal(outcome.decision.status, 'TimedOut');
  assert.equal(outcome.decision.reviewer, '(no answer)');
  assert.match(outcome.decision.comment ?? '', /No decision arrived within 20 ms/);
  assert.equal(signal?.aborted, true, 'the reviewer is told the gate stopped waiting');
  assert.ok(outcome.refusal instanceof ReviewRefused);
  assert.match(outcome.refusal.message, /no decision arrived within 20 ms/);
});

test('an approval that arrives after the timeout is ignored, and a late failure is not a crash', async () => {
  const late = (settle: (resolve: (d: ReviewDecision) => void, reject: (e: Error) => void) => void): Reviewer =>
    () => new Promise<ReviewDecision>((resolve, reject) => { setTimeout(() => settle(resolve, reject), 60); });
  const approvesLate = new ReviewGate({
    reviewer: late((resolve) => resolve({ verdict: 'Approve', reviewer: 'alice' })), required: true, timeoutMs: 20,
  });
  const failsLate = new ReviewGate({
    reviewer: late((_resolve, reject) => reject(new Error('tty closed'))), required: true, timeoutMs: 20,
  });
  const [a, b] = await Promise.all([approvesLate.review(SUBJECT), failsLate.review(SUBJECT)]);
  assert.equal(a.decision.status, 'TimedOut');
  assert.equal(b.decision.status, 'TimedOut');
  // Let both late answers land: an unhandled rejection here would fail this test file.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(a.decision.status, 'TimedOut', 'the decision of record does not change after the fact');
});

test('a reviewer that fails before deciding is a denial, never an approval and never a crash', async () => {
  const failures: Reviewer[] = [
    async () => { throw new Error('the terminal went away'); },
    () => { throw new Error('the terminal went away'); },
  ];
  for (const reviewer of failures) {
    const required = await new ReviewGate({ reviewer, required: true }).review(SUBJECT);
    assert.equal(required.decision.status, 'Rejected');
    assert.match(required.decision.comment ?? '', /failed before deciding \(the terminal went away\)/);
    assert.ok(required.refusal instanceof ReviewRefused);

    const advisory = await new ReviewGate({ reviewer }).review(SUBJECT);
    assert.equal(advisory.decision.status, 'Rejected');
    assert.equal(advisory.refusal, undefined, 'advisory: recorded, and the node goes on');
  }
});

test('an answer that is not a decision is a denial', async () => {
  const answers: unknown[] = [
    { verdict: 'approve', reviewer: 'alice' },       // misspelt verdict
    { verdict: 'Approved', reviewer: 'alice' },      // an ApprovalStatus, not a verdict
    { verdict: 'Approve' },                          // nobody to name
    { verdict: 'Approve', reviewer: '   ' },
    { verdict: 'Approve', reviewer: 42 },
    'Approve',
    true,
    null,
    undefined,
  ];
  for (const answer of answers) {
    const outcome = await new ReviewGate({ reviewer: answering(answer), required: true }).review(SUBJECT);
    assert.equal(outcome.decision.status, 'Rejected', `${JSON.stringify(answer)} must not approve`);
    assert.match(outcome.decision.comment ?? '', /not a decision/);
    assert.ok(outcome.refusal instanceof ReviewRefused);
  }
});

test('an empty diff is an error, never an approval, and nobody is asked', async () => {
  const asked: ReviewRequest[] = [];
  const gate = new ReviewGate({ reviewer: answering({ verdict: 'Approve', reviewer: 'alice' }, asked) });
  for (const diff of ['', ' \n\t']) {
    await assert.rejects(gate.review({ ...SUBJECT, diff }), /handed an empty diff for node c1/);
  }
  assert.equal(asked.length, 0);
});

test('every request gets its own id', async () => {
  const asked: ReviewRequest[] = [];
  const gate = new ReviewGate({ reviewer: answering({ verdict: 'Approve', reviewer: 'alice' }, asked) });
  await gate.review(SUBJECT);
  await gate.review(SUBJECT);
  assert.equal(asked.length, 2);
  assert.notEqual(asked[0]?.id, asked[1]?.id);
});

test('a timeout setTimeout cannot honour is refused at construction', () => {
  const reviewer = answering({ verdict: 'Approve', reviewer: 'alice' });
  // NaN and anything past 2^31 - 1 make setTimeout fire at once, which would deny every review.
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
    assert.throws(() => new ReviewGate({ reviewer, timeoutMs }), /timeoutMs must be a whole number/);
  }
  assert.equal(new ReviewGate({ reviewer, timeoutMs: 2 ** 31 - 1 }).required, false);
  assert.equal(new ReviewGate({ reviewer, required: true }).required, true);
});
