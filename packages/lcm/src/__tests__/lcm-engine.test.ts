import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { TransportError, makeLcmMessageId, makeNodeId, makeRunId, makeTaskId } from '@maf/types';
import type {
  LcmDegradedRecord, LcmMessage, LcmMessageId, LcmSummary, LcmSummaryId,
} from '@maf/types';
import { LcmEngine } from '../LcmEngine.js';
import type { LcmEngineConfig, LcmSummaryCall } from '../LcmEngine.js';
import { LcmStore } from '../LcmStore.js';
import { SessionMerger } from '../SessionMerger.js';
import { AgenticMap } from '../operators/AgenticMap.js';
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
const execFileAsync = promisify(execFile);

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

/**
 * A file-backed engine plus a second connection to the same archive (L2). The engine's store is
 * private, and a test that inspects the tree needs to enumerate summaries — which an engine scoped
 * to a session can no longer do once `parentIds` points up. The archive is the interface.
 */
async function fileEngineWith(
  t: TestContext,
  overrides: Partial<LcmEngineConfig> = {},
): Promise<{ engine: LcmEngine; summarized: LcmMessage[][]; store: LcmStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lcm-engine-'));
  const dbPath = path.join(dir, 'lcm.db');
  const { engine, summarized } = engineWith({ dbPath, ...overrides });
  const store = new LcmStore(dbPath);
  t.after(async () => {
    engine.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { engine, summarized, store };
}

/**
 * Every summary `id` was eventually built into — `id` itself and its ancestors' descendants in the
 * tree. L2: `parentIds` points from a summary to what summarized it, so a descendant is found by
 * walking each summary's parent chain until it reaches `id`.
 */
function descendantsOf(all: readonly LcmSummary[], id: string): LcmSummary[] {
  const byId = new Map(all.map((summary) => [summary.id as string, summary]));
  const found: LcmSummary[] = [];
  for (const summary of all) {
    let current: LcmSummary | undefined = summary;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.id as string)) {
      if (current.id === id) { found.push(summary); break; }
      seen.add(current.id as string);
      const parent: LcmSummary['parentIds'][number] | undefined = current.parentIds[0];
      current = parent === undefined ? undefined : byId.get(parent as string);
    }
  }
  return found;
}

