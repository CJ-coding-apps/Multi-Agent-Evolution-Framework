import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TransportError, makeLcmMessageId, makeNodeId, makeRunId, makeTaskId } from '@maf/types';
import type { LcmDegradedRecord, LcmMessage, LcmMessageId, LcmSummary } from '@maf/types';
import { LcmEngine } from '../LcmEngine.js';
import type { LcmEngineConfig, LcmSummaryCall } from '../LcmEngine.js';
import { LcmStore } from '../LcmStore.js';
import { SessionMerger } from '../SessionMerger.js';
import {
  estimateTokens, byteLength, MAX_SUMMARY_ARGV_BYTES, MAX_SUMMARY_PROMPT_BYTES,
  SUMMARY_ARGV_ALLOWANCE_BYTES,
} from '../summarizer.js';

// ORACLE: D-17 mechanism / D-52 choices (WP-3.2, round 2). The LCM is judged on what it hands a
// model:
//   - the fresh tail is the NEWEST messages; they are rendered as `<recent>`, newest first, after
//     the archive and inside the same budget (R4c). The tail that stays raw is WHAT WAS RENDERED,
//     not a fixed count: a message that does not fit is compacted at that same assembly, so every
//     message is rendered, covered by a summary, or newer (V1);
//   - compaction summarizes exactly the messages it stops returning raw, no more and no fewer;
//   - the budget covers what the injector RENDERS (summaries or cues, plus `<recent>`). A summary
//     call's cost is a budget record (`compactionTokens`) and never a reservation out of that room
//     (R2): room is about rendered size, cost is about the call;
//   - every summarization call is bounded in BYTES, prompt and system prompt together, and the
//     summaries are raised upward (F4/F9/R3);
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

