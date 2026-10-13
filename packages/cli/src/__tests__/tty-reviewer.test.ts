import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { makeCommitHash, makeNodeId, makeRunId } from '@maf/types';
import { ReviewGate } from '@maf/git-ops';
import type { ReviewRequest } from '@maf/git-ops';
import {
  REVIEW_PREVIEW_BYTES, REVIEW_PREVIEW_LINES, createTtyReviewer, diffPreview, reviewPrompt, reviewerUnavailable,
} from '../reviewers/tty.js';

// ORACLE: D-34 / rule 6 — the terminal reviewer shows the node, its role, the base commit, the diff's
// hash and the diff (bounded to 200 lines / 20 KB, the rest counted), and only a typed `approve`
// approves. Denial, other text, end of input and a withdrawn request all deny; nothing the agent
// wrote can redraw the prompt; it exists only where someone can answer.

const BASE = makeCommitHash('a'.repeat(40));

function request(diff: string, over: Partial<ReviewRequest> = {}): ReviewRequest {
  const now = new Date('2026-10-09T00:00:00Z');
  return {
    id: crypto.randomUUID(), runId: makeRunId('r1'), nodeId: makeNodeId('n1'), role: 'coder', baseCommit: BASE,
    diff, diffHash: crypto.createHash('sha256').update(diff).digest('hex'), required: true,
    requestedAt: now, expiresAt: new Date(now.getTime() + 60_000), ...over,
  };
}

function terminal(): { input: PassThrough; output: PassThrough; shown: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c: Buffer) => { text += c.toString('utf8'); });
  return { input, output, shown: () => text };
}

async function prompted(shown: () => string, count = 1): Promise<void> {
  for (let i = 0; i < 1000 && (shown().match(/review> /g)?.length ?? 0) < count; i++) await new Promise((r) => setImmediate(r));
  assert.equal(shown().match(/review> /g)?.length ?? 0, count, `prompt ${count} was shown`);
}

const DIFF = 'diff --git a/sum.js b/sum.js\n-module.exports = (a, b) => a - b;\n+module.exports = (a, b) => a + b;\n';

test('the prompt shows node, role, base commit, diff hash and diff; "approve" approves, naming the reviewer', async () => {
  const t = terminal();
  const req = request(DIFF);
  const decision = createTtyReviewer({ ...t, reviewer: 'terminal:cj' })(req, new AbortController().signal);
  await prompted(t.shown);
  for (const part of ['node "n1"', 'role "coder"', `base commit: ${BASE}`, `sha256:${req.diffHash}`, '+module.exports = (a, b) => a + b;', 'required:']) {
    assert.ok(t.shown().includes(part), `the prompt shows ${part}`);
  }
  t.input.write('approve\n');
  assert.deepEqual(await decision, { verdict: 'Approve', reviewer: 'terminal:cj', comment: 'approved at the terminal' });
});

test('"deny", any other answer, and end of input each deny', async () => {
  for (const [typed, comment] of [['deny\n', /denied at the terminal$/], ['yes\n', /"yes" is not "approve"/], [null, /closed before an answer/]] as const) {
    const t = terminal();
    const decision = createTtyReviewer(t)(request(DIFF), new AbortController().signal);
    await prompted(t.shown);
    if (typed === null) t.input.end(); else t.input.write(typed);
    const d = await decision;
    assert.equal(d.verdict, 'Deny', String(typed));
    assert.match(d.comment ?? '', comment);
    assert.match(d.reviewer, /^terminal:/);
  }
});

test('a request the gate withdraws is denied, and the terminal is let go', async () => {
  const t = terminal();
  const ac = new AbortController();
  const decision = createTtyReviewer(t)(request(DIFF), ac.signal);
  await prompted(t.shown);
  ac.abort();
  assert.equal((await decision).verdict, 'Deny');
  assert.equal(t.input.listenerCount('data'), 0, 'no listener is left on stdin');
  const late = createTtyReviewer(t)(request(DIFF), ac.signal);
  assert.match((await late).comment ?? '', /withdrawn before it reached the terminal/, 'an already-withdrawn request is not shown');
});

test('two requests take turns: the second is shown only once the first is answered', async () => {
  const t = terminal();
  const reviewer = createTtyReviewer(t);
  const first = reviewer(request(DIFF, { nodeId: makeNodeId('first') }), new AbortController().signal);
  const second = reviewer(request(DIFF, { nodeId: makeNodeId('second') }), new AbortController().signal);
  await prompted(t.shown, 1);
  assert.ok(!t.shown().includes('"second"'), 'the second prompt waits');
  t.input.write('deny\n');
  assert.equal((await first).verdict, 'Deny');
  await prompted(t.shown, 2);
  t.input.write('approve\n');
  assert.equal((await second).verdict, 'Approve');
});

