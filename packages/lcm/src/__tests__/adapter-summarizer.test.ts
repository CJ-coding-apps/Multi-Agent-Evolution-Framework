import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, CliAdapter, LcmMessage,
} from '@maf/types';
import { makeLcmMessageId, makeRunId } from '@maf/types';
import { createAdapterSummarizer, createAdapterSubAgent } from '../AdapterSummarizer.js';
import {
  byteLength, MAX_SUMMARY_ARGV_BYTES, MAX_SUMMARY_PROMPT_BYTES, SUMMARY_ARGV_ALLOWANCE_BYTES,
} from '../summarizer.js';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// ORACLE: D-17 (WP-3.2) — summaries come from the run's adapter, with a configurable model, and a
// summarization call cannot act on the tree. The call must ask for text only (`nativeTools: false`),
// must charge the backend's own token count, must carry the backend's surface so the engine can
// record the call (F1), and must fail loudly rather than return nothing.

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
};

class ScriptedAdapter implements CliAdapter {
  readonly name = 'scripted-lcm';
  readonly calls: AdapterInvokeOptions[] = [];
  constructor(private readonly answer: Partial<AdapterInvokeResult>) {}
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(options: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    this.calls.push(options);
    return { success: true, output: 'summary text', toolCallLog: [], exitCode: 0, duration: 1, ...this.answer };
  }
  async *stream(): AsyncGenerator<string> { yield ''; }
}

const message = (content: string): LcmMessage => ({
  id: makeLcmMessageId(`msg-${content}`),
  sessionId: 's',
  runId: makeRunId('r'),
  role: 'user',
  content,
  tokens: 1,
  createdAt: new Date(0),
});

/** A credential format `redactCredentials` recognises; the tests below must not find it in the clear. */
const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET';

test('a summarization call asks for text only and carries the configured model', async () => {
  const adapter = new ScriptedAdapter({ tokensUsed: 42 });
  const summarize = createAdapterSummarizer({
    adapter, workingDir: '/tmp/work', model: 'summary-model', timeoutMs: 1_000,
  });

  const output = await summarize([message('first'), message('second')], 0);

  assert.equal(adapter.calls.length, 1);
  const call = adapter.calls[0]!;
  assert.equal(call.nativeTools, false, 'a summarization must not be able to act on the tree');
  assert.equal(call.model, 'summary-model', 'the configured model is the one used');
  assert.equal(call.workingDir, '/tmp/work');
  assert.equal(call.timeoutMs, 1_000);
  assert.match(call.prompt, /\[USER\] first/);
  assert.match(call.prompt, /\[USER\] second/);

  // R6: the backend reported no surface here, so this layer records one from what it knows.
  assert.equal(typeof output === 'string' ? undefined : output.content, 'summary text');
  assert.equal(typeof output === 'string' ? undefined : output.tokensUsed, 42);
  assert.equal(typeof output === 'string' ? undefined : output.model, 'summary-model');
  assert.ok(typeof output !== 'string' && output.surface !== undefined, 'a summary is a recorded call');
});

test('the backend surface travels with the summary so the engine can record the call (F1)', async () => {
  const surface = {
    systemPromptSha256: 'a'.repeat(64), toolCatalog: '', argv: [],
    promptSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
  };
  const adapter = new ScriptedAdapter({ modelSurface: surface });
  const output = await createAdapterSummarizer({ adapter, workingDir: '/tmp' })([message('x')], 0);

  assert.deepEqual(
    typeof output === 'string' ? undefined : output.surface,
    surface,
    'the digests of what was sent and returned reach the record',
  );
});

