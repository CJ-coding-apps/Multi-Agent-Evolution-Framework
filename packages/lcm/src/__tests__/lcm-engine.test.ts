import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransportError, makeLcmMessageId, makeNodeId, makeRunId, makeTaskId } from '@maf/types';
import type { LcmDegradedRecord, LcmMessage, LcmMessageId, LcmSummary } from '@maf/types';
import { LcmEngine } from '../LcmEngine.js';
import type { LcmEngineConfig, LcmSummaryCall } from '../LcmEngine.js';
import { LcmStore } from '../LcmStore.js';
import { SessionMerger } from '../SessionMerger.js';
import { estimateTokens, MAX_SUMMARY_PROMPT_CHARS } from '../summarizer.js';

// ORACLE: D-17 mechanism / D-52 choices (WP-3.2). The LCM is judged on what it hands a model:
//   - the fresh tail is the NEWEST messages, returned in reading order;
//   - compaction summarizes exactly the messages it stops returning raw, no more and no fewer;
//   - the budget covers what the injector RENDERS (summaries or cues); the loop's own raw history
//     is not charged, and a summary call's cost is charged separately and reserved first (F2/F10);
//   - every summarization call is bounded by MAX_SUMMARY_PROMPT_CHARS and summarized upward (F4/F9);
//   - a failed compaction degrades and keeps every message raw (F5);
//   - one session has one compaction at a time and one summary per message (F6);
//   - credentials are masked on the way in, through the prompt, and out of the model (F7);
//   - both modes deliver the archive (Dolt: ghost cues, Upward: summaries); `off` delivers nothing;
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

/** Adds `contents` and returns the ids the store assigned, oldest first. */
async function addMessages(engine: LcmEngine, contents: string[], tokens = 10): Promise<LcmMessageId[]> {
  const ids: LcmMessageId[] = [];
  for (const content of contents) {
    ids.push(await engine.addMessage({ sessionId: 's', runId: RUN, role: 'user', content, tokens }));
  }
  return ids;
}

/** Every summary reachable from `id` by following `parentIds`, keyed by id. */
async function summaryTree(engine: LcmEngine, id: string): Promise<Map<string, LcmSummary>> {
  const seen = new Map<string, LcmSummary>();
  const visit = async (summaryId: string): Promise<void> => {
    if (seen.has(summaryId)) return;
    const found = await engine.expandSummary(summaryId);
    assert.ok(found, `summary ${summaryId} expands`);
    seen.set(summaryId, found.summary);
    for (const parentId of found.summary.parentIds) await visit(parentId);
  };
  await visit(id);
  return seen;
}