/** The summaries that ingested `id` directly — the children of `id` (L2 reads these off `parentIds`). */
function childrenOf(all: readonly LcmSummary[], id: string): LcmSummary[] {
  return all.filter((summary) => summary.parentIds.some((parent) => (parent as string) === id));
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
  const { engine, summarized, store } = await fileEngineWith(t, {
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
  });
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
  assert.deepEqual(root.parentIds, [], 'the root has no parent (L2: the field points up)');

  const all = store.getSummariesForSession('s');
  const tree = descendantsOf(all, root.id);
  const levels = tree.map((summary) => summary.level);
  assert.deepEqual([...new Set(levels)].sort(), [0, 1, 2], 'all three levels exist');

  for (const summary of all) {
    if (summary.level !== 0) continue;
    assert.ok(
      tree.some((covered) => covered.id === summary.id),
      `level-0 summary ${summary.id} has a covering ancestor`,
    );
    assert.ok(summary.parentIds.length > 0, `level-0 summary ${summary.id} names the summary it was raised into`);
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
  const { engine, store } = await fileEngineWith(t, {
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (_messages, depth) => {
      if (depth > 0) return 'parent summary';
      call += 1;
      return call === 1 ? 'x'.repeat(150_000) : 'small child';
    },
  });

  // Two prompts make two level-0 summaries: the first is 150,000 bytes (three bounded units), the
  // second is small (one). The split is real — each parent names exactly the children whose text
  // it saw, rather than all of them being claimed by the first parent.
  const ids = await addMessages(engine, ['a'.repeat(40_000), 'b'.repeat(40_000)], 1);
  const rootId = await engine.summarizeChunk(ids, 'LLM-Map');

  const root = (await engine.expandSummary(rootId))!.summary;
  assert.equal(root.level, 2, 'the level-1 parents were raised to one root');

  const all = store.getSummariesForSession('s');
  const tree = descendantsOf(all, rootId);
  const hugeChild = tree.find((s) => s.level === 0 && s.content.length === 150_000);
  assert.ok(hugeChild, 'the oversized level-0 summary is in the tree');
  const smallChild = tree.find((s) => s.level === 0 && s.id !== hugeChild.id);
  assert.ok(smallChild, 'the small level-0 summary is in the tree too');

  const level1 = tree.filter((s) => s.level === 1);
  // L2: the relation points up, so "this parent ingested that child" is asked of the child's
  // `parentIds` (or, equivalently, of the parent's children), never of the parent's `parentIds`.
  const namingHuge = level1.filter((parent) => childrenOf(all, parent.id).some((child) => child.id === hugeChild.id));
  assert.equal(namingHuge.length, 3, 'the child is split across three parents, not truncated into one');
  for (const parent of namingHuge) {
    assert.equal(
      childrenOf(all, parent.id).filter((child) => child.id === hugeChild.id).length,
      1,
      'each of those parents names it exactly once — no parent claims text it never saw',
    );
  }
  const namingSmall = level1.filter((parent) => childrenOf(all, parent.id).some((child) => child.id === smallChild.id));
  assert.equal(namingSmall.length, 1, 'the small child fits one prompt, so one parent names it');
  assert.equal(childrenOf(all, root.id).length, 3, 'the root ingests all three level-1 parents');

  const covered = new Set(
    [...namingHuge, ...namingSmall].flatMap((s) => s.messageIds),
  );
  assert.deepEqual(
    [...covered].sort(),
    [...ids].sort(),
    'the parents together cover both messages, and nothing was lost to a chunk boundary',
  );
});

test('a single root too large for the archive is offered as a cue, not silently dropped (R12, L3c)', async (t) => {
  const calls: Array<{ depth: number; target: number | undefined }> = [];
  const { engine } = engineWith({
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (_messages, depth, target) => {
      calls.push({ depth, target });
      return 'y'.repeat(20_000);
    },
  });
  t.after(() => engine.close());
  const [id] = await addMessages(engine, ['m1'], 1);
  const rootId = await engine.summarizeChunk([id!], 'LLM-Map');
  assert.deepEqual(calls.map((call) => call.target), [undefined], 'a direct compaction has no budget to derive a target from');

  // The root is ~5,000 tokens and the archive has 4,096. L3b re-summarizes it once at half the
  // target before giving up; this summarizer ignores the target, so the retry is still too large
  // and the archive falls back to a cue (L3c) — one sentence, which fits and names an id that
  // expands. Before R12 the prompt carried nothing and said nothing.
  const ctx = await engine.assembleContext('s', 4_096, 'Upward');
  assert.deepEqual(ctx.summaries, [], 'the summary itself does not fit');
  assert.equal(ctx.ghosts.length, 1, 'the archive is still offered, as a cue');
  const cueId = ctx.ghosts[0]!.summaryId;
  assert.notEqual(cueId, rootId, 'one tighter retry ran before the cue fallback');
  assert.deepEqual(calls.at(-1), { depth: 1, target: 1_024 },
    'the retry is asked for a quarter of the budget (half of the normal target)');

  const degraded = ctx.degraded ?? [];
  assert.equal(degraded.length, 1, 'the fallback is recorded, not silent');
  assert.equal(degraded[0]!.reason, 'root-over-budget');
  assert.equal(degraded[0]!.summaryId, cueId, 'the record names the root the archive gave up on');
  assert.equal(degraded[0]!.tokens, estimateTokens('y'.repeat(20_000)));
  assert.ok(ctx.totalTokens <= 4_096);
  assert.deepEqual(
    (await engine.lcm_expand(cueId)).map((m) => m.content),
    ['m1'],
    'the cue names an id that expands',
  );
});