test('compaction summarizes exactly the messages it drops, and renders the tail inside the same budget (R4c)', async (t) => {
  const { engine, summarized } = engineWith();
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  // 50 raw tokens against a budget of 60: 50 > 60 * 0.75, so compaction runs. The archive is
  // charged for what the injector renders — the cue — and the newest messages are rendered as
  // `<recent>` after it, inside the same 60-token room (R4c).
  const ctx = await engine.assembleContext('s', 60);

  assert.equal(summarized.length, 1, 'one summarization call');
  assert.deepEqual(summarized[0]?.map((m) => m.content), ['m1', 'm2', 'm3'], 'the three oldest, and only those');

  assert.deepEqual(ctx.messages.map((m) => m.content), ['m5', 'm4'], 'the newest two stay raw, newest first');
  assert.equal(ctx.summaries, undefined, 'Dolt mode offers cues, not summary objects');

  assert.equal(ctx.ghosts.length, 1, 'the archive is offered as a cue');
  const cue = ctx.ghosts[0]!;
  assert.ok(ctx.totalTokens <= 60, `rendered ${ctx.totalTokens} tokens for a 60-token budget`);
  assert.ok(
    ctx.totalTokens > estimateTokens(cue.cueText),
    'the recent messages are rendered too, and charged with the cue (R4c)',
  );
  assert.equal(ctx.compactionTokens, estimateTokens('summary-1'), 'the summary call is charged separately');
  // R2: the call's cost is a record, not a reservation out of the rendered room. The round-1 bug
  // subtracted it here, which on a backend that reports tokens emptied the archive.
  assert.ok(
    ctx.totalTokens + ctx.compactionTokens! > 60,
    'the rendered room is not reduced by the call\'s cost',
  );

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

test('no compaction below the threshold; the recent messages are rendered and charged (R4c)', async (t) => {
  const { engine, summarized } = engineWith();
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3'], 10);

  const ctx = await engine.assembleContext('s', 1_000);
  assert.equal(summarized.length, 0, 'roomy budget: no summarization call');
  assert.deepEqual(ctx.messages.map((m) => m.content), ['m3', 'm2', 'm1'], 'newest first (R4c)');
  assert.equal(ctx.summaries, undefined, 'Dolt with no archive has nothing to offer');
  assert.deepEqual(ctx.ghosts, []);
  assert.ok(ctx.totalTokens > 0, 'the injector renders these messages, so they are charged');
  assert.ok(ctx.totalTokens <= 1_000);
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
  assert.deepEqual(upward.messages.map((m) => m.content), ['m5', 'm4'], 'the fresh tail is unchanged, newest first');
  assert.ok(
    upward.totalTokens > upward.summaries!.reduce((sum, summary) => sum + summary.tokens, 0),
    'the summaries and the recent messages are both rendered, and both are charged (R4c)',
  );
  assert.ok(upward.totalTokens <= 40, 'and both stay inside the one budget');

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
  assert.equal(
    call.tokenBudgetCharged,
    1_234,
    'R5: what the call spent is the backend\'s count when it reports one',
  );

  assert.equal(ctx.compactionTokens, 1_234, 'and it is charged to the node');
  const surface = ctx.summaryCalls?.[0];
  assert.equal(surface?.reportedTokens, 1_234);
  assert.equal(surface?.contentTokens, estimateTokens('summary text'));
  assert.equal(surface?.tokenBudgetCharged, 1_234);

  const expanded = await engine.expandSummary(call.summaryId);
  assert.equal(
    expanded!.summary.tokens,
    estimateTokens('summary text'),
    'the stored summary is sized by its own content, not by the call\'s reported tokens',
  );
});

test('every summarization call is bounded in bytes, and the summaries are raised to one root (F4/R3)', async (t) => {
  const rendered: number[] = [];
  const perMessage: number[] = [];
  const { engine } = engineWith({
    summarize: async (messages) => {
      // The prompt as the run's summarizer renders it (AdapterSummarizer: `[ROLE] content`).
      rendered.push(byteLength(messages.map((m) => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')));
      perMessage.push(Math.max(...messages.map((m) => byteLength(m.content))));
      return `s-${rendered.length}`;
    },
  });
  t.after(() => engine.close());

  const ids = await addMessages(engine, Array.from({ length: 70 }, () => 'x'.repeat(64_000)), 1);
  const summaryId = await engine.summarizeChunk(ids.map((id) => makeLcmMessageId(id)), 'LLM-Map');

  assert.equal(rendered.length, 71, '70 bounded level-0 calls, then one level-1 call');
  assert.ok(
    Math.max(...rendered) <= MAX_SUMMARY_PROMPT_BYTES,
    `largest rendered prompt ${Math.max(...rendered)} bytes exceeds ${MAX_SUMMARY_PROMPT_BYTES}`,
  );
  assert.ok(
    Math.max(...rendered) + SUMMARY_ARGV_ALLOWANCE_BYTES <= MAX_SUMMARY_ARGV_BYTES,
    'the prompt leaves the rest of the command line inside its cap',
  );
  assert.ok(
    Math.max(...perMessage) < MAX_SUMMARY_PROMPT_BYTES,
    'no single message fragment reaches the OS single-argument limit',
  );

  const expanded = await engine.expandSummary(summaryId);
  assert.deepEqual(
    new Set(expanded!.messages.map((m) => m.id)),
    new Set(ids),
    'the root covers all 70 messages',
  );
});

test('the byte cap holds for multi-byte text, where a character cap did not (R3)', async (t) => {
  // 60,000 `'中'` is 60,000 UTF-16 code units but 180,000 bytes: comfortably under a 64 KiB
  // CHARACTER cap, and far over the 128 KiB the operating system allows one argv argument. The
  // round-1 implementation measured characters and would have handed this to the backend whole.
  const rendered: number[] = [];
  const { engine } = engineWith({
    contextThreshold: 0,
    freshTailCount: 0,
    mode: 'Upward',
    summarize: async (messages) => {
      rendered.push(byteLength(messages.map((m) => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')));
      return `summary-${rendered.length}`;
    },
  });
  t.after(() => engine.close());

  const big = '中'.repeat(60_000);
  assert.equal(byteLength(big), 180_000, 'the fixture is what the test says it is');
  const ids = await addMessages(engine, [big, big, big, big], 1);

  const ctx = await engine.assembleContext('s', 100, 'Upward');
  assert.equal(ctx.degraded, undefined, 'every call fit; nothing degraded');
  assert.ok(rendered.length > 4, 'the four messages were split across more than four calls');
  assert.ok(
    Math.max(...rendered) <= MAX_SUMMARY_PROMPT_BYTES,
    `largest rendered prompt ${Math.max(...rendered)} bytes exceeds ${MAX_SUMMARY_PROMPT_BYTES}`,
  );
  assert.ok(
    Math.max(...rendered) + SUMMARY_ARGV_ALLOWANCE_BYTES <= MAX_SUMMARY_ARGV_BYTES,
    'every call, with the summarizer\'s own flags, is inside the command-line cap',
  );

  const root = ctx.summaries?.[0];
  assert.ok(root, 'the archive is rendered as a summary');
  const expanded = await engine.expandSummary(root.id);
  assert.deepEqual(
    new Set(expanded!.messages.map((m) => m.id)),
    new Set(ids),
    'no message was lost to a chunk boundary',
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

test('a compaction that fails degrades: nothing leaves the store, and the failure is recorded (F5)', async (t) => {
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
  // F5: compaction failed, so nothing was summarized and nothing is covered. The node gets the
  // newest messages that fit, and the rest stay raw in the store rather than being dropped; they
  // are shown on a later assembly, when a compaction succeeds.
  assert.deepEqual(
    ctx.messages.map((m) => m.content),
    ['m5', 'm4', 'm3', 'm2'],
    'the newest messages that fit, newest first; the fifth is still stored, not dropped',
  );
  assert.deepEqual(ctx.summaries, []);
  assert.ok(ctx.totalTokens <= 60);
});

test('a message the budget cannot hold is compacted now, not left in a gap (V1)', async (t) => {
  const { engine, summarized } = engineWith({ mode: 'Upward' });
  t.after(() => engine.close());
  await addMessages(engine, ['older message', 'newest message']);

  // Room for the wrapper and one message only. The newest is tried first; the older does not fit,
  // so it is summarized at this same assembly. The rule this replaces left it in neither the
  // prompt nor any summary until `freshTailCount` newer messages arrived (V1).
  const ctx = await engine.assembleContext('s', 25, 'Upward');
  assert.deepEqual(
    summarized[0]?.map((m) => m.content),
    ['older message'],
    'the message that did not fit was compacted at this assembly',
  );
  assert.ok(summarized.length >= 1);

  const stored = await engine.lcm_grep('message', 's');
  const older = stored.find((m) => m.content === 'older message');
  assert.ok(older, 'the message stays in the store');
  assert.ok(older.summaryId, 'and is behind a summary, not in the gap');
  const expanded = await engine.lcm_expand(older.summaryId);
  assert.deepEqual(expanded.map((m) => m.content), ['older message'], 'nothing was lost');

  // The other message may be rendered or, if the new summary left no room, compacted as well.
  // The guarantee is coverage, not a fixed tail.
  const newest = stored.find((m) => m.content === 'newest message');
  const rendered = new Set(ctx.messages.map((m) => m.id));
  assert.ok(newest && (rendered.has(newest.id) || newest.summaryId !== undefined),
    'the second message is rendered or summarized too');
});

test('every message is rendered, summarized, or newer — at every assembly (V1)', async () => {
  // The verifier's guarantee, enforced mechanically: at every point where a prompt is assembled,
  // every message in the session is either shown in `<recent>`, covered by a summary (directly or
  // through an ancestor), or newer than that moment. The rule this replaces said a message that
  // did not fit was "summarized at the next compaction" — but compaction never touched the newest
  // 64, so with defaults 33 messages sat in the gap, and it grew with every message.
  //
  // Two configurations run over ten assemblies each: the CLI's defaults (tail 64, threshold 0.75),
  // whose band the verifier measured, and the small-budget config that made the gap obvious
  // (tail 2, threshold 0.1). The gap was not a first-assembly artifact, so neither is the test.
  const scenarios = [
    { name: 'defaults', budget: 4089, contextThreshold: 0.75, freshTailCount: 64 },
    { name: 'small budget', budget: 4089, contextThreshold: 0.1, freshTailCount: 2 },
  ];

  for (const scenario of scenarios) {
    const dir = await mkdtemp(path.join(tmpdir(), 'maf-lcm-v1-'));
    const dbPath = path.join(dir, 'lcm.db');
    let calls = 0;
    const engine = new LcmEngine({
      dbPath,
      contextThreshold: scenario.contextThreshold,
      freshTailCount: scenario.freshTailCount,
      mode: 'Upward',
      summarize: async () => {
        calls += 1;
        // A summary much smaller than the messages it covers, as a real one is: each pass frees
        // more room than the summary takes, so the loop converges rather than spiralling.
        return `summary-${calls} ${'x'.repeat(160)}`;
      },
    });
    // A second connection reads what the engine committed, so "covered" is measured in the store
    // the next run would read, not in the context the engine chose to return.
    const store = new LcmStore(dbPath);
    try {
      for (let batch = 1; batch <= 10; batch++) {
        for (let i = 1; i <= 10; i++) {
          const content = `message-${(batch - 1) * 10 + i} ${'y'.repeat(400)}`;
          await engine.addMessage({ sessionId: 's', runId: RUN, role: 'user', content, tokens: 100 });
        }
        const ctx = await engine.assembleContext('s', scenario.budget, 'Upward');
        const rendered = new Set(ctx.messages.map((m) => m.id));
        const messages = store.getMessagesBySession('s');

        const hidden = messages.filter((m) => !rendered.has(m.id) && m.summaryId === undefined);
        assert.deepEqual(
          hidden.map((m) => m.content.slice(0, 12)), [],
          `${scenario.name}: after ${messages.length} messages, nothing is in neither the prompt nor a summary`,
        );

        // "Covered" is not just a non-null id: the summary it names must actually hold the text.
        for (const message of messages) {
          if (message.summaryId === undefined) continue;
          const summary = store.getSummary(message.summaryId);
          assert.ok(
            summary?.messageIds.includes(message.id),
            `${scenario.name}: ${message.summaryId} covers ${message.content.slice(0, 12)}`,
          );
        }
      }
      assert.ok(calls > 0, `${scenario.name}: the scenario compacted something`);
    } finally {
      engine.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
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
    assert.deepEqual(ctx.messages.map((m) => m.content), ['m5', 'm4'], 'newest first (R4c)');
  }

  const summaryId = contexts[0]!.ghosts[0]!.summaryId;
  const expanded = await engine.lcm_expand(summaryId);
  assert.deepEqual(
    expanded.map((m) => m.content).sort(),
    ['m1', 'm2', 'm3'],
    'each message belongs to exactly one summary',
  );
});

// Each masking layer is pinned on its own (F7, R8): a test that asserts all three at once passes
// while any one of them still works, which is how a layer can regress unnoticed.

test('a credential is masked on the way into the store (F7a)', async (t) => {
  const { engine } = engineWith();
  t.after(() => engine.close());

  await engine.addMessage({
    sessionId: 's', runId: RUN, role: 'user',
    content: 'aws: AKIAIOSFODNN7EXAMPLE', tokens: 5,
  });

  const [stored] = await engine.lcm_grep('aws', 's');
  assert.doesNotMatch(stored!.content, /AKIAIOSFODNN7EXAMPLE/, 'the store keeps no key');
  assert.match(stored!.content, /\[REDACTED:aws-access-key\]/);
});

test('a key already in the store is masked before the summarizer sees it (F7b)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-lcm-mask-'));
  const dbPath = path.join(dir, 'lcm.db');
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Written straight to the store, not through `addMessage`: this is the shape of a database
  // written by an older version, or by any writer that did not pass the engine's front door. The
  // prompt boundary must hold on its own.
  const store = new LcmStore(dbPath);
  const id = store.insertMessage({
    sessionId: 's', runId: RUN, role: 'user', content: 'aws: AKIAIOSFODNN7EXAMPLE', tokens: 5,
  });
  store.close();

  const prompts: string[] = [];
  const engine = new LcmEngine({
    dbPath, contextThreshold: 0.75, freshTailCount: 0, mode: 'Upward',
    summarize: async (messages) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return 'ok';
    },
  });
  t.after(() => engine.close());

  await engine.summarizeChunk([id], 'LLM-Map');
  assert.doesNotMatch(prompts[0]!, /AKIAIOSFODNN7EXAMPLE/, 'the summarizer never sees the key');
  assert.match(prompts[0]!, /\[REDACTED:aws-access-key\]/);
});

test('a key the model echoes is masked out of the stored summary (F7c)', async (t) => {
  const { engine } = engineWith({
    summarize: async () => ({ content: 'the model echoed AKIAIOSFODNN7EXAMPLE back' }),
  });
  t.after(() => engine.close());
  const [id] = await addMessages(engine, ['m1'], 1);

  const summaryId = await engine.summarizeChunk([id!], 'LLM-Map');
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

// ── Round-2 rulings ──────────────────────────────────────────────────────────

test('a backend that reports token usage does not shrink the room it renders into (R2)', async (t) => {
  // The round-1 bug returned on exactly the backends that report a count: the call's cost was
  // subtracted from the prompt's free space, so a 9,000-token report against a 60-token budget
  // emptied the archive. Room is about rendered size; the call is about the call.
  const { engine } = engineWith({
    mode: 'Upward',
    summarize: async () => ({ content: 'summary-1', tokensUsed: 9_000 }),
  });
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  const ctx = await engine.assembleContext('s', 60, 'Upward');
  assert.equal(ctx.summaries?.length, 1, 'the archive is still in the prompt');
  assert.equal(ctx.messages.length, 2, 'and the newest messages still fit beside it');
  assert.ok(ctx.totalTokens <= 60, `rendered ${ctx.totalTokens} tokens for a 60-token budget`);
  assert.equal(ctx.compactionTokens, 9_000, 'the call is charged to the record, not to the room');
});

test('a call that reports no count is charged input plus output (R5)', async (t) => {
  // R5: record always. When the backend reports nothing, the charge is this package's estimate —
  // the rendered prompt plus the summary — and it is on both records even though no built-in role
  // sets a `tokenBudget` to enforce it against.
  const calls: LcmSummaryCall[] = [];
  const { engine } = engineWith({
    mode: 'Upward',
    summarize: async () => 'summary-1',
    recordSummaryCall: (call) => { calls.push(call); },
  });
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4', 'm5']);

  const ctx = await engine.assembleContext('s', 60, 'Upward');
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  // The prompt is `[USER] m1\n[USER] m2\n[USER] m3` (29 chars → 8 tokens); `summary-1` is 3.
  assert.equal(call.tokenBudgetCharged, 11, 'input plus output, estimated');
  assert.equal(call.reportedTokens, undefined, 'nothing was reported, and nothing was invented');
  assert.equal(ctx.compactionTokens, 3, 'what compaction records is what the call produced');
  assert.equal(ctx.summaryCalls?.[0]?.tokenBudgetCharged, 11);
});

test('expand is scoped to its own run, though the database outlives the run (R9)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-lcm-runs-'));
  const dbPath = path.join(dir, 'lcm.db');
  t.after(() => rm(dir, { recursive: true, force: true }));

  const engineFor = (sessionId: string, summary: string) => new LcmEngine({
    dbPath, sessionId, contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async () => summary,
  });

  const runA = engineFor('run-a', 'summary from run A');
  const aId = await runA.addMessage({
    sessionId: 'run-a', runId: makeRunId('run-a'), role: 'user', content: 'A only', tokens: 1,
  });
  const aSummary = await runA.summarizeChunk([aId], 'LLM-Map');
  assert.ok(await runA.expandSummary(aSummary), 'run A can expand its own archive');
  runA.close();

  const runB = engineFor('run-b', 'summary from run B');
  t.after(() => runB.close());
  const bId = await runB.addMessage({
    sessionId: 'run-b', runId: makeRunId('run-b'), role: 'user', content: 'B only', tokens: 1,
  });
  const bSummary = await runB.summarizeChunk([bId], 'LLM-Map');

  assert.equal(
    await runB.expandSummary(aSummary),
    undefined,
    'run B cannot read the summary run A left in the shared .maf/lcm.db',
  );
  assert.deepEqual(await runB.lcm_expand(aSummary), [], 'and the tool shape is empty, not a partial read');
  assert.ok(await runB.expandSummary(bSummary), 'its own archive still resolves');

  // The scoping is the engine's, not the store's: an unscoped engine over the same file — a test,
  // or a merge tool acting deliberately — can still read both. Every other read names its session
  // explicitly (`lcm_grep`, `assembleContext`), so `expandSummary` was the one that crossed runs.
  const unscoped = new LcmEngine({
    dbPath, contextThreshold: 1, freshTailCount: 0, mode: 'Upward', summarize: async () => 'x',
  });
  t.after(() => unscoped.close());
  assert.ok(await unscoped.expandSummary(aSummary));
  assert.ok(await unscoped.expandSummary(bSummary));
});

test('a credential the model echoes at a raise level is masked too (R10)', async (t) => {
  // Level-0 output was masked; the text that `raise` composed from a model's answer was not. Both
  // are stored summaries and both are shown by `lcm.expand`.
  const { engine } = engineWith({
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (_messages, depth) => (
      depth === 0 ? 'ordinary summary' : 'the model echoed AKIAIOSFODNN7EXAMPLE back'
    ),
  });
  t.after(() => engine.close());

  // Two 40,000-byte messages are two prompts, so the two level-0 summaries are raised together.
  const ids = await addMessages(engine, ['a'.repeat(40_000), 'b'.repeat(40_000)], 1);
  const rootId = await engine.summarizeChunk(ids, 'LLM-Map');

  const root = (await engine.expandSummary(rootId))!.summary;
  assert.equal(root.level, 1, 'the two level-0 summaries were raised');
  assert.doesNotMatch(root.content, /AKIAIOSFODNN7EXAMPLE/, 'the raise masks what the model echoed');
  assert.match(root.content, /\[REDACTED:aws-access-key\]/);
});

test('a child too large for one prompt is split across parents that each name it (R11)', async (t) => {
  let call = 0;
  const { engine } = engineWith({
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (_messages, depth) => {
      if (depth > 0) return 'parent summary';
      call += 1;
      return call === 1 ? 'x'.repeat(150_000) : 'small child';
    },
  });
  t.after(() => engine.close());

  // Two prompts make two level-0 summaries: the first is 150,000 bytes (three bounded units), the
  // second is small (one). The split is real — each parent names exactly the children whose text
  // it saw, rather than all of them being claimed by the first parent.
  const ids = await addMessages(engine, ['a'.repeat(40_000), 'b'.repeat(40_000)], 1);
  const rootId = await engine.summarizeChunk(ids, 'LLM-Map');

  const root = (await engine.expandSummary(rootId))!.summary;
  assert.equal(root.level, 2, 'the level-1 parents were raised to one root');

  const tree = await summaryTree(engine, rootId);
  const hugeChild = [...tree.values()].find((s) => s.level === 0 && s.content.length === 150_000);
  assert.ok(hugeChild, 'the oversized level-0 summary is in the tree');
  const smallChild = [...tree.values()].find((s) => s.level === 0 && s.id !== hugeChild.id);
  assert.ok(smallChild, 'the small level-0 summary is in the tree too');

  const level1 = [...tree.values()].filter((s) => s.level === 1);
  const namingHuge = level1.filter((s) => s.parentIds.includes(hugeChild.id));
  assert.equal(namingHuge.length, 3, 'the child is split across three parents, not truncated into one');
  assert.equal(
    namingHuge.flatMap((s) => s.parentIds).filter((id) => id === hugeChild.id).length,
    3,
    'each of those parents names it exactly once — no parent claims text it never saw',
  );
  const namingSmall = level1.filter((s) => s.parentIds.includes(smallChild.id));
  assert.equal(namingSmall.length, 1, 'the small child fits one prompt, so one parent names it');
  assert.equal(root.parentIds.length, 3, 'the root names all three level-1 parents');

  const covered = new Set(
    [...namingHuge, ...namingSmall].flatMap((s) => s.messageIds),
  );
  assert.deepEqual(
    [...covered].sort(),
    [...ids].sort(),
    'the parents together cover both messages, and nothing was lost to a chunk boundary',
  );
});

test('a single root too large for the archive is offered as a cue, not silently dropped (R12)', async (t) => {
  const { engine } = engineWith({
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async () => 'y'.repeat(20_000),
  });
  t.after(() => engine.close());
  const [id] = await addMessages(engine, ['m1'], 1);
  const rootId = await engine.summarizeChunk([id!], 'LLM-Map');

  // The root is ~5,000 tokens and the archive has 4,096. Before R12 the prompt carried nothing and
  // said nothing; a cue is a sentence, so it fits and names an id that expands.
  const ctx = await engine.assembleContext('s', 4_096, 'Upward');
  assert.deepEqual(ctx.summaries, [], 'the summary itself does not fit');
  assert.equal(ctx.ghosts.length, 1, 'the archive is still offered, as a cue');
  assert.equal(ctx.ghosts[0]!.summaryId, rootId);
  assert.ok(ctx.totalTokens <= 4_096);
  assert.deepEqual(
    (await engine.lcm_expand(rootId)).map((m) => m.content),
    ['m1'],
    'the cue names an id that expands',
  );
});

test('a caller that cannot expand a cue is given summaries instead (R14)', async (t) => {
  // A cli-tier role has no `lcm.expand` tool (MAF tools are in-process only), so a Dolt cue telling
  // it to call one is an instruction it cannot follow. The dispatcher asks for `summaries` there.
  const { engine } = engineWith({ contextThreshold: 1, freshTailCount: 0 });
  t.after(() => engine.close());
  const ids = await addMessages(engine, ['m1', 'm2', 'm3'], 1);
  const rootId = await engine.summarizeChunk(ids, 'LLM-Map');

  const summaries = await engine.assembleContext('s', 1_000, 'Dolt', undefined, 'summaries');
  assert.equal(summaries.summaries?.length, 1, 'the archive is summary objects');
  assert.equal(summaries.summaries?.[0]?.id, rootId);
  assert.deepEqual(summaries.ghosts, [], 'and no cue the caller cannot act on');

  // The mode's default is unchanged: Dolt without the override still offers cues.
  const cues = await engine.assembleContext('s', 1_000, 'Dolt');
  assert.equal(cues.summaries, undefined);
  assert.equal(cues.ghosts.length, 1);
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
