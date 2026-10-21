import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunId } from '@maf/types';
import type { LcmMessage } from '@maf/types';
import { LcmEngine } from '../LcmEngine.js';
import type { LcmEngineConfig } from '../LcmEngine.js';
import { LcmStore } from '../LcmStore.js';

// ORACLE: D-17 / D-26 (WP-3.2). The LCM is judged on what it hands a model:
//   - the fresh tail is the NEWEST messages, returned in reading order;
//   - compaction summarizes exactly the messages it stops returning raw, no more and no fewer;
//   - every piece of context — messages, summaries, cues — is charged against the budget;
//   - both modes deliver the archive (Dolt: ghost cues, Upward: summaries);
//   - the engine never invents a summary, and an id it does not hold is an error, not silence.

const RUN = makeRunId('run-lcm-test');

function engineWith(overrides: Partial<LcmEngineConfig> = {}) {
  const summarized: LcmMessage[][] = [];
  const engine = new LcmEngine({
    dbPath: ':memory:',
    contextThreshold: 0.75,
    freshTailCount: 2,
    mode: 'Dolt',
    summarize: async (messages) => {
      summarized.push(messages);
      return `summary-${summarized.length}`;
    },
    ...overrides,
  });
  return { engine, summarized };
}

async function addMessages(engine: LcmEngine, contents: string[], tokens = 10): Promise<void> {
  for (const content of contents) {
    await engine.addMessage({ sessionId: 's', runId: RUN, role: 'user', content, tokens });
  }
}

test('the fresh tail is the newest messages, in reading order, with ties broken by insertion (D-26)', () => {
  const store = new LcmStore(':memory:');
  try {
    // Written in a single loop, so `created_at` ties: the rowid break is what keeps the order
    // stable. The defect being pinned read the OLDEST messages with `ASC LIMIT ?`.
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'].map((content) =>
      store.insertMessage({ sessionId: 's', runId: RUN, role: 'user', content, tokens: 1 }),
    );

    assert.deepEqual(
      store.getMessagesBySession('s').map((m) => m.content),
      ['m1', 'm2', 'm3', 'm4', 'm5'],
      'all messages, oldest first, and no limit parameter to ask for the wrong end',
    );
    assert.deepEqual(
      store.getFreshTail('s', 2).map((m) => m.content),
      ['m4', 'm5'],
      'the two NEWEST, returned oldest-first so a prompt reads forward',
    );
    assert.deepEqual(store.getFreshTail('s', 0), [], 'zero means none, not all');
    assert.deepEqual(
      store.getUncompactedMessages('s', 2).map((m) => m.id),
      ids.slice(0, 3),
      'the droppable set is exactly the uncompacted messages outside the fresh tail',
    );
    assert.deepEqual(store.getUncompactedMessages('s', 10), [], 'a tail covering everything drops nothing');
  } finally {
    store.close();
  }
});

test('compaction summarizes exactly the messages it drops, and keeps the fresh tail raw', async () => {
  const { engine, summarized } = engineWith();
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  // 50 raw tokens against a budget of 60: 50 > 60 * 0.75, so compaction runs, and there is room
  // left afterwards for the cue that replaces the archive.
  const ctx = await engine.assembleContext('s', 60);

  assert.equal(summarized.length, 1, 'one summarization call');
  assert.deepEqual(summarized[0]?.map((m) => m.content), ['m1', 'm2', 'm3'], 'the three oldest, and only those');

  assert.deepEqual(ctx.messages.map((m) => m.content), ['m4', 'm5'], 'the newest two stay raw');
  assert.equal(ctx.summaries, undefined, 'Dolt mode offers cues, not summary objects');

  assert.equal(ctx.ghosts.length, 1, 'the archive is offered as a cue');
  const cue = ctx.ghosts[0]!;
  const expanded = await engine.lcm_expand(cue.summaryId);
  assert.deepEqual(
    expanded.map((m) => m.content).sort(),
    ['m1', 'm2', 'm3'],
    'the summary expands to exactly the messages that were dropped',
  );

  // A second assembly must not summarize the same messages again.
  await engine.assembleContext('s', 60);
  assert.equal(summarized.length, 1, 'already-summarized messages are not re-summarized');
  engine.close();
});

test('no compaction below the threshold, and every message is returned', async () => {
  const { engine, summarized } = engineWith();
  await addMessages(engine, ['m1', 'm2', 'm3'], 10);

  const ctx = await engine.assembleContext('s', 1_000);
  assert.equal(summarized.length, 0, 'roomy budget: no summarization call');
  assert.deepEqual(ctx.messages.map((m) => m.content), ['m1', 'm2', 'm3']);
  assert.equal(ctx.totalTokens, 30);
  engine.close();
});

test('Upward mode returns summaries, Dolt mode returns cues — never both', async () => {
  const { engine } = engineWith();
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  const upward = await engine.assembleContext('s', 40, 'Upward');
  assert.equal(upward.summaries?.length, 1, 'Upward: the archive is summary objects');
  assert.equal(upward.summaries?.[0]?.content, 'summary-1');
  assert.deepEqual(upward.ghosts, [], 'Upward does not also emit cues');
  assert.deepEqual(upward.messages.map((m) => m.content), ['m4', 'm5'], 'the fresh tail is unchanged');

  // A cue is a sentence, not three tokens, so it needs a budget it actually fits in — and the
  // reason it needs one is the next test's rule: the budget is a ceiling in both modes.
  const dolt = await engine.assembleContext('s', 80, 'Dolt');
  assert.equal(dolt.summaries, undefined, 'Dolt: no summary objects');
  assert.equal(dolt.ghosts.length, 1);
  engine.close();
});

