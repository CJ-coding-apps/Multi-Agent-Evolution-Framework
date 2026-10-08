import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ApprovalAsk, ReviewAttestation } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { createApprovalGate } from '../ApprovalGate.js';
import type { PendingApproval } from '../ApprovalGate.js';
import { TtyApprovalProvider, confirmationCode } from '../providers/tty.js';
import { approvalRequestHash } from '../requestHash.js';

// ORACLE: D-02 — on a terminal, Escalate prompts with the tool id, the declared paths and the
// request hash, and only an answer to *that* prompt approves. Driven through PassThrough streams:
// the provider never needs a real TTY to be tested.

function terminal(): { input: PassThrough; output: PassThrough; text: () => string; prompts: () => number } {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
  return { input, output, text: () => written, prompts: () => written.split('approve> ').length - 1 };
}

/** Resolves once the terminal has shown `count` prompts in all. */
async function promptsShown(t: { prompts: () => number }, count: number): Promise<void> {
  for (let i = 0; i < 1000 && t.prompts() < count; i++) await new Promise((r) => setImmediate(r));
  assert.equal(t.prompts(), count, `expected ${count} prompt(s) on the terminal`);
}

const ask = (id = 'req-1', paths: string[] = ['yarn.lock']): ApprovalAsk => ({
  request: {
    id, runId: makeRunId('r1'), taskId: makeTaskId('t1'), requestedBy: makeAgentId('a1'),
    toolId: makeToolId('fs.write'), policyRuleId: 'protect-lock-files', description: 'needs a human', createdAt: new Date(),
  },
  toolId: makeToolId('fs.write'),
  input: { path: paths[0] ?? '', content: 'x' },
  declaredPaths: paths,
});

const pendingFor = (a: ApprovalAsk): PendingApproval => ({
  requestId: a.request.id, requestHash: approvalRequestHash(a), request: a.request,
  toolId: a.toolId, declaredPaths: a.declaredPaths, timeoutMs: 120_000,
});

const never = new AbortController().signal;

test('the prompt shows the tool id, the declared paths and the request hash; typing the code approves', async () => {
  const t = terminal();
  const provider = new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: true, reviewer: 'terminal:ops' });
  const pending = pendingFor(ask('req-1', ['yarn.lock', 'packages/a/yarn.lock']));
  let settled = false;

  const answered = provider.ask(pending, never).finally(() => { settled = true; });
  await promptsShown(t, 1);

  const shown = t.text();
  assert.match(shown, /tool:\s+"fs\.write"/);
  assert.match(shown, /paths:\s+"yarn\.lock", "packages\/a\/yarn\.lock"/);
  assert.ok(shown.includes(`sha256:${pending.requestHash}`), 'the full request hash is shown');
  const code = confirmationCode(pending);
  assert.match(code, /^[0-9a-f]{6}$/);
  assert.ok(shown.includes(`Type ${code} to approve`), 'and the code that approves it');
  assert.match(shown, /within 120 s/);
  assert.equal(settled, false, 'nothing is decided before the operator answers');

  t.input.write(code.slice(0, 2));
  t.input.write(`${code.slice(2).toUpperCase()}\r\n`); // split across chunks, any case, CRLF
  const result = await answered;

  assert.deepEqual(result, {
    requestId: 'req-1', requestHash: pending.requestHash, approved: true, reviewer: 'terminal:ops', reason: 'approved at the terminal',
  });
  assert.equal(t.input.listenerCount('data'), 0, 'the terminal is released after the answer');
  assert.equal(t.input.isPaused(), true, 'and paused, so a waiting stdin does not keep the process alive');
});

test('y, yes, an empty line or the wrong code refuses: an answer typed without the hash approves nothing', async () => {
  for (const typed of ['y', 'yes', '', '000000', 'approve']) {
    const t = terminal();
    const provider = new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: true });
    const answered = provider.ask(pendingFor(ask()), never);
    await promptsShown(t, 1);
    t.input.write(`${typed}\n`);
    const result = await answered;
    assert.equal(result.approved, false, JSON.stringify(typed));
    assert.match(result.reason, /refused at the terminal/);
  }
});

test('a declared path cannot redraw the prompt: newlines and escape sequences are shown escaped', async () => {
  const t = terminal();
  const provider = new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: true });
  const hostile = 'a.lock\n  hash:    sha256:000000\u001b[2K\u001b[1A';
  const answered = provider.ask(pendingFor(ask('req-1', [hostile])), never);
  await promptsShown(t, 1);

  assert.ok(!t.text().includes('\u001b'), 'no raw escape character reaches the terminal');
  assert.ok(t.text().includes(JSON.stringify(hostile)), 'the path is shown, escaped');
  assert.equal(t.text().match(/^ {2}hash:/gm)?.length, 1, 'only the real hash line starts a line');
  t.input.write('\n');
  assert.equal((await answered).approved, false);
});