test('the fresh tail is the newest messages, in reading order, with ties broken by insertion (D-17)', () => {
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

test('compaction summarizes exactly the messages it drops, and keeps the fresh tail raw', async (t) => {
  const { engine, summarized } = engineWith();
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  // 50 raw tokens against a budget of 60: 50 > 60 * 0.75, so compaction runs, and the archive is
  // charged only for what the injector renders — the cue — not for the raw history (F2).
  const ctx = await engine.assembleContext('s', 60);

  assert.equal(summarized.length, 1, 'one summarization call');
  assert.deepEqual(summarized[0]?.map((m) => m.content), ['m1', 'm2', 'm3'], 'the three oldest, and only those');

  assert.deepEqual(ctx.messages.map((m) => m.content), ['m4', 'm5'], 'the newest two stay raw');
  assert.equal(ctx.summaries, undefined, 'Dolt mode offers cues, not summary objects');

  assert.equal(ctx.ghosts.length, 1, 'the archive is offered as a cue');
  const cue = ctx.ghosts[0]!;
  assert.equal(
    ctx.totalTokens,
    estimateTokens(cue.cueText),
    'totalTokens is exactly the rendered cue — the 20 raw tail tokens are not charged',
  );
  assert.equal(ctx.compactionTokens, estimateTokens('summary-1'), 'the summary call is charged separately');
  assert.ok(ctx.totalTokens + ctx.compactionTokens! <= 60, 'the archive share was reserved first');

  const expanded = await engine.lcm_expand(cue.summaryId);
  assert.deepEqual(
    expanded.map((m) => m.content).sort(),
    ['m1', 'm2', 'm3'],
    'the summary expands to exactly the messages that were dropped',
  );

  // A second assembly must not summarize the same messages again.
  await engine.assembleContext('s', 60);
  assert.equal(summarized.length, 1, 'already-summarized messages are not re-summarized');
});

test('no compaction below the threshold, and every message is returned uncharged', async (t) => {
  const { engine, summarized } = engineWith();
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3'], 10);

  const ctx = await engine.assembleContext('s', 1_000);
  assert.equal(summarized.length, 0, 'roomy budget: no summarization call');
  assert.deepEqual(ctx.messages.map((m) => m.content), ['m1', 'm2', 'm3']);
  assert.equal(ctx.totalTokens, 0, 'raw history is the loop\'s own and is not charged (F2)');
  assert.equal(ctx.compactionTokens, undefined, 'no call was made');
});

test('Upward mode returns summaries, Dolt mode returns cues — never both', async (t) => {
  const { engine } = engineWith();
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  const upward = await engine.assembleContext('s', 40, 'Upward');
  assert.equal(upward.summaries?.length, 1, 'Upward: the archive is summary objects');
  assert.equal(upward.summaries?.[0]?.content, 'summary-1');
  assert.deepEqual(upward.ghosts, [], 'Upward does not also emit cues');
  assert.deepEqual(upward.messages.map((m) => m.content), ['m4', 'm5'], 'the fresh tail is unchanged');
  assert.equal(
    upward.totalTokens,
    upward.summaries!.reduce((sum, summary) => sum + summary.tokens, 0),
    'the charged cost is the rendered summaries, not the raw tail',
  );

  // A cue is a sentence, not three tokens, so it needs a budget it actually fits in — and the
  // reason it needs one is the next test's rule: the budget is a ceiling in both modes.
  const dolt = await engine.assembleContext('s', 80, 'Dolt');
  assert.equal(dolt.summaries, undefined, 'Dolt: no summary objects');
  assert.equal(dolt.ghosts.length, 1);
});

test('hierarchical compaction: levels rise, and every level-0 summary is covered by an ancestor (F9)', async (t) => {
  const { engine, summarized } = engineWith({ contextThreshold: 1, freshTailCount: 0, mode: 'Upward' });
  t.after(() => engine.close());
  const ids = await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], 1);

  // Three level-0 roots first, so fitting the archive has to raise them.
  for (let i = 0; i < ids.length; i += 2) {
    await engine.summarizeChunk([ids[i]!, ids[i + 1]!], 'LLM-Map');
  }
  assert.equal(summarized.length, 3, 'three level-0 summaries');

  // Budget 4 holds one 3-token root. The two older roots are raised into a level-1 parent, then
  // that parent and the newest root into a level-2 root: nothing is skipped without a covering
  // parent (the pre-F9 behavior dropped the oldest root instead).
  const ctx = await engine.assembleContext('s', 4, 'Upward');
  assert.equal(ctx.summaries?.length, 1, 'one root survives the fit');
  const root = ctx.summaries![0]!;
  assert.equal(root.level, 2, 'the roots were raised twice');

  const tree = await summaryTree(engine, root.id);
  const levels = [...tree.values()].map((summary) => summary.level);
  assert.deepEqual([...new Set(levels)].sort(), [0, 1, 2], 'all three levels exist');

  const parentsOf = new Set([...tree.values()].flatMap((summary) => summary.parentIds));
  for (const summary of tree.values()) {
    if (summary.level !== 0) continue;
    assert.ok(parentsOf.has(summary.id), `level-0 summary ${summary.id} has a covering ancestor`);
  }

  const expanded = await engine.expandSummary(root.id);
  assert.deepEqual(
    expanded!.messages.map((m) => m.content).sort(),
    ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
    'the root expands to every message in its segment',
  );
});

test('the budget is a ceiling in both modes', async (t) => {
  const { engine } = engineWith();
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5'], 10);

  for (const mode of ['Dolt', 'Upward'] as const) {
    for (const budget of [1, 5, 12, 20, 40, 500]) {
      const ctx = await engine.assembleContext('s', budget, mode);
      assert.ok(
        ctx.totalTokens <= budget,
        `${mode} at budget ${budget}: reported ${ctx.totalTokens} tokens`,
      );
    }
  }

  const zero = await engine.assembleContext('s', 0, 'Upward');
  assert.deepEqual(zero.messages, []);
  assert.deepEqual(zero.summaries, []);
  assert.equal(zero.totalTokens, 0);
});