test('every assembly summarization is asked for a target derived from the injector budget (L3a)', async (t) => {
  const targets: Array<number | undefined> = [];
  const { engine } = engineWith({
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (_messages, _depth, target) => {
      targets.push(target);
      return 's';
    },
  });
  t.after(() => engine.close());
  await addMessages(engine, ['m1', 'm2', 'm3', 'm4'], 10);

  await engine.assembleContext('s', 30, 'Upward');

  assert.ok(targets.length > 0, 'the assembly compacted');
  for (const target of targets) assert.equal(target, 15, 'half the injector budget, stated to the summarizer');
});

test('a root that overshoots the archive is re-summarized once at a tighter target (L3b)', async (t) => {
  const targets: Array<number | undefined> = [];
  const { engine } = engineWith({
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (_messages, _depth, target) => {
      targets.push(target);
      // The first summary ignores its own size; the retry obeys the tighter target it is given.
      return targets.length === 1 ? 'y'.repeat(20_000) : 'z'.repeat((target ?? 1) * 4);
    },
  });
  t.after(() => engine.close());
  const [id] = await addMessages(engine, ['m1'], 1);
  const hugeRootId = await engine.summarizeChunk([id!], 'LLM-Map');

  const ctx = await engine.assembleContext('s', 4_096, 'Upward');

  assert.equal(ctx.degraded, undefined, 'the retry made the root fit; no fallback was recorded');
  assert.equal(ctx.summaries?.length, 1, 'the re-summarized root is the archive');
  const root = ctx.summaries![0]!;
  assert.equal(root.level, 1, 'the retry is one level above the root it replaced');
  assert.deepEqual(root.parentIds, [], 'the retried summary is now the root (L2: parents point up)');
  assert.deepEqual(
    (await engine.expandSummary(hugeRootId))!.summary.parentIds,
    [root.id],
    'the root it replaced now names the retry as its parent (L2)',
  );
  assert.ok(root.tokens <= 4_096, `the retried root fits the budget (${root.tokens} tokens)`);
  assert.deepEqual(targets, [undefined, 1_024], 'the retry is asked for a quarter of the budget');
  assert.deepEqual(
    (await engine.lcm_expand(root.id)).map((m) => m.content),
    ['m1'],
    'the retried root still expands to the messages it covers',
  );
});

