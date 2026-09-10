import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CliAdapter, AdapterInvokeOptions, AdapterInvokeResult } from '@maf/types';
import { makeRunId, makeTaskId } from '@maf/types';
import { ReviewGate } from '../ReviewGate.js';
import type { WorktreeManager } from '../WorktreeManager.js';

const RUN  = makeRunId('r1');
const TASK = makeTaskId('t1');

function fakeAdapter(output: string, capture?: { opts?: AdapterInvokeOptions }): CliAdapter {
  return {
    name: 'claude',
    capabilities: () => ({
      supportsStreaming: false, supportsToolCalling: false, inProcessLoop: false,
      supportsWorktrees: false, maxConcurrentTasks: 1, nativePlugins: [],
    }),
    isAvailable: async () => true,
    invoke: async (opts: AdapterInvokeOptions): Promise<AdapterInvokeResult> => {
      if (capture) capture.opts = opts;
      return { success: true, output, toolCallLog: [], exitCode: 0, duration: 1 };
    },
    stream: async function* () { yield output; },
  };
}

const worktreesWithDiff = (diff: string): WorktreeManager =>
  ({ harvest: async () => diff } as unknown as WorktreeManager);

const worktreesThrowing = (): WorktreeManager =>
  ({ harvest: async () => { throw new Error('no worktree'); } } as unknown as WorktreeManager);

const gate = (adapter: CliAdapter) =>
  new ReviewGate({ adapter, projectRoot: '/tmp' });

test('review() auto-approves when there is no diff to review', async () => {
  const g = gate(fakeAdapter('SHOULD NOT BE CALLED'));
  const res = await g.review(TASK, RUN, worktreesThrowing());
  assert.equal(res.approved, true);
  assert.match(res.reasoning, /No changes/);
  assert.deepEqual(res.suggestions, []);
});

test('review() parses an APPROVED verdict with reasoning and numbered suggestions', async () => {
  const output = [
    'APPROVED',
    'The change is small and well-tested.',
    'It follows existing conventions.',
    '1. Consider extracting the helper.',
    '2. Add a doc comment.',
  ].join('\n');
  const capture: { opts?: AdapterInvokeOptions } = {};
  const g = gate(fakeAdapter(output, capture));
  const res = await g.review(TASK, RUN, worktreesWithDiff('diff --git a/x b/x\n+new line\n'));

  assert.equal(res.approved, true);
  assert.match(res.reasoning, /small and well-tested/);
  assert.match(res.reasoning, /existing conventions/);
  assert.deepEqual(res.suggestions, ['Consider extracting the helper.', 'Add a doc comment.']);
  // The diff was actually sent to the adapter
  assert.match(capture.opts?.prompt ?? '', /\+new line/);
  assert.ok((capture.opts?.systemPrompt ?? '').length > 0, 'system prompt should be set');
});

test('review() parses a REJECTED verdict', async () => {
  const g = gate(fakeAdapter('REJECTED\nThe diff deletes the test suite.'));
  const res = await g.review(TASK, RUN, worktreesWithDiff('diff'));
  assert.equal(res.approved, false);
  assert.match(res.reasoning, /deletes the test suite/);
});

test('review() treats a verdict containing both words as rejection (fail closed)', async () => {
  const g = gate(fakeAdapter('REJECTED (not APPROVED)\nProblems found.'));
  const res = await g.review(TASK, RUN, worktreesWithDiff('diff'));
  assert.equal(res.approved, false);
});

test('review() does not approve when the verdict line is missing', async () => {
  const g = gate(fakeAdapter('Looks fine to me I guess'));
  const res = await g.review(TASK, RUN, worktreesWithDiff('diff'));
  assert.equal(res.approved, false);
});

test('review() collects bullet-style suggestions and stops reasoning at the list', async () => {
  const output = [
    'APPROVED',
    'Good work overall.',
    '- tighten the regex',
    '* rename the variable',
    'trailing text after list is treated as reasoning no longer',
  ].join('\n');
  const g = gate(fakeAdapter(output));
  const res = await g.review(TASK, RUN, worktreesWithDiff('diff'));
  assert.equal(res.approved, true);
  assert.equal(res.reasoning, 'Good work overall.');
  assert.ok(res.suggestions.includes('tighten the regex'));
  assert.ok(res.suggestions.includes('rename the variable'));
});

test('review() truncates very large diffs before sending to the adapter', async () => {
  const capture: { opts?: AdapterInvokeOptions } = {};
  const g = gate(fakeAdapter('APPROVED\nok', capture));
  const bigDiff = 'x'.repeat(50_000);
  await g.review(TASK, RUN, worktreesWithDiff(bigDiff));
  const prompt = capture.opts?.prompt ?? '';
  assert.ok(prompt.length < 10_000, `prompt length ${prompt.length} should be bounded`);
});

test('review() honors a custom review prompt and timeout', async () => {
  const capture: { opts?: AdapterInvokeOptions } = {};
  const g = new ReviewGate({
    adapter: fakeAdapter('APPROVED\nok', capture),
    projectRoot: '/tmp',
    reviewPrompt: 'CUSTOM REVIEWER RULES',
    timeoutMs: 5_000,
  });
  await g.review(TASK, RUN, worktreesWithDiff('diff'));
  assert.equal(capture.opts?.systemPrompt, 'CUSTOM REVIEWER RULES');
  assert.equal(capture.opts?.timeoutMs, 5_000);
});