test('a summary call is recorded with its surface and trigger, and charged to the budget (F1/F10)', async (t) => {
  const calls: LcmSummaryCall[] = [];
  const trigger = { taskId: makeTaskId('task-1'), nodeId: makeNodeId('node-1') };
  const { engine } = engineWith({
    mode: 'Upward',
    summarize: async () => ({
      content: 'summary text',
      tokensUsed: 1_234,
      model: 'lcm-model',
      surface: {
        systemPromptSha256: 'a'.repeat(64),
        toolCatalog: '',
        argv: [],
        promptSha256: 'b'.repeat(64),
        outputSha256: 'c'.repeat(64),
      },
    }),
    recordSummaryCall: (call) => { calls.push(call); },
  });
  t.after(() => engine.close());
  const ids = await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  const ctx = await engine.assembleContext('s', 60, 'Upward', trigger);
  assert.equal(calls.length, 1, 'one call, one record');
  const call = calls[0]!;
  assert.equal(call.level, 0);
  assert.deepEqual(call.messageIds, ids.slice(0, 3));
  assert.deepEqual(call.trigger, trigger, 'the record names the node that asked');
  assert.equal(call.model, 'lcm-model');
  assert.equal(call.surface?.systemPromptSha256, 'a'.repeat(64));
  assert.equal(call.surface?.promptSha256, 'b'.repeat(64));
  assert.equal(call.surface?.outputSha256, 'c'.repeat(64));
  assert.equal(call.contentTokens, estimateTokens('summary text'));
  assert.equal(call.reportedTokens, 1_234, 'the backend count is on the record');

  assert.equal(ctx.compactionTokens, 1_234, 'and it is charged to the node');
  const surface = ctx.summaryCalls?.[0];
  assert.equal(surface?.reportedTokens, 1_234);
  assert.equal(surface?.contentTokens, estimateTokens('summary text'));

  const expanded = await engine.expandSummary(call.summaryId);
  assert.equal(
    expanded!.summary.tokens,
    estimateTokens('summary text'),
    'the stored summary is sized by its own content, not by the call\'s reported tokens',
  );
});

test('every summarization call is bounded, and the summaries are raised to one root (F4)', async (t) => {
  const rendered: number[] = [];
  const perMessage: number[] = [];
  const { engine } = engineWith({
    summarize: async (messages) => {
      rendered.push(messages.reduce((sum, message) => sum + message.content.length + 32, 0));
      perMessage.push(Math.max(...messages.map((message) => message.content.length)));
      return `s-${rendered.length}`;
    },
  });
  t.after(() => engine.close());

  const ids = await addMessages(engine, Array.from({ length: 70 }, () => 'x'.repeat(64_000)), 1);
  const summaryId = await engine.summarizeChunk(ids.map((id) => makeLcmMessageId(id)), 'LLM-Map');

  assert.equal(rendered.length, 71, '70 bounded level-0 calls, then one level-1 call');
  assert.ok(
    Math.max(...rendered) <= MAX_SUMMARY_PROMPT_CHARS,
    `largest rendered prompt ${Math.max(...rendered)} exceeds ${MAX_SUMMARY_PROMPT_CHARS}`,
  );
  assert.ok(
    Math.max(...perMessage) < MAX_SUMMARY_PROMPT_CHARS,
    'no single message fragment reaches the OS single-argument limit',
  );

  const expanded = await engine.expandSummary(summaryId);
  assert.deepEqual(
    new Set(expanded!.messages.map((m) => m.id)),
    new Set(ids),
    'the root covers all 70 messages',
  );
});

test('a transport failure is retried; a verdict is not (F5)', async (t) => {
  let transportAttempts = 0;
  const retried = new LcmEngine({
    dbPath: ':memory:', contextThreshold: 0.75, freshTailCount: 0, mode: 'Upward',
    summarize: async () => {
      transportAttempts += 1;
      if (transportAttempts === 1) throw new TransportError('backend timed out');
      return 'recovered';
    },
  });
  t.after(() => retried.close());
  const [retryId] = await addMessages(retried, ['m1']);
  const retrySummary = await retried.summarizeChunk([makeLcmMessageId(retryId!)], 'LLM-Map');
  assert.equal(transportAttempts, 2, 'the transport failure was asked again');
  assert.equal((await retried.expandSummary(retrySummary))!.summary.content, 'recovered');

  let verdictAttempts = 0;
  const verdict = new LcmEngine({
    dbPath: ':memory:', contextThreshold: 0.75, freshTailCount: 0, mode: 'Upward',
    summarize: async () => {
      verdictAttempts += 1;
      throw new Error('the model refused');
    },
  });
  t.after(() => verdict.close());
  const [verdictId] = await addMessages(verdict, ['m1']);
  await assert.rejects(
    () => verdict.summarizeChunk([makeLcmMessageId(verdictId!)], 'LLM-Map'),
    /the model refused/,
  );
  assert.equal(verdictAttempts, 1, 'a judgement is terminal, never retried');
});