test('concurrent assemblies of one session summarize each prompt once, and leave one tree (L4)', async (t) => {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { engine, store } = await fileEngineWith(t, {
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (messages) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      calls.push(messages.map((message) => message.content).join('\u0000'));
      return `summary-${calls.length}`;
    },
  });
  const ids = await addMessages(engine, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'], 1);

  // Six level-0 roots, so every assembly that fits the archive has to raise the oldest ones.
  for (let i = 0; i < ids.length; i += 2) {
    await engine.summarizeChunk([ids[i]!, ids[i + 1]!], 'LLM-Map');
  }
  calls.length = 0;

  // Four assemblies arrive together, all seeing the same six roots. Without the lock in the
  // upward pass each summarizes the same roots: duplicate prompts, a summary with two parents.
  await Promise.all(Array.from({ length: 4 }, () => engine.assembleContext('s', 4, 'Upward')));

  assert.equal(maxInFlight, 1, 'summary calls never overlap: each pass holds the session lock');
  assert.equal(new Set(calls).size, calls.length, 'no prompt was summarized twice');

  const all = store.getSummariesForSession('s');
  for (const summary of all) {
    assert.ok(
      summary.parentIds.length <= 1,
      `summary ${summary.id} has ${summary.parentIds.length} parents; the archive is a tree`,
    );
  }
  const roots = all.filter((summary) => summary.parentIds.length === 0);
  assert.equal(roots.length, 1, 'exactly one root remains');
  const tree = descendantsOf(all, roots[0]!.id);
  for (const summary of all) {
    if (summary.level !== 0) continue;
    assert.ok(
      tree.some((covered) => covered.id === summary.id),
      `level-0 summary ${summary.id} reaches the single root`,
    );
  }
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

// ─── L2: the parent relation reads as its column names say ───────────────────────────────────

const V1_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE lcm_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, tokens INTEGER NOT NULL, created_at TEXT NOT NULL,
  parent_id TEXT, summary_id TEXT,
  FOREIGN KEY(summary_id) REFERENCES lcm_summaries(id)
);
CREATE TABLE lcm_summaries (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, tokens INTEGER NOT NULL, level INTEGER NOT NULL,
  operator TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE lcm_summary_parents (
  summary_id TEXT NOT NULL, parent_id TEXT NOT NULL, PRIMARY KEY(summary_id, parent_id),
  FOREIGN KEY(summary_id) REFERENCES lcm_summaries(id),
  FOREIGN KEY(parent_id)  REFERENCES lcm_summaries(id)
);
CREATE TABLE lcm_summary_messages (
  summary_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(summary_id, message_id),
  FOREIGN KEY(summary_id) REFERENCES lcm_summaries(id),
  FOREIGN KEY(message_id) REFERENCES lcm_messages(id)
);
`;

async function legacyDatabase(t: TestContext): Promise<{ dbPath: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lcm-legacy-'));
  const dbPath = path.join(dir, 'lcm.db');
  const db = new Database(dbPath);
  db.exec(V1_SCHEMA);
  // The old layout stored (parent, child) under the names (summary_id, parent_id).
  db.prepare(`INSERT INTO lcm_summaries VALUES (?,?,?,?,?,?)`).run('P', 'parent text', 3, 1, 'LLM-Map', new Date().toISOString());
  db.prepare(`INSERT INTO lcm_summaries VALUES (?,?,?,?,?,?)`).run('C', 'child text', 2, 0, 'LLM-Map', new Date().toISOString());
  db.prepare(`INSERT INTO lcm_summary_parents VALUES (?,?)`).run('P', 'C');
  db.close();
  return {
    dbPath,
    close: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

test('the parent relation is stored as (child, parent) and read back the same way (L2)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lcm-relation-'));
  const dbPath = path.join(dir, 'lcm.db');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const store = new LcmStore(dbPath);
  const childA = store.insertSummary('a', 1, 0, 'LLM-Map', [], []);
  const childB = store.insertSummary('b', 1, 0, 'LLM-Map', [], []);
  const parent = store.insertSummary('parent', 2, 1, 'LLM-Map', [childA, childB], []);
  store.close();

  // Read the table by its column names, the way an outside reader would.
  const raw = new Database(dbPath, { readonly: true });
  try {
    const rows = raw.prepare(
      `SELECT summary_id, parent_id FROM lcm_summary_parents`,
    ).all() as Array<{ summary_id: string; parent_id: string }>;
    const byChild = (x: { summary_id: string }, y: { summary_id: string }) =>
      x.summary_id.localeCompare(y.summary_id);
    assert.deepEqual(
      rows.slice().sort(byChild),
      [
        { summary_id: childA as string, parent_id: parent as string },
        { summary_id: childB as string, parent_id: parent as string },
      ].sort(byChild),
      'summary_id names the child; parent_id names the summary that ingested it',
    );
    assert.equal(raw.pragma('user_version', { simple: true }), 2, 'a fresh archive is stamped with the schema version');
    const migrations = raw.prepare(`SELECT COUNT(*) AS n FROM lcm_migrations`).get() as { n: number };
    assert.equal(migrations.n, 0, 'a fresh archive needed no migration, so none is recorded');
  } finally {
    raw.close();
  }

  const reopened = new LcmStore(dbPath);
  try {
    assert.deepEqual(reopened.getSummary(childA)!.parentIds, [parent], 'the child names the parent');
    assert.deepEqual(reopened.getSummary(parent)!.parentIds, [], 'the parent has no parent of its own');
  } finally {
    reopened.close();
  }
});

test('opening an older archive swaps the relation once, in one transaction, and records it (L2)', async (t) => {
  const legacy = await legacyDatabase(t);
  t.after(legacy.close);

  const store = new LcmStore(legacy.dbPath);
  try {
    const child = store.getSummary('C' as never);
    assert.ok(child, 'the child survives the migration');
    assert.deepEqual(child.parentIds, ['P'], 'the old (parent, child) row now reads as (child, parent)');
    const parent = store.getSummary('P' as never);
    assert.deepEqual(parent!.parentIds, [], 'the parent is a root, as it was');
  } finally {
    store.close();
  }

  const raw = new Database(legacy.dbPath, { readonly: true });
  try {
    assert.equal(raw.pragma('user_version', { simple: true }), 2, 'the archive is stamped with the new version');
    const rows = raw.prepare(`SELECT summary_id, parent_id FROM lcm_summary_parents`).all() as
      Array<{ summary_id: string; parent_id: string }>;
    assert.deepEqual(rows, [{ summary_id: 'C', parent_id: 'P' }], 'the swap happened once in the table itself');
    const migrations = raw.prepare(`SELECT from_version, to_version FROM lcm_migrations`).all() as
      Array<{ from_version: number; to_version: number }>;
    assert.deepEqual(migrations, [{ from_version: 0, to_version: 2 }], 'the migration is recorded');
  } finally {
    raw.close();
  }

  // Opening it again is a no-op: the version stamp is what prevents a second swap (which would
  // restore the inversion).
  const again = new LcmStore(legacy.dbPath);
  try {
    assert.deepEqual(again.getSummary('C' as never)!.parentIds, ['P']);
  } finally {
    again.close();
  }
});

test('an archive newer than this build is refused, not read upside down (L2)', async (t) => {
  const legacy = await legacyDatabase(t);
  t.after(legacy.close);

  const db = new Database(legacy.dbPath);
  db.pragma('user_version = 99');
  db.close();

  assert.throws(
    () => new LcmStore(legacy.dbPath),
    /schema version 99, newer than this build understands \(2\).*Refusing to open it/s,
    'a build that does not know the layout says so instead of guessing',
  );

  // V7: the refusal is read-only. `exec(SCHEMA)` used to run before the version check, so opening
  // an archive this build cannot read still created its tables in that archive.
  const raw = new Database(legacy.dbPath, { readonly: true });
  try {
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as
      Array<{ name: string }>).map((row) => row.name);
    assert.ok(!tables.includes('lcm_migrations'),
      `the refusal created no tables (found ${tables.join(', ')})`);
    assert.ok(!tables.includes('lcm_root_retries'));
    assert.equal(raw.pragma('user_version', { simple: true }), 99, 'and left the stamp alone');
  } finally {
    raw.close();
  }
});

test('a migration that cannot be recorded leaves the archive exactly as it was (L2e)', async (t) => {
  // L2e: the swap and the migration row are one transaction. A view under the migration table's
  // name makes the INSERT fail *after* the swap has been written, which is the only place an
  // outside test can interrupt it. Inside the transaction the whole migration rolls back; outside
  // one (the mutant) the archive is left swapped with no version stamp.
  const legacy = await legacyDatabase(t);
  t.after(legacy.close);
  const seed = new Database(legacy.dbPath);
  seed.exec(`CREATE VIEW lcm_migrations AS SELECT 1 AS from_version, 2 AS to_version, '' AS applied_at`);
  seed.close();

  assert.throws(() => new LcmStore(legacy.dbPath), /cannot modify lcm_migrations because it is a view/);

  const raw = new Database(legacy.dbPath, { readonly: true });
  try {
    assert.equal(raw.pragma('user_version', { simple: true }), 0, 'the stamp was not half-applied');
    assert.deepEqual(
      raw.prepare(`SELECT summary_id, parent_id FROM lcm_summary_parents`).all(),
      [{ summary_id: 'P', parent_id: 'C' }],
      'the relation is untouched: the swap rolled back with the failure',
    );
    const leftovers = raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='lcm_summary_parents_v1'`,
    ).all();
    assert.deepEqual(leftovers, [], 'and the rename rolled back too');
  } finally {
    raw.close();
  }
});

