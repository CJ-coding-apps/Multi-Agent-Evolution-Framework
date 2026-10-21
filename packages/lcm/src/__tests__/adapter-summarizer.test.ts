import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AdapterCapabilities, AdapterInvokeOptions, AdapterInvokeResult, CliAdapter, LcmMessage,
} from '@maf/types';
import { makeLcmMessageId, makeRunId } from '@maf/types';
import { createAdapterSummarizer, createAdapterSubAgent } from '../AdapterSummarizer.js';

// ORACLE: D-17 (WP-3.2) — summaries come from the run's adapter, with a configurable model, and a
// summarization call cannot act on the tree. The call must ask for text only (`nativeTools: false`),
// must charge the backend's own token count, and must fail loudly rather than return nothing.

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

  assert.deepEqual(output, { content: 'summary text', tokensUsed: 42 });
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

test('the sub-agent call is tool-less too, and keeps the caller prompt', async () => {
  const adapter = new ScriptedAdapter({ output: ' agentic result ' });
  const subAgent = createAdapterSubAgent({ adapter, workingDir: '/tmp', model: 'm' });

  const result = await subAgent('be terse', ['one', 'two']);

  assert.equal(result, 'agentic result');
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