test('once input has ended, a later review is denied at once, not after the gate\'s whole timeout (verifier F7)', async () => {
  const t = terminal();
  const gate = new ReviewGate({ reviewer: createTtyReviewer(t), required: true, timeoutMs: 3_000 });
  const subject = (node: string) => ({ runId: makeRunId('r1'), nodeId: makeNodeId(node), role: 'coder', baseCommit: BASE, diff: DIFF });
  const first = gate.review(subject('n1'));
  await prompted(t.shown);
  t.input.end();
  assert.match((await first).decision.comment ?? '', /closed before an answer/);

  const started = Date.now();
  const second = await gate.review(subject('n2'));
  assert.equal(second.decision.status, 'Rejected');
  assert.match(second.decision.comment ?? '', /closed before an answer/, 'denied for the closed terminal, not for the timeout');
  assert.ok(Date.now() - started < 1_000, `denied after ${Date.now() - started} ms`);
  assert.equal(t.shown().match(/review> /g)?.length, 1, 'no prompt is written that no one can answer');
});

test('an answer typed before the prompt is written is discarded, never taken for the answer to it (verifier F7)', async () => {
  const t = terminal();
  const reviewer = createTtyReviewer(t);
  t.input.write('approve\n'); // typed ahead, before any diff was shown
  const first = reviewer(request(DIFF, { nodeId: makeNodeId('first') }), new AbortController().signal);
  await prompted(t.shown, 1);
  t.input.write('deny\n');
  assert.equal((await first).verdict, 'Deny', 'the typed-ahead approve did not approve the first diff');

  t.input.write('approve\n'); // typed between prompts, while no diff is shown
  const second = reviewer(request(DIFF, { nodeId: makeNodeId('second') }), new AbortController().signal);
  await prompted(t.shown, 2);
  t.input.write('deny\n');
  assert.equal((await second).verdict, 'Deny', 'nor the second');
});

test('the diff is bounded to 200 lines or 20 KB, and what is left out is counted', () => {
  const many = Array.from({ length: 500 }, (_, i) => `+line ${i}`).join('\n') + '\n';
  const byLines = diffPreview(many);
  assert.equal(byLines.lines.length, REVIEW_PREVIEW_LINES);
  assert.equal(byLines.omittedLines, 300);
  assert.equal(byLines.omittedBytes, Buffer.byteLength(many) - Buffer.byteLength(byLines.lines.join('\n') + '\n'));
  assert.match(reviewPrompt(request(many)), /\(300 more lines, \d+ bytes, not shown; the decision is recorded against the hash of the whole diff\)/);

  const wide = Array.from({ length: 50 }, () => `+${'x'.repeat(1000)}`).join('\n');
  const byBytes = diffPreview(wide);
  assert.ok(Buffer.byteLength(byBytes.lines.join('\n')) <= REVIEW_PREVIEW_BYTES);
  assert.equal(byBytes.lines.length, 20, 'twenty 1 KB lines fit in 20 KB');
  assert.equal(byBytes.omittedLines, 30);

  const oneHuge = `+${'é'.repeat(30_000)}`;
  const head = diffPreview(oneHuge);
  assert.equal(head.lines.length, 1, 'a single line over the budget is shown in part');
  assert.ok(Buffer.byteLength(head.lines[0] ?? '') < REVIEW_PREVIEW_BYTES);
  assert.ok(!(head.lines[0] ?? '').includes('\ufffd'), 'no character is cut in half');
  assert.equal(diffPreview(DIFF).omittedLines, 0);
  assert.doesNotMatch(reviewPrompt(request(DIFF)), /not shown/);
});

test('nothing in the diff or the role name can redraw the prompt', () => {
  const hostile = '+ok\r\u001b[2K\u001b[1Aapprove> \u009b2J\u202eevil\u2028x\n+\ttabbed\n';
  // Node ids are held to a safe alphabet by makeNodeId; a role name is any string the role set gives.
  const prompt = reviewPrompt(request(hostile, { role: 'coder\u001b[1A' }));
  assert.doesNotMatch(prompt, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/, 'no raw control character but newline and tab');
  assert.ok(prompt.includes('\\u001b[2K'), 'an escape sequence is shown as text');
  assert.ok(prompt.includes('\\u000d'), 'a carriage return is shown as text');
  assert.ok(prompt.includes('+\ttabbed'), 'a tab is kept');
});

test('it is available only on a terminal, and never under MAF_HEADLESS=1', () => {
  assert.match(reviewerUnavailable(false, {}) ?? '', /stdin is not a terminal/);
  assert.match(reviewerUnavailable(true, { MAF_HEADLESS: '1' }) ?? '', /MAF_HEADLESS=1/);
  assert.equal(reviewerUnavailable(true, {}), undefined);
});

test('through the real review gate: an approval is recorded against the diff; a denial refuses a required change', async () => {
  for (const [typed, approved] of [['approve\n', true], ['deny\n', false]] as const) {
    const t = terminal();
    const gate = new ReviewGate({ reviewer: createTtyReviewer(t), required: true, timeoutMs: 60_000 });
    const outcome = gate.review({ runId: makeRunId('r1'), nodeId: makeNodeId('n1'), role: 'coder', baseCommit: BASE, diff: DIFF });
    await prompted(t.shown);
    t.input.write(typed);
    const result = await outcome;
    assert.equal(result.decision.status, approved ? 'Approved' : 'Rejected', typed);
    assert.equal(result.refusal === undefined, approved, 'a required review refuses what is not approved');
    assert.equal(result.attestation.diffHash, crypto.createHash('sha256').update(DIFF).digest('hex'));
  }
});