test('two processes opening an old archive migrate it exactly once (V6)', async (t) => {
  // V6: the migration is `BEGIN IMMEDIATE` and re-reads the version inside it. Two openers that
  // both read 0 used to both swap, and the second swap restored the inversion the first removed.
  const legacy = await legacyDatabase(t);
  t.after(legacy.close);
  // This package compiles to CommonJS; the child imports the built module by file URL.
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'LcmStore.js')).href;
  const script = `
    const { LcmStore } = await import(process.env.LCM_MODULE);
    new LcmStore(process.env.LCM_DB).close();
  `;
  await Promise.all(Array.from({ length: 6 }, () => execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { env: { ...process.env, LCM_MODULE: moduleUrl, LCM_DB: legacy.dbPath } },
  )));

  const raw = new Database(legacy.dbPath, { readonly: true });
  try {
    assert.equal(raw.pragma('user_version', { simple: true }), 2);
    assert.deepEqual(
      raw.prepare(`SELECT summary_id, parent_id FROM lcm_summary_parents`).all(),
      [{ summary_id: 'C', parent_id: 'P' }],
      'six concurrent opens swapped the relation once, not six times',
    );
    const migrations = raw.prepare(`SELECT COUNT(*) AS n FROM lcm_migrations`).get() as { n: number };
    assert.equal(migrations.n, 1, 'and recorded one migration');
  } finally {
    raw.close();
  }
});