test('a compaction that fails degrades: every message stays raw and the failure is recorded (F5)', async (t) => {
  const degraded: LcmDegradedRecord[] = [];
  const { engine } = engineWith({
    mode: 'Upward',
    summarize: async () => { throw new Error('backend down'); },
    onDegraded: (record) => { degraded.push(record); },
  });
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  const ctx = await engine.assembleContext('s', 60, 'Upward', {
    taskId: makeTaskId('t'), nodeId: makeNodeId('n'),
  });

  assert.equal(degraded.length, 1, 'the caller was told');
  assert.match(degraded[0]!.reason, /backend down/);
  assert.equal(degraded[0]!.taskId, 't');
  assert.equal(degraded[0]!.nodeId, 'n');
  assert.equal(ctx.degraded?.[0]?.reason, 'backend down', 'the context carries the same record');
  assert.deepEqual(
    ctx.messages.map((m) => m.content),
    ['m1', 'm2', 'm3', 'm4', 'm5'],
    'nothing is dropped without a summary that covers it (E10)',
  );
  assert.deepEqual(ctx.summaries, []);
  assert.equal(ctx.totalTokens, 0);
});

test('four concurrent assemblies make one call and cover each message exactly once (F6)', async (t) => {
  const summarized: LcmMessage[][] = [];
  const { engine } = engineWith({
    summarize: async (messages) => {
      summarized.push(messages);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `summary-${summarized.length}`;
    },
  });
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  const contexts = await Promise.all(
    [0, 1, 2, 3].map(() => engine.assembleContext('s', 60, 'Dolt')),
  );

  assert.equal(summarized.length, 1, 'the session lock serialized the passes');
  for (const ctx of contexts) {
    assert.equal(ctx.ghosts.length, 1, 'every assembly sees the same archive');
    assert.deepEqual(ctx.messages.map((m) => m.content), ['m4', 'm5']);
  }

  const summaryId = contexts[0]!.ghosts[0]!.summaryId;
  const expanded = await engine.lcm_expand(summaryId);
  assert.deepEqual(
    expanded.map((m) => m.content).sort(),
    ['m1', 'm2', 'm3'],
    'each message belongs to exactly one summary',
  );
});

test('credentials are masked into the archive, through the prompt, and out of the model (F7)', async (t) => {
  const prompts: string[] = [];
  const { engine } = engineWith({
    summarize: async (messages) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return { content: 'the model echoed AKIAIOSFODNN7EXAMPLE back' };
    },
  });
  t.after(() => engine.close());

  const id = await engine.addMessage({
    sessionId: 's', runId: RUN, role: 'user',
    content: 'aws: AKIAIOSFODNN7EXAMPLE', tokens: 5,
  });

  const [stored] = await engine.lcm_grep('aws', 's');
  assert.doesNotMatch(stored!.content, /AKIAIOSFODNN7EXAMPLE/, 'the store keeps no key');
  assert.match(stored!.content, /\[REDACTED:aws-access-key\]/);

  const summaryId = await engine.summarizeChunk([id], 'LLM-Map');
  assert.doesNotMatch(prompts[0]!, /AKIAIOSFODNN7EXAMPLE/, 'the summarizer never sees the key');
  assert.match(prompts[0]!, /\[REDACTED:aws-access-key\]/);

  const expanded = await engine.expandSummary(summaryId);
  assert.doesNotMatch(
    expanded!.summary.content,
    /AKIAIOSFODNN7EXAMPLE/,
    'a key the model echoed does not reach the archive',
  );
  assert.match(expanded!.summary.content, /\[REDACTED:aws-access-key\]/);
});

test('summarizeChunk refuses an empty chunk and an id it does not hold (D-17)', async (t) => {
  const { engine, summarized } = engineWith();
  t.after(() => engine.close());
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
});