test('the newest summaries are the ones kept when the budget is tight (Upward)', async () => {
  const { engine } = engineWith(); // freshTailCount 2
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);
  // First pass: m1..m3 become summary-1, m4/m5 are the fresh tail.
  await engine.assembleContext('s', 40, 'Upward');
  await addMessages(engine, ['m6', 'm7']);
  // Second pass: m4/m5 become summary-2, m6/m7 are the fresh tail.
  await engine.assembleContext('s', 40, 'Upward');

  // 20 raw tokens for the newest pair; each summary is 3 estimated tokens. At 23, only the newer
  // summary fits — the older one is skipped rather than crowding out the fresh tail.
  const ctx = await engine.assembleContext('s', 23, 'Upward');
  assert.deepEqual(ctx.messages.map((m) => m.content), ['m6', 'm7']);
  assert.deepEqual(
    ctx.summaries?.map((s) => s.content),
    ['summary-2'],
    'the newest summary fits; the older one is skipped',
  );
  assert.ok(ctx.totalTokens <= 23, 'the budget is a ceiling');
  engine.close();
});

test('the budget is a ceiling in both modes, including when the newest message alone exceeds it', async () => {
  const { engine } = engineWith();
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5'], 10);

  for (const mode of ['Dolt', 'Upward'] as const) {
    for (const budget of [1, 5, 12, 20, 40, 500]) {
      const ctx = await engine.assembleContext('s', budget, mode);
      assert.ok(
        ctx.totalTokens <= budget,
        `${mode} at budget ${budget}: reported ${ctx.totalTokens} tokens`,
      );
      const charged = ctx.messages.reduce((s, m) => s + m.tokens, 0);
      assert.ok(charged <= ctx.totalTokens, `${mode} at budget ${budget}: messages are counted`);
    }
  }

  const zero = await engine.assembleContext('s', 0, 'Upward');
  assert.deepEqual(zero.messages, []);
  assert.deepEqual(zero.summaries, []);
  assert.equal(zero.totalTokens, 0);
  engine.close();
});

test('summarizeChunk refuses an empty chunk and an id it does not hold (D-26)', async () => {
  const { engine, summarized } = engineWith();
  await addMessages(engine, ['m1']);

  await assert.rejects(() => engine.summarizeChunk([], 'LLM-Map'), /empty chunk/);
  await assert.rejects(
    () => engine.summarizeChunk(['not-a-message' as never], 'LLM-Map'),
    /not in the store/,
  );
  assert.equal(summarized.length, 0, 'neither refusal called the summarizer');

  // A partial miss is also refused: dropping a chunk that the summary would not cover loses context.
  const [only] = await engine.lcm_grep('m1', 's');
  await assert.rejects(
    () => engine.summarizeChunk([only!.id, 'missing' as never], 'LLM-Map'),
    /not in the store/,
  );
  engine.close();
});

test('Agentic-Map needs a sub-agent; asking for it without one is an error, not a fallback', async () => {
  const without = engineWith();
  await addMessages(without.engine, ['m1']);
  const [msg] = await without.engine.lcm_grep('m1', 's');
  await assert.rejects(
    () => without.engine.summarizeChunk([msg!.id], 'Agentic-Map'),
    /no runSubAgent/,
  );
  without.engine.close();

  const calls: string[][] = [];
  const withSub = engineWith({
    runSubAgent: async (_systemPrompt, userMessages) => {
      calls.push(userMessages);
      return 'agentic summary';
    },
  });
  await addMessages(withSub.engine, ['m1', 'm2']);
  const msgs = await withSub.engine.lcm_grep('m', 's');
  const summaryId = await withSub.engine.summarizeChunk(msgs.map((m) => m.id), 'Agentic-Map');

  assert.equal(calls.length, 1, 'the sub-agent produced the summary');
  const expanded = await withSub.engine.lcm_expand(summaryId);
  assert.deepEqual(expanded.map((m) => m.content).sort(), ['m1', 'm2']);
  assert.equal(withSub.summarized.length, 0, 'LLM-Map was not used');
  withSub.engine.close();
});

test('ghost cues are offered newest-first, so the most recent archive is not crowded out', async () => {
  const { engine } = engineWith({ contextThreshold: 1, freshTailCount: 0 });
  await addMessages(engine, ['m1', 'm2', 'm3'], 1);
  const msgs = (await engine.lcm_grep('m', 's')).reverse(); // oldest first
  for (const m of msgs) await engine.summarizeChunk([m.id], 'LLM-Map');

  const ctx = await engine.assembleContext('s', 10_000, 'Dolt');
  assert.equal(ctx.ghosts.length, 3);
  assert.match(ctx.ghosts[0]!.cueText, /summary-3/, 'newest cue first');
  assert.match(ctx.ghosts[2]!.cueText, /summary-1/, 'oldest cue last');
  engine.close();
});