test('a backend that reports no surface still yields one, from what this layer knows (R6)', async () => {
  // Ollama and OpenRouter return no `modelSurface` today. The summary is still a model call, and a
  // call with no record is a summary that cannot be attributed — so the digests of the text this
  // layer sent and received stand in. `toolCatalog: ''` is true: MAF composes no tool catalogue for
  // a text-only call.
  const adapter = new ScriptedAdapter({});
  const output = await createAdapterSummarizer({ adapter, workingDir: '/tmp', model: 'm' })([message('x')], 0);
  const call = adapter.calls[0]!;
  const surface = typeof output === 'string' ? undefined : output.surface;

  assert.ok(surface, 'a surface is recorded even when the backend returns none');
  assert.equal(surface.systemPromptSha256, sha256(call.systemPrompt ?? ''));
  assert.equal(surface.promptSha256, sha256(call.prompt));
  assert.equal(surface.outputSha256, sha256('summary text'));
  assert.equal(surface.toolCatalog, '');
  assert.deepEqual(surface.argv, []);
  assert.equal(surface.model, 'm', 'the model the call asked for is on the record');
});

test('the summarizer measures bytes, not characters, and refuses what the OS would (R3)', async () => {
  // `'中'` is one UTF-16 code unit and three UTF-8 bytes. 60,000 of them is 180,000 bytes: under the
  // old character cap, over the byte cap, and far over what one argv argument can carry. The
  // refusal is this layer's, before a process is started with an argument the operating system
  // would reject with E2BIG.
  assert.ok(
    MAX_SUMMARY_PROMPT_BYTES + SUMMARY_ARGV_ALLOWANCE_BYTES <= MAX_SUMMARY_ARGV_BYTES,
    'the prompt cap leaves the rest of the command line inside the argv cap',
  );
  const big = '中'.repeat(60_000);
  assert.equal(byteLength(big), 180_000, 'the fixture is what the test says it is');
  assert.ok(big.length < MAX_SUMMARY_PROMPT_BYTES, 'and a CHARACTER cap would have let it through');

  const adapter = new ScriptedAdapter({ output: 'ok' });
  await assert.rejects(
    () => createAdapterSummarizer({ adapter, workingDir: '/tmp' })(
      [{ ...message('x'), content: big }], 0,
    ),
    new RegExp(`180007-byte prompt, over the ${MAX_SUMMARY_PROMPT_BYTES}-byte cap`),
  );
  assert.equal(adapter.calls.length, 0, 'the backend was never started with the oversized argument');

  // Just under the cap is sent: the check refuses the oversize, not the non-ASCII.
  const fits = '中'.repeat(21_000);
  await createAdapterSummarizer({ adapter, workingDir: '/tmp' })(
    [{ ...message('x'), content: fits }], 0,
  );
  assert.equal(adapter.calls.length, 1);
});

// L3n: the target the engine derives from the injector's budget only reaches a real model through
// this sentence. Dropping it leaves the summarizer guessing, which is the defect L3 was written to
// remove; both depths carry it, because a raised summary must shrink too.
test('the summarizer states the size target it was given, at both depths (L3n)', async () => {
  const adapter = new ScriptedAdapter({});
  const summarize = createAdapterSummarizer({ adapter, workingDir: '/tmp/work' });

  await summarize([message('x')], 0, 123);
  await summarize([message('x')], 1, 456);
  await summarize([message('x')], 0);

  assert.match(adapter.calls[0]!.systemPrompt ?? '', /Aim for at most 123 tokens\./);
  assert.match(adapter.calls[1]!.systemPrompt ?? '', /Aim for at most 456 tokens\./,
    'a raised summary is asked for its own, tighter target');
  assert.doesNotMatch(adapter.calls[2]!.systemPrompt ?? '', /Aim for at most/,
    'no target, no claim about one: a direct compaction has no budget to derive it from');
});

test('without a model the call leaves the choice to the adapter', async () => {
  const adapter = new ScriptedAdapter({});
  await createAdapterSummarizer({ adapter, workingDir: '/tmp/work' })([message('x')], 0);
  assert.equal(adapter.calls[0]?.model, undefined);
});