// ─── Round 3: the live row's findings (V1, V2, V3, V5, V8, V10) ──────────────────────────────

const SECRET = 'sk-ant-api03-ROUND3SECRETSECRETSECRETSECRETSECRET';

/** Seeds `contents.length` roots, each claiming one message and sized at `tokens`. */
async function seedRoots(
  engine: LcmEngine, store: LcmStore, contents: string[], tokens: number,
): Promise<LcmSummaryId[]> {
  const ids = await addMessages(engine, contents, 1);
  return ids.map((id, i) => {
    const summaryId = store.insertSummary(`root-${i}`, tokens, 0, 'LLM-Map', [], [id]);
    store.markSummarized([id], summaryId);
    return summaryId;
  });
}

test('a root is retried once for the whole run, and degraded once (V1)', async (t) => {
  const calls: Array<{ depth: number; target: number | undefined }> = [];
  const recorded: LcmSummaryCall[] = [];
  const { engine, store } = await fileEngineWith(t, {
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (_messages, depth, target) => {
      calls.push({ depth, target });
      // A credential the model echoes, then text large enough to stay over budget: the key is
      // delimited, so the redactor masks it rather than swallowing the whole summary.
      return `key: ${SECRET}\n${'y'.repeat(20_000)}`;   // ignores its target, every time
    },
    recordSummaryCall: (call) => { recorded.push(call); },
  });
  const [id] = await addMessages(engine, ['m1'], 1);
  const firstRoot = await engine.summarizeChunk([id!], 'LLM-Map');
  calls.length = 0;
  recorded.length = 0;

  let degraded = 0;
  for (let assembly = 0; assembly < 8; assembly++) {
    const ctx = await engine.assembleContext('s', 4_096, 'Upward');
    degraded += ctx.degraded?.length ?? 0;
  }

  assert.equal(calls.length, 1, 'exactly one retry, for the whole run — not one per assembly');
  assert.equal(calls[0]!.depth, 1);
  assert.equal(degraded, 1, 'one degraded record for the root, not one per assembly');
  assert.equal(recorded.length, 1, 'the retry is a recorded model call like any other (L3k)');
  assert.deepEqual(recorded[0]!.childIds, [firstRoot], 'and it names the root it retried');

  const all = store.getSummariesForSession('s');
  assert.equal(all.length, 2, 'the root and its one retry — no stacked chain');
  assert.equal(Math.max(...all.map((summary) => summary.level)), 1);
  for (const summary of all) {
    assert.ok(!summary.content.includes(SECRET), 'the retry output is masked like every other (L3h)');
  }
});

