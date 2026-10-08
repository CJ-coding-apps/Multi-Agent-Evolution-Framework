import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ApprovalAsk, ReviewAttestation } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { createApprovalGate, headlessReason } from '../ApprovalGate.js';
import { approvalRequestHash } from '../requestHash.js';

// ORACLE: D-02 — headless (stdin not a TTY, or MAF_HEADLESS=1) denies without prompting, writes
// `.maf/approvals/pending/<id>.json` (request, hash, timestamp, reason), and attests the denial.

const ask = (id = 'req-1'): ApprovalAsk => ({
  request: {
    id, runId: makeRunId('r1'), taskId: makeTaskId('t1'), requestedBy: makeAgentId('a1'),
    toolId: makeToolId('fs.write'), policyRuleId: 'protect-lock-files', description: 'needs a human', createdAt: new Date(),
  },
  toolId: makeToolId('fs.write'),
  input: { path: 'yarn.lock', content: 'x' },
  declaredPaths: ['yarn.lock'],
});

/** A scratch `.maf`, a terminal whose output is watched, and an approval sink, for `body`. */
async function withHeadless(
  isTTY: boolean,
  env: NodeJS.ProcessEnv,
  body: (h: { mafDir: string; written: () => string; reads: () => number; approvals: ReviewAttestation[];
    gate: ReturnType<typeof createApprovalGate> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-approval-headless-'));
  try {
    const mafDir = path.join(root, '.maf');
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
    const approvals: ReviewAttestation[] = [];
    const gate = createApprovalGate({
      recorder: { addApproval: (a) => { approvals.push(a); } },
      mafDir, terminal: { input, output, isTTY }, env,
    });
    await body({ mafDir, written: () => written, reads: () => input.listenerCount('data'), approvals, gate });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [label, isTTY, env, why] of [
  ['stdin is not a TTY', false, {}, /stdin is not a terminal/],
  ['MAF_HEADLESS=1 on a TTY', true, { MAF_HEADLESS: '1' }, /MAF_HEADLESS=1 is set/],
] as const) {
  test(`headless (${label}): refused without a prompt, written to .maf/approvals/pending/<id>.json, attested`, async () => {
    await withHeadless(isTTY, env, async ({ mafDir, written, reads, approvals, gate }) => {
      const request = ask('req-1');
      const outcome = await gate.decide(request);

      assert.equal(outcome.approved, false);
      assert.equal(outcome.status, 'Rejected');
      assert.match(outcome.reason, why);
      assert.equal(written(), '', 'nothing was written to the terminal');
      assert.equal(reads(), 0, 'and nothing read from it');

      const file = path.join(mafDir, 'approvals', 'pending', 'req-1.json');
      const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      assert.equal(record['requestHash'], approvalRequestHash(request));
      assert.equal((record['request'] as { id: string }).id, 'req-1');
      assert.equal((record['request'] as { policyRuleId: string }).policyRuleId, 'protect-lock-files');
      assert.match(String(record['reason']), why);
      assert.ok(!Number.isNaN(Date.parse(String(record['timestamp']))), 'with a timestamp');
      assert.match(outcome.reason, /recorded at .*req-1\.json/);

      assert.equal(approvals.length, 1);
      assert.equal(approvals[0]?.decision.status, 'Rejected');
      assert.equal(approvals[0]?.decision.reviewer, 'headless');
      assert.equal(approvals[0]?.diffHash, approvalRequestHash(request));
    });
  });
}

test('headless: a pending record already on disk is not overwritten, and the call is still refused', async () => {
  await withHeadless(false, {}, async ({ mafDir, gate }) => {
    const dir = path.join(mafDir, 'approvals', 'pending');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'req-1.json'), 'earlier\n');

    const outcome = await gate.decide(ask('req-1'));

    assert.equal(outcome.approved, false);
    assert.match(outcome.reason, /could not be recorded/);
    assert.equal(await readFile(path.join(dir, 'req-1.json'), 'utf8'), 'earlier\n');
  });
});

test('headless: a refused-up-front request (unusable id) writes no file', async () => {
  await withHeadless(false, {}, async ({ mafDir, gate }) => {
    const outcome = await gate.decide(ask('../escape'));
    assert.equal(outcome.approved, false);
    await assert.rejects(readdir(path.join(mafDir, 'approvals', 'pending')), { code: 'ENOENT' });
  });
});

test('headless is exactly: stdin not a TTY, or MAF_HEADLESS=1', () => {
  assert.equal(headlessReason({ isTTY: true }, {}), undefined);
  assert.equal(headlessReason({ isTTY: true }, { MAF_HEADLESS: '0' }), undefined);
  assert.equal(headlessReason({ isTTY: true }, { MAF_HEADLESS: 'true' }), undefined, 'only "1" opts in, as documented');
  assert.match(headlessReason({ isTTY: false }, {}) ?? '', /stdin is not a terminal/);
  assert.match(headlessReason({ isTTY: true }, { MAF_HEADLESS: '1' }) ?? '', /MAF_HEADLESS=1/);
});

test('the default terminal is never read when the run is headless', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-approval-default-'));
  const dataListeners = process.stdin.listenerCount('data');
  try {
    const approvals: ReviewAttestation[] = [];
    const gate = createApprovalGate({
      recorder: { addApproval: (a) => { approvals.push(a); } },
      mafDir: path.join(root, '.maf'),
      env: { MAF_HEADLESS: '1' },
    });
    const outcome = await gate.decide(ask('req-default'));
    assert.equal(outcome.approved, false);
    assert.equal(approvals[0]?.decision.reviewer, 'headless');
    assert.equal(process.stdin.listenerCount('data'), dataListeners, 'stdin was not listened to');
    await readFile(path.join(root, '.maf', 'approvals', 'pending', 'req-default.json'), 'utf8');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