test('a failed or empty summarization throws — it never silently produces nothing', async () => {
  const failed = new ScriptedAdapter({ success: false, exitCode: 2 });
  await assert.rejects(
    () => createAdapterSummarizer({ adapter: failed, workingDir: '/tmp' })([message('x')], 0),
    /LCM summarization failed/,
  );

  const empty = new ScriptedAdapter({ output: '   ' });
  await assert.rejects(
    () => createAdapterSummarizer({ adapter: empty, workingDir: '/tmp' })([message('x')], 0),
    /empty summary/,
  );
});

test('the summarizer refuses an empty message list instead of asking the model to invent one', async () => {
  const adapter = new ScriptedAdapter({});
  await assert.rejects(
    () => createAdapterSummarizer({ adapter, workingDir: '/tmp' })([], 0),
    /no messages/,
  );
  assert.equal(adapter.calls.length, 0);
});

// R8 / N12d, tested alone: the credential a tool wrote into the conversation never reaches the
// backend's prompt. Removing this masking leaves the assertion below red even when the output
// masking still works, which is why the two layers get one test each.
test('a credential in the messages is masked before the prompt is sent (F7 input, N12d)', async () => {
  const adapter = new ScriptedAdapter({});
  await createAdapterSummarizer({ adapter, workingDir: '/tmp' })(
    [message(`the deployment key is ${SECRET}`)], 0,
  );

  const call = adapter.calls[0]!;
  assert.doesNotMatch(call.prompt, new RegExp(SECRET), 'the backend never sees the credential');
  assert.match(call.prompt, /\[REDACTED:anthropic-key\]/, 'and the redaction is visible in its place');
  assert.match(call.prompt, /the deployment key is/, 'the rest of the message is preserved');
});

// R8 / N12b, tested alone: a model that repeats the credential it was shown cannot put it into the
// store. The input here is clean, so only the output masking can turn this red.
test('a credential the model repeats is masked out of the returned summary (F7 output, N12b)', async () => {
  const adapter = new ScriptedAdapter({ output: `the deployment key is ${SECRET}` });
  const output = await createAdapterSummarizer({ adapter, workingDir: '/tmp' })([message('what key?')], 0);

  assert.ok(typeof output !== 'string', 'the summarizer answers with a recorded summary');
  assert.doesNotMatch(output.content, new RegExp(SECRET), 'the store never receives the credential');
  assert.match(output.content, /\[REDACTED:anthropic-key\]/, 'and the redaction is visible in its place');
});

test('the sub-agent call is tool-less too, and keeps the caller prompt', async () => {
  const adapter = new ScriptedAdapter({ output: ' agentic result ' });
  const subAgent = createAdapterSubAgent({ adapter, workingDir: '/tmp', model: 'm' });

  const result = await subAgent('be terse', ['one', 'two']);

  // An object, not a bare string: the sub-agent is a summary call too, and its token count,
  // surface and model must survive the seam or the engine cannot record it (F1/R6).
  assert.equal(typeof result === 'string' ? undefined : result.content, 'agentic result');
  assert.equal(typeof result === 'string' ? undefined : result.model, 'm');
  assert.ok(typeof result !== 'string' && result.surface !== undefined, 'the sub-agent records a surface');
  const call = adapter.calls[0]!;
  assert.equal(call.nativeTools, false);
  assert.equal(call.systemPrompt, 'be terse');
  assert.equal(call.prompt, 'one\n\ntwo');
});

test('a failed or empty sub-agent call throws, as the summarizer does', async () => {
  const failed = new ScriptedAdapter({ success: false, exitCode: 3 });
  await assert.rejects(
    () => createAdapterSubAgent({ adapter: failed, workingDir: '/tmp' })('s', ['u']),
    /LCM Agentic-Map failed: the scripted-lcm adapter exited 3/,
  );

  const empty = new ScriptedAdapter({ output: '  \n ' });
  await assert.rejects(
    () => createAdapterSubAgent({ adapter: empty, workingDir: '/tmp' })('s', ['u']),
    /empty summary/,
  );
});