test('concurrent assemblies cannot retry one root twice (V2: L4b, L4g)', async (t) => {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { engine, store } = await fileEngineWith(t, {
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (messages) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      calls.push(messages.map((message) => message.content).join(' '));
      return 'y'.repeat(20_000);
    },
  });
  const [id] = await addMessages(engine, ['m1'], 1);
  await engine.summarizeChunk([id!], 'LLM-Map');   // one root, too large
  calls.length = 0;

  // Four assemblies arrive together, all seeing the same over-budget root. L4b removed the lock
  // (overlapping calls); L4g replaced the re-read with the stale root. V1's persisted claim —
  // written under the lock, before the call — makes a second assembly's attempt a no-op whatever
  // it read, so this pins the property both mutants broke: one retry, one parent.
  await Promise.all(Array.from({ length: 4 }, () => engine.assembleContext('s', 4_096, 'Upward')));

  assert.equal(maxInFlight, 1, 'summary calls never overlap: the retry holds the session lock');
  assert.equal(calls.length, 1, 'one retry call for four assemblies');

  const all = store.getSummariesForSession('s');
  assert.equal(all.filter((summary) => summary.parentIds.length === 0).length, 1, 'exactly one root');
  // V11: the single-parent rule is about the upward lineage. R11 deliberately splits an oversized
  // level-0 child across several parents, so only summaries above level 0 are asserted here.
  for (const summary of all.filter((entry) => entry.level >= 1)) {
    assert.ok(
      summary.parentIds.length <= 1,
      `summary ${summary.id} has ${summary.parentIds.length} parents; the upward lineage is a tree`,
    );
  }
});

test('the retry decides under the lock, against a re-read archive (V2: L4b, L4g)', async (t) => {
  // The retry is a compaction pass, and the property is the same one L4 states for every pass: it
  // runs under the session lock and decides on the roots as they are *now*, not as the assembly
  // read them before queueing. Here a level-0 compaction takes the lock first and, by the time it
  // releases it, the archive has two roots — so a single-root retry is no longer what is called
  // for. Removing the lock (L4b) lets the retry overlap the compaction; removing the re-read
  // (L4g) lets it retry against the stale one-root view. Each writes a level-1 call that should
  // not exist, which the assertions below see.
  const calls: Array<{ depth: number }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { engine } = await fileEngineWith(t, {
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (_messages, depth) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      calls.push({ depth });
      return 'y'.repeat(20_000);
    },
  });
  const [m1] = await addMessages(engine, ['m1'], 1);
  await engine.summarizeChunk([m1!], 'LLM-Map');      // one root, too large
  const [m2] = await addMessages(engine, ['m2'], 1);  // not yet covered by any summary
  calls.length = 0;

  const compacting = engine.summarizeChunk([m2!], 'LLM-Map');       // holds the lock first
  const assembling = engine.assembleContext('s', 4_096, 'Upward');  // sees one root, then queues
  const [, ctx] = await Promise.all([compacting, assembling]);

  assert.equal(maxInFlight, 1, 'the retry never overlaps another compaction call of the session');
  assert.deepEqual(calls.map((call) => call.depth), [0],
    'the archive had two roots under the lock, so the single-root retry was not made');
  assert.deepEqual(ctx.degraded ?? [], [], 'and nothing is reported degraded');
});