test('Agentic-Map needs a sub-agent; asking for it without one is an error, not a fallback', async (t) => {
  const without = engineWith();
  t.after(() => without.engine.close());
  await addMessages(without.engine, ['m1']);
  const [msg] = await without.engine.lcm_grep('m1', 's');
  await assert.rejects(
    () => without.engine.summarizeChunk([msg!.id], 'Agentic-Map'),
    /no runSubAgent/,
  );

  const calls: string[][] = [];
  const withSub = engineWith({
    runSubAgent: async (_systemPrompt, userMessages) => {
      calls.push(userMessages);
      return 'agentic summary';
    },
  });
  t.after(() => withSub.engine.close());
  await addMessages(withSub.engine, ['m1', 'm2']);
  const msgs = await withSub.engine.lcm_grep('m', 's');
  const summaryId = await withSub.engine.summarizeChunk(msgs.map((m) => m.id), 'Agentic-Map');

  assert.equal(calls.length, 1, 'the sub-agent produced the summary');
  const expanded = await withSub.engine.lcm_expand(summaryId);
  assert.deepEqual(expanded.map((m) => m.content).sort(), ['m1', 'm2']);
  assert.equal(withSub.summarized.length, 0, 'LLM-Map was not used');
});

test('lcm.mode off compacts and summarizes nothing (F14)', async (t) => {
  const { engine, summarized } = engineWith({ mode: 'off' });
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  const ctx = await engine.assembleContext('s', 1);
  assert.equal(summarized.length, 0, 'no summarization call');
  assert.deepEqual(ctx.messages, []);
  assert.deepEqual(ctx.ghosts, []);
  assert.equal(ctx.totalTokens, 0);
  assert.equal(ctx.summaries, undefined);
  assert.equal(ctx.compactionTokens, undefined);

  // An explicit mode overrides the engine's configured one in both directions.
  const other = engineWith({ mode: 'Upward' });
  t.after(() => other.engine.close());
  await addMessages(other.engine, ['m1', 'm2', 'm3', 'm4', 'm5']);
  const off = await other.engine.assembleContext('s', 1, 'off');
  assert.equal(other.summarized.length, 0);
  assert.deepEqual(off.messages, []);
  assert.equal(off.summaries, undefined);
});

test('ghost cues are offered newest-first, so the most recent archive is not crowded out', async (t) => {
  const { engine } = engineWith({ contextThreshold: 1, freshTailCount: 0 });
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3'], 1);
  const msgs = (await engine.lcm_grep('m', 's')).reverse(); // oldest first
  for (const m of msgs) await engine.summarizeChunk([m.id], 'LLM-Map');

  const ctx = await engine.assembleContext('s', 10_000, 'Dolt');
  assert.equal(ctx.ghosts.length, 3);
  assert.match(ctx.ghosts[0]!.cueText, /summary-3/, 'newest cue first');
  assert.match(ctx.ghosts[2]!.cueText, /summary-1/, 'oldest cue last');
  // F8: the cue names the tool the role registries actually carry. `lcm_expand` (the underscore
  // spelling) was the engine method, not a tool id, so a model that followed the cue could not call it.
  assert.ok(
    ctx.ghosts[0]!.cueText.includes(`call lcm.expand("${ctx.ghosts[0]!.summaryId}")`),
    'the cue names the tool and the id it expands',
  );
  assert.doesNotMatch(ctx.ghosts[0]!.cueText, /lcm_expand/);
});

test('a merged run keeps its summaries and can expand them from the target session (F3)', async () => {
  const store = new LcmStore(':memory:');
  try {
    const source = makeRunId('source-run');
    const target = makeRunId('target-run');
    const ids = ['m1', 'm2'].map((content) =>
      store.insertMessage({ sessionId: source, runId: source, role: 'user', content, tokens: 1 }),
    );
    const summaryId = store.insertSummary('summary', 2, 0, 'LLM-Map', [], ids);
    store.markSummarized(ids, summaryId);

    await new SessionMerger(store).mergeRuns([source], target);

    const copies = store.getMessagesBySession(target);
    assert.equal(copies.length, 2, 'the messages were copied');
    assert.ok(copies.every((message) => message.summaryId === summaryId), 'each copy points at the archive');

    const summaries = store.getSummariesForSession(target);
    assert.equal(summaries.length, 1, 'the summary itself is shared, not duplicated');
    assert.equal(summaries[0]!.id, summaryId, 'the same summary serves both sessions');
    const linked = new Set(summaries[0]!.messageIds);
    for (const copy of copies) {
      assert.ok(linked.has(copy.id), `the summary is linked to the target's copy ${copy.id}`);
    }
  } finally {
    store.close();
  }
});
