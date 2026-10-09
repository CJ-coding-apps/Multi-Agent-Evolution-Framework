import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ApprovalAsk, ReviewAttestation } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { createApprovalGate } from '../ApprovalGate.js';
import type { PendingApproval } from '../ApprovalGate.js';
import { TtyApprovalProvider, confirmationCode, PREVIEW_CHARS, PREVIEW_LINES } from '../providers/tty.js';
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
  toolId: a.toolId, input: a.input, declaredPaths: a.declaredPaths, timeoutMs: 120_000,
});

/** The ask for an `fs.write` of `content` to yarn.lock. */
const writing = (content: string, id = 'req-1'): ApprovalAsk => ({ ...ask(id), input: { path: 'yarn.lock', content } });

/** The prompt `provider` shows for `pending`, refused with an empty line once it is up. */
async function promptFor(pending: PendingApproval): Promise<string> {
  const t = terminal();
  const provider = new TtyApprovalProvider({ input: t.input, output: t.output, isTTY: true });
  const answered = provider.ask(pending, never);
  // Waits for the prompt's last line rather than counting prompts: the input may hold that text too.
  for (let i = 0; i < 1000 && !t.text().endsWith('\napprove> '); i++) await new Promise((r) => setImmediate(r));
  assert.ok(t.text().endsWith('\napprove> '), 'the prompt is shown');
  t.input.write('\n');
  assert.equal((await answered).approved, false);
  return t.text();
}

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

test('the prompt previews the input, bounded: a 1 MB content shows its first lines or characters and counts the rest', async () => {
  let lined = '';
  for (let i = 1; lined.length < 1_048_576; i++) lined += `line ${i}: ${'x'.repeat(40)}\n`;
  const firstLines = lined.split('\n').slice(0, PREVIEW_LINES).map((l) => `${l}\n`).join('');
  const unbroken = `${'é'.repeat(PREVIEW_CHARS + 10)}${'Z'.repeat(1_048_576)}`;

  for (const [content, shown] of [[lined, firstLines], [unbroken, unbroken.slice(0, PREVIEW_CHARS)]] as const) {
    const text = await promptFor(pendingFor(writing(content)));

    assert.ok(text.length < 3 * PREVIEW_CHARS, `the prompt is bounded, not ${text.length} characters`);
    assert.match(text, /^ {4}"path": "yarn\.lock"$/m, 'a short field is shown whole');
    const omitted = Buffer.byteLength(content) - Buffer.byteLength(shown);
    assert.ok(text.includes(`(${omitted} more bytes not shown)`), `and the ${omitted} bytes left out are counted`);
    assert.ok(text.indexOf('"content":') < text.indexOf('  request:'), 'the preview comes before the request id');
    if (content === lined) {
      assert.ok(text.includes(`      ${JSON.stringify(`line ${PREVIEW_LINES}: ${'x'.repeat(40)}`)}`), `line ${PREVIEW_LINES} is shown`);
      assert.ok(!text.includes(`line ${PREVIEW_LINES + 1}:`), `line ${PREVIEW_LINES + 1} is not`);
    } else {
      assert.ok(text.includes(`"content": ${JSON.stringify(shown)} (`), `the first ${PREVIEW_CHARS} characters are shown`);
      assert.ok(!text.includes('Z'), 'and nothing after them');
    }
  }

  const wide = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i]));
  const text = await promptFor(pendingFor({ ...ask(), input: wide }));
  assert.ok(text.length < 3 * PREVIEW_CHARS, 'however many fields the input has');
  assert.match(text, /^ {4}\(9992 more fields, \d+ bytes, not shown\)$/m);
});

test('the input preview cannot redraw the prompt: escape sequences and control characters are shown escaped', async () => {
  const hostile = [
    'ok',
    '  hash:    sha256:0000\u001b[2K\u001b[1A\r',
    'approve> \u0007\u007f\u009b2J\u202eevil\u2028',
  ].join('\n');
  const pending = pendingFor({ ...writing(hostile), input: { path: 'a.lock', content: hostile, mode: { '\u001b]0;x': '\u009b' } } });
  const text = await promptFor(pending);

  const raw = text.match(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g);
  assert.equal(raw, null, 'no character a terminal acts on reaches it, other than the prompt\'s own line breaks');
  assert.equal(text.match(/^ {2}hash:/gm)?.length, 1, 'only the real hash line starts a line');
  assert.equal(text.match(/^approve> /gm)?.length, 1, 'and only the real prompt');
  assert.ok(text.includes('      "  hash:    sha256:0000\\u001b[2K\\u001b[1A\\r"'), 'each content line is a JSON string literal');
  assert.ok(text.includes('\\u0007\\u007f\\u009b2J\\u202eevil\\u2028'), 'with what JSON leaves raw escaped as well');
  assert.ok(text.includes('"mode": {"\\u001b]0;x":"\\u009b"}'), 'any other field is compact JSON, escaped the same way');
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

test('a request queued behind another prompt gets the whole timeout from when it is shown, not from when it was asked', async () => {
  const t = terminal();
  const approvals: ReviewAttestation[] = [];
  const timeoutMs = 600;
  const gate = createApprovalGate({
    recorder: { addApproval: (a) => { approvals.push(a); } },
    mafDir: '/nonexistent/.maf',
    terminal: { input: t.input, output: t.output, isTTY: true },
    env: {},
    timeoutMs,
  });

  const first = gate.decide(ask('req-1', ['a.lock']));
  const second = gate.decide(ask('req-2', ['b.lock']));
  await promptsShown(t, 1);
  await new Promise((r) => setTimeout(r, 400)); // the operator reads the first prompt for a while
  t.input.write('\n');
  await first;
  await promptsShown(t, 2);
  const shownAt = performance.now();

  const outcome = await Promise.race([second, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 5 * timeoutMs))]);
  const waited = performance.now() - shownAt;

  assert.notEqual(outcome, 'hung', 'the second request still times out: its clock did start');
  assert.equal(outcome === 'hung' ? undefined : outcome.status, 'TimedOut');
  assert.ok(waited >= timeoutMs - 100, `the second prompt was given ${Math.round(waited)} ms of its ${timeoutMs} ms`);
  assert.deepEqual(approvals.map((a) => [a.requestId, a.decision.status]), [['req-1', 'Rejected'], ['req-2', 'TimedOut']]);
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