test('an upward merge is asked for a target too, and its output is masked (V3/L3b, L3i)', async (t) => {
  const calls: Array<{ depth: number; target: number | undefined }> = [];
  const { engine, store } = await fileEngineWith(t, {
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async (_messages, depth, target) => {
      calls.push({ depth, target });
      return `key: ${SECRET}\n${'z'.repeat(400)}`;
    },
  });
  await seedRoots(engine, store, ['a', 'b'], 100);

  const ctx = await engine.assembleContext('s', 150, 'Upward');

  assert.deepEqual(calls, [{ depth: 1, target: 75 }],
    'the upward merge is asked for half the budget, like every assembly call (L3b)');
  assert.equal(ctx.summaries?.length, 1, 'the merge left one root that fits');
  const merged = store.getSummariesForSession('s').find((summary) => summary.level === 1);
  assert.ok(merged, 'the merged summary is stored');
  assert.ok(!merged.content.includes(SECRET), 'the upward-merge output is masked (L3i)');
});

test('Agentic-Map states the target to its sub-agent too (V3)', async () => {
  // V3: the same instruction on the other operator. A sub-agent left to choose its size returns
  // roughly what it was given, which is the failure L3 measured in the live row.
  const prompts: string[] = [];
  const store = new LcmStore(':memory:');
  try {
    const map = new AgenticMap({
      store,
      runSubAgent: async (systemPrompt, userMessages) => {
        prompts.push(systemPrompt);
        return userMessages.join('\n');
      },
    });
    await map.complete([{ role: 'user', content: 'x' }], 0, 321);
    await map.complete([{ role: 'user', content: 'x' }], 0);

    assert.match(prompts[0]!, /Aim for at most 321 tokens\./);
    assert.doesNotMatch(prompts[1]!, /Aim for at most/);
  } finally {
    store.close();
  }
});

test('a failed upward merge degrades the assembly instead of failing it (V5)', async (t) => {
  const { engine, store } = await fileEngineWith(t, {
    contextThreshold: 1, freshTailCount: 0, mode: 'Upward',
    summarize: async () => { throw new Error('summarizer exploded'); },
  });
  await seedRoots(engine, store, ['a', 'b'], 100);

  const ctx = await engine.assembleContext('s', 150, 'Upward');

  assert.equal(ctx.degraded?.[0]?.reason, 'compaction-failed: summarizer exploded',
    'the failed merge is recorded with its own reason');
  assert.equal(ctx.degraded!.length, 1);
  assert.equal(ctx.summaries?.length, 1, 'the roots that fit are still rendered; the node runs');
  assert.deepEqual(ctx.summaryCalls, undefined, 'and no call is claimed that did not complete');
});

test('a cli-tier reader that gets no archive is told so, once per root (V10)', async (t) => {
  for (const mode of ['Dolt', 'Upward'] as const) {
    const { engine } = engineWith({
      contextThreshold: 1, freshTailCount: 0, mode,
      summarize: async () => 'y'.repeat(20_000),
    });
    t.after(() => engine.close());
    const ids = await addMessages(engine, ['m1'], 1);
    await engine.summarizeChunk([ids[0]!], 'LLM-Map');

    const first = await engine.assembleContext('s', 100, mode, undefined, 'summaries');
    assert.deepEqual(first.summaries, [], `${mode}: the root does not fit`);
    const record = (first.degraded ?? []).find((entry) => entry.reason === 'cli-tier-cues');
    assert.ok(record, `${mode}: the omission is recorded as the cli tier's limit`);
    assert.notEqual(record.summaryId, undefined);

    const second = await engine.assembleContext('s', 100, mode, undefined, 'summaries');
    assert.equal(
      (second.degraded ?? []).some((entry) => entry.reason === 'cli-tier-cues'), false,
      `${mode}: recorded once per root, not once per assembly`,
    );
  }
});