test('the terminal closing before an answer refuses', async () => {
  const t = terminal();
  const provider = new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: true });
  const answered = provider.ask(pendingFor(ask()), never);
  await promptsShown(t, 1);
  t.input.end();
  const result = await answered;
  assert.equal(result.approved, false);
  assert.match(result.reason, /closed before an answer/);
});

test('when the gate stops waiting, the provider stops listening: a late answer lands nowhere', async () => {
  const t = terminal();
  const provider = new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: true });
  const pending = pendingFor(ask());
  const controller = new AbortController();
  const answered = provider.ask(pending, controller.signal);
  await promptsShown(t, 1);

  controller.abort();
  const result = await answered;
  assert.equal(result.approved, false);
  assert.equal(t.input.listenerCount('data'), 0);
  t.input.write(`${confirmationCode(pending)}\n`); // nobody is reading
  assert.equal(t.input.listenerCount('data'), 0);
});

test('two requests at once are asked one after the other, never both on one line', async () => {
  const t = terminal();
  const provider = new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: true });
  const first = pendingFor(ask('req-1', ['a.lock']));
  const second = pendingFor(ask('req-2', ['b.lock']));

  const firstAnswer = provider.ask(first, never);
  const secondAnswer = provider.ask(second, never);
  await promptsShown(t, 1);
  assert.ok(!t.text().includes('"b.lock"'), 'the second prompt waits for the first answer');

  t.input.write(`${confirmationCode(first)}\n`);
  assert.equal((await firstAnswer).approved, true);
  await promptsShown(t, 2);
  t.input.write('\n');
  assert.equal((await secondAnswer).approved, false);
});

test('two providers on one terminal also take turns: a run may build more than one gate', async () => {
  const t = terminal();
  const one = new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: true });
  const two = new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: true });
  const first = pendingFor(ask('req-1', ['a.lock']));
  const second = pendingFor(ask('req-2', ['b.lock']));

  const firstAnswer = one.ask(first, never);
  const secondAnswer = two.ask(second, never);
  await promptsShown(t, 1);
  assert.equal(t.input.listenerCount('data'), 1, 'one reader at a time');

  t.input.write(`${confirmationCode(first)}\n`);
  assert.equal((await firstAnswer).approved, true);
  await promptsShown(t, 2);
  t.input.write(`${confirmationCode(second)}\n`);
  assert.equal((await secondAnswer).approved, true, 'each prompt got its own line');
});

test('a code typed twice does not approve the next identical call, which the operator has not seen', async () => {
  const t = terminal();
  const provider = new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: true });
  // The same call twice: one hash, two requests.
  const first = pendingFor(ask('req-1'));
  const second = pendingFor(ask('req-2'));
  assert.equal(first.requestHash, second.requestHash);
  assert.notEqual(confirmationCode(first), confirmationCode(second), 'each request has its own code');

  const firstAnswer = provider.ask(first, never);
  await promptsShown(t, 1);
  t.input.write(`${confirmationCode(first)}\n`);
  assert.equal((await firstAnswer).approved, true);
  t.input.write(`${confirmationCode(first)}\n`); // typed again, before the next prompt exists

  const secondAnswer = provider.ask(second, never);
  const result = await secondAnswer;
  assert.equal(result.approved, false, 'the stale line is not an answer to this prompt');
});

test('the terminal provider refuses to be built without a terminal', () => {
  const t = terminal();
  assert.throws(() => new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: false }), /needs stdin to be a terminal/);
});

test('through createApprovalGate on a terminal: an approval typed there is attested with the reviewer', async () => {
  const t = terminal();
  const approvals: ReviewAttestation[] = [];
  const gate = createApprovalGate({
    recorder: { addApproval: (a) => { approvals.push(a); } },
    mafDir: '/nonexistent/.maf',
    terminal: { input: t.input, output: t.output, isTTY: true },
    env: {},
  });
  const request = ask();
  const decided = gate.decide(request);
  await promptsShown(t, 1);
  t.input.write(`${confirmationCode({ requestId: 'req-1', requestHash: approvalRequestHash(request) })}\n`);

  const outcome = await decided;
  assert.equal(outcome.approved, true);
  assert.equal(approvals[0]?.decision.status, 'Approved');
  assert.match(approvals[0]?.decision.reviewer ?? '', /^terminal:/);
});

test('through createApprovalGate on a terminal: no answer times out, clears the slot and releases the terminal', async () => {
  const t = terminal();
  const approvals: ReviewAttestation[] = [];
  const gate = createApprovalGate({
    recorder: { addApproval: (a) => { approvals.push(a); } },
    mafDir: '/nonexistent/.maf',
    terminal: { input: t.input, output: t.output, isTTY: true },
    env: {},
    timeoutMs: 30,
  });

  const outcome = await gate.decide(ask());

  assert.equal(t.prompts(), 1, 'the operator was asked');
  assert.equal(outcome.status, 'TimedOut');
  assert.equal(outcome.approved, false);
  assert.deepEqual(gate.pendingIds(), []);
  assert.equal(t.input.listenerCount('data'), 0, 'nothing is left reading the terminal');
  assert.equal(approvals[0]?.decision.status, 'TimedOut');
});
