import type {
  LcmApi, LcmMessage, LcmSummary, LcmContext, LcmMode, LcmTrigger,
  LcmMessageId, LcmSummaryId, GhostCue, RunId, LcmDegradedRecord, LcmSummarySurface,
  ModelSurface,
} from '@maf/types';
import { redactCredentials } from '@maf/types';
import { LcmStore } from './LcmStore.js';
import { GhostCueBuilder } from './GhostCueBuilder.js';
import { SessionMerger } from './SessionMerger.js';
import { LlmMap } from './operators/LlmMap.js';
import { AgenticMap } from './operators/AgenticMap.js';
import {
  estimateTokens, summaryContent, byteLength, MAX_SUMMARY_PROMPT_BYTES, type SummaryOutput,
} from './summarizer.js';

/** One summary call, as the engine reports it to its recorder (WP-3.2 F1). */
export interface LcmSummaryCall {
  sessionId:       string;
  summaryId:       LcmSummaryId;
  level:           number;
  messageIds:      LcmMessageId[];
  parentIds:       LcmSummaryId[];
  content:         string;
  /** The content's own estimate — the size the summary occupies in a prompt (F10). */
  contentTokens:   number;
  /** What the backend reported for the call, when it reports anything (F10). */
  reportedTokens?: number;
  /**
   * What this call spent against the triggering node's budget (R5): the backend's reported count
   * when it reports one, else the estimate of the prompt plus the summary.
   */
  tokenBudgetCharged: number;
  model?:          string;
  surface?:        ModelSurface;
  trigger?:        LcmTrigger;
}

export interface LcmEngineConfig {
  dbPath:            string;
  /**
   * The session this engine serves (R9). `.maf/lcm.db` outlives a run, so a lookup by summary id
   * alone could read an earlier run's archive; with this set, `expandSummary` refuses a summary
   * that covers no message of this session. Absent, the engine is unscoped — the shape a test
   * that owns the whole database uses.
   */
  sessionId?:        string;
  contextThreshold:  number;   // 0.0–1.0, default 0.75 — triggers compaction
  /**
   * The most messages `<recent>` offers raw when compaction is active (V1). It is not a fixed
   * count protected from compaction: the protected tail is what the budget actually rendered, so a
   * message inside this count that did not fit is summarized at the same assembly, not 64 messages
   * later. With room to spare the prompt may show every message, whatever this count says.
   */
  freshTailCount:    number;   // raw recent messages offered when compacting; default 64
  mode:              LcmMode;
  /**
   * The run's summarizer (WP-3.2). In the CLI this is the run's adapter, with the model the run
   * was given; the engine never invents a summary.
   */
  summarize(messages: LcmMessage[], depth: number): Promise<SummaryOutput>;
  /**
   * A full sub-agent call for Agentic-Map. When it is absent, asking for Agentic-Map is an
   * error rather than a silent fall back to LLM-Map: the two have different costs, and a caller
   * that asked for the expensive one must learn it did not get it.
   */
  runSubAgent?(systemPrompt: string, userMessages: string[]): Promise<SummaryOutput>;
  /** Operator automatic compaction uses. Default `LLM-Map`. */
  operator?: 'LLM-Map' | 'Agentic-Map';
  /**
   * Extra attempts for a summarization call that failed with a `TransportError` (WP-3.2 F5).
   * D-06 retries transport failures and never retries a verdict; a summary call is a backend call,
   * so the same rule applies. Default 1 (two attempts in total).
   */
  summaryRetry?: number;
  /**
   * Where a summary call is recorded (WP-3.2 F1). It is a model call like any other: the caller
   * attaches it to the attestor and writes the `[surface]` transcript line.
   */
  recordSummaryCall?(call: LcmSummaryCall): void | Promise<void>;
  /**
   * A compaction that failed after its retries (WP-3.2 F5). The assembly continues uncompacted;
   * this is the only place the caller learns that the archive is behind.
   */
  onDegraded?(record: LcmDegradedRecord): void | Promise<void>;
}

/** One piece of text a summary prompt is built from: a message or a fragment of one. */
interface Unit {
  role:       LcmMessage['role'];
  content:    string;
  messageId?: LcmMessageId;
  /**
   * Set on a unit that renders a stored summary at a higher level (R11). A child too large for one
   * prompt is split into several units, each carrying its child's id, so every parent names exactly
   * the children whose text it saw.
   */
  summaryId?: LcmSummaryId;
}

/** A summary a higher level summarizes: its id and what it says. */
interface ParentUnit {
  id:      LcmSummaryId;
  content: string;
}

const SUMMARY_UNIT_OVERHEAD = 32; // `[ASSISTANT] ` + the joining newline, generously rounded.

/**
 * What the injector's `<recent>` block adds around the messages it renders (R4c): the wrapper plus
 * one `<message role="…"></message>` line per message. Fitting uses the same numbers the renderer
 * pays, so the archive's share is a real ceiling rather than an approximation of one.
 */
const RECENT_WRAPPER_TOKENS = 8;
const RECENT_MESSAGE_OVERHEAD_TOKENS = 12;

/**
 * How many fit/compact/re-fit rounds an assembly may take before it compacts everything that is
 * still uncovered (V1). Each round summarizes at least one message, so the loop converges; this is
 * a backstop against a summarizer that produces summaries larger than the messages they replace.
 */
const MAX_ASSEMBLY_PASSES = 8;

export class LcmEngine implements LcmApi {
  private readonly store: LcmStore;
  private readonly config: LcmEngineConfig;
  private readonly llmMap: LlmMap;
  private readonly agenticMap?: AgenticMap;
  private readonly ghostCues = new GhostCueBuilder();
  private readonly merger: SessionMerger;
  /** One compaction at a time per session (WP-3.2 F6). A settled `void` chain, never a rejection. */
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(config: LcmEngineConfig) {
    this.config = config;
    this.store  = new LcmStore(config.dbPath);
    this.llmMap = new LlmMap({
      store: this.store,
      summarize: (messages, depth) => config.summarize(messages, depth),
    });
    if (config.runSubAgent) {
      this.agenticMap = new AgenticMap({ store: this.store, runSubAgent: config.runSubAgent });
    }
    this.merger = new SessionMerger(this.store);
  }

  /**
   * A message entering the archive is masked on the way in (WP-3.2 F7): the transcript, the
   * summary prompt and the summary output are all model-text paths, and a credential that reached
   * any of them would be repeated by every later prompt.
   */
  async addMessage(msg: Omit<LcmMessage, 'id' | 'createdAt'>): Promise<LcmMessageId> {
    return this.store.insertMessage({ ...msg, content: redactCredentials(msg.content) });
  }

  /**
   * Summarizes exactly `messageIds` — no more and no fewer. An id that is not in the store is an
   * error: the version this replaces was handed transcript-entry ids it had never stored (the
   * `as never[]` cast), summarized nothing, and then dropped those entries from the in-memory
   * transcript, so a run lost context with no error anywhere (D-17).
   *
   * WP-3.2 F6: the work is serialized per session, and ids another pass already summarized are
   * skipped rather than summarized twice. Two nodes assembling at once therefore make one call,
   * and each message belongs to exactly one summary.
   */
  async summarizeChunk(
    messageIds: LcmMessageId[],
    operator: 'LLM-Map' | 'Agentic-Map',
    trigger?: LcmTrigger,
  ): Promise<LcmSummaryId> {
    if (messageIds.length === 0) {
      throw new Error('LCM compaction was asked to summarize an empty chunk; there is nothing to drop.');
    }
    const initial = this.store.getMessagesByIds(messageIds);
    if (initial.length !== messageIds.length) throw this.missing(messageIds, initial);
    const sessionId = initial[0]!.sessionId;
    const compacted = await this.serialize(sessionId, () =>
      this.compactLocked(sessionId, messageIds, operator, trigger));
    return compacted.summaryId;
  }

  /**
   * The context a node is given (WP-3.2, D-17; budget semantics D-52, R2/R4c; coverage V1).
   *
   * `messages` are the newest messages of the session, newest first. They are rendered as
   * `<recent>` after the archive and inside the same budget.
   *
   * **The invariant (V1):** at every assembly, every message of the session is either rendered in
   * `<recent>`, covered by a summary (directly or through an ancestor), or newer than the assembly.
   * The tail that stays raw is *what was rendered*, not a fixed count, so a message that did not fit
   * is eligible for compaction at this very assembly, whatever its age. Compaction shrinks the room
   * left for `<recent>`, so the rendered set only shrinks and the loop converges; anything still
   * uncovered at the bound is compacted before returning.
   *
   * If compaction fails, every uncompacted message is a recent candidate again and the failure is
   * recorded (F5): nothing is dropped unsummarized, and the operator is told the archive is behind.
   *
   * `totalTokens` is the size of what the injector renders — summaries/cues plus the recent
   * messages. A summary call's cost is `compactionTokens`, a budget record and never a reservation
   * out of the rendered room (R2): the room is about rendered size, the call is about the call.
   *
   * `render` asks for summaries where the mode would otherwise offer ghost cues (R14). A cli-tier
   * role has no `lcm.expand` tool, so a cue telling it to call one is not an instruction it can
   * follow; the dispatcher asks for summaries there instead.
   */
  async assembleContext(
    sessionId: string,
    tokenBudget: number,
    mode: LcmMode = this.config.mode,
    trigger?: LcmTrigger,
    render?: 'cues' | 'summaries',
  ): Promise<LcmContext> {
    if (mode === 'off' || tokenBudget <= 0) return emptyContext(mode);

    const summaryCalls: LcmSummarySurface[] = [];
    const degradedRecords: LcmDegradedRecord[] = [];
    let compactionTokens = 0;
    let degraded = false;
    const operator = this.config.operator ?? 'LLM-Map';

    /** The archive half of one assembly: what the mode offers and what it costs. */
    const fitArchive = async (): Promise<{
      summaries: LcmSummary[]; ghosts: GhostCue[]; used: number; offerSummaries: boolean;
    }> => {
      // R2: room is measured on rendered size. The call's reported tokens were subtracted here and
      // on a backend that reports them (openrouter) that emptied the archive's own room.
      const ghosts: GhostCue[] = [];
      let included: LcmSummary[] = [];
      let used = 0;
      let offerSummaries = mode === 'Upward';

      if (mode === 'Upward') {
        const archive = await this.fitUpward(sessionId, tokenBudget, trigger);
        included = archive.summaries;
        summaryCalls.push(...archive.calls);
        used = included.reduce((s, summary) => s + summary.tokens, 0);
        if (included.length === 0 && archive.roots.length > 0) {
          // R12: one root larger than the whole archive used to render nothing and say nothing.
          // A cue is a sentence, so it fits where the summary did not; the model can expand it.
          used = this.fitCues(archive.roots, Math.max(0, tokenBudget - used), ghosts);
        }
      } else if (render === 'summaries') {
        // R14: no cues the backend cannot act on. The roots are fitted newest-first, exactly as the
        // cues would be, without the extra compaction Upward's fit performs.
        const fitted = fitRootsNewestFirst(this.rootSummaries(sessionId), tokenBudget);
        included = fitted.summaries;
        used = fitted.used;
        offerSummaries = true;
      } else {
        // Cues are sentences, newest first: the most recent archive is the most relevant, and a cue
        // the budget cannot hold is skipped rather than crowding out the rest.
        used = this.fitCues(this.rootSummaries(sessionId), tokenBudget, ghosts);
      }
      return { summaries: included, ghosts, used, offerSummaries };
    };

    /**
     * One assembly of what is currently stored. `cap` bounds the raw tail only when compaction is
     * warranted; a roomy prompt shows every message that fits. A message outside what `fitRecent`
     * renders is left uncovered, and the caller compacts it before returning (V1).
     */
    const assembleNow = async (uncompacted: LcmMessage[], cap: number | undefined) => {
      const archive = await fitArchive();
      const candidates = cap === undefined
        ? uncompacted
        : uncompacted.slice(Math.max(0, uncompacted.length - cap));
      const recent = fitRecent(candidates, Math.max(0, tokenBudget - archive.used));
      return { archive, recent };
    };

    const build = (
      archive: Awaited<ReturnType<typeof fitArchive>>,
      recent: ReturnType<typeof fitRecent>,
    ): LcmContext => ({
      messages: recent.messages,
      ghosts: archive.ghosts,
      totalTokens: archive.used + recent.tokens,
      ...(compactionTokens > 0 ? { compactionTokens } : {}),
      ...(archive.offerSummaries ? { summaries: archive.summaries } : {}),
      ...(summaryCalls.length > 0 ? { summaryCalls } : {}),
      ...(degradedRecords.length > 0 ? { degraded: degradedRecords } : {}),
    });

    const recordDegradation = async (err: unknown): Promise<void> => {
      // F5: a failed compaction degrades. The node continues and the failure is recorded; throwing
      // here would turn a background optimization into a node failure.
      degraded = true;
      const record = {
        sessionId, reason: err instanceof Error ? err.message : String(err),
        ...(trigger?.taskId ? { taskId: trigger.taskId } : {}),
        ...(trigger?.nodeId ? { nodeId: trigger.nodeId } : {}),
      };
      degradedRecords.push(record);
      await this.config.onDegraded?.(record);
    };

    const compactUncovered = async (messageIds: LcmMessageId[]): Promise<void> => {
      const result = await this.serialize(sessionId, () =>
        this.compactLocked(sessionId, messageIds, operator, trigger));
      compactionTokens += result.reportedTokens.reduce((s, n) => s + n, 0);
      summaryCalls.push(...result.calls);
    };

    let uncompacted = this.store.getUncompactedMessages(sessionId, 0);
    let context: LcmContext | undefined;
    let converged = false;

    // V1: the protected tail is what was rendered. New summaries leave less room for `<recent>`,
    // so the rendered set only shrinks and this converges; `MAX_ASSEMBLY_PASSES` is a backstop.
    for (let pass = 0; pass < MAX_ASSEMBLY_PASSES; pass++) {
      const rawTokens = uncompacted.reduce((s, m) => s + m.tokens, 0);
      const overThreshold = rawTokens > tokenBudget * this.config.contextThreshold;
      const { archive, recent } = await assembleNow(
        uncompacted, overThreshold ? this.config.freshTailCount : undefined,
      );
      context = build(archive, recent);

      const rendered = new Set(recent.messages.map((message) => message.id));
      const uncovered = uncompacted.filter((message) => !rendered.has(message.id));
      if (uncovered.length === 0) {
        converged = true;
        break;
      }

      try {
        await compactUncovered(uncovered.map((message) => message.id));
      } catch (err: unknown) {
        await recordDegradation(err);
        break;
      }
      uncompacted = this.store.getUncompactedMessages(sessionId, 0);
    }

    // The bound is a backstop, not a rule. If it is reached with messages still uncovered, the
    // guarantee outranks the rendering: compact everything that is left and return the archive
    // alone (the converged case never takes this branch — its messages were rendered).
    if (!converged && !degraded && context !== undefined) {
      const stillUncompacted = this.store.getUncompactedMessages(sessionId, 0);
      if (stillUncompacted.length > 0) {
        try {
          await compactUncovered(stillUncompacted.map((message) => message.id));
        } catch (err: unknown) {
          await recordDegradation(err);
        }
        const { archive, recent } = await assembleNow([], undefined);
        context = build(archive, recent);
      }
    }

    // F5: in the degraded state the guarantee cannot hold — no summary was written — so the node
    // sees as much raw history as the budget holds, and the recording says the archive is behind.
    if (degraded && context !== undefined) {
      const remaining = this.store.getUncompactedMessages(sessionId, 0);
      const { archive, recent } = await assembleNow(remaining, undefined);
      context = build(archive, recent);
    }

    return context ?? emptyContext(mode);
  }

  async lcm_grep(query: string, sessionId: string): Promise<LcmMessage[]> {
    return this.store.searchMessages(query, sessionId);
  }

  async lcm_expand(summaryId: LcmSummaryId): Promise<LcmMessage[]> {
    return (await this.expandSummary(summaryId))?.messages ?? [];
  }

  /**
   * A summary and the messages it covers, the API behind `lcm.expand` (WP-3.2 F8, R9): the Dolt cue
   * tells the model to call a tool, so the tool needs the summary text as well as the messages.
   *
   * `summaryId` is a plain `string` because this is the tool boundary, where the id comes from a
   * model. The lookup is a bound store parameter (never query text), so the brand adds no safety
   * here. What does matter is the run: `.maf/lcm.db` outlives a run, so an id copied or guessed
   * from an earlier one is a real id in this database. A scoped engine (`sessionId` set) resolves
   * only summaries that cover at least one message of its own session; anything else is refused
   * exactly as an unknown id is. The version this replaces looked the id up on its own and called
   * the result "not found" only because the caller had no way to ask.
   */
  async expandSummary(summaryId: string): Promise<{ summary: LcmSummary; messages: LcmMessage[] } | undefined> {
    const id = summaryId as LcmSummaryId;
    const summary = this.config.sessionId !== undefined
      ? this.store.getSummaryInSession(id, this.config.sessionId)
      : this.store.getSummary(id);
    if (!summary) return undefined;
    return { summary, messages: this.store.getMessagesByIds(summary.messageIds) };
  }

  async mergeRuns(runIds: RunId[], targetRunId: RunId): Promise<void> {
    // One implementation (D-18): the same union merge `SessionMerger` exposes, so the two
    // cannot drift apart.
    await this.merger.mergeRuns(runIds, targetRunId);
  }

  close(): void { this.store.close(); }

  // ── Compaction ───────────────────────────────────────────────────────────────

  /**
   * The compaction run inside the session lock. Re-reads the messages after acquiring the lock,
   * because another pass may have summarized some of them in the meantime (F6), and works only
   * on those still uncovered.
   */
  private async compactLocked(
    sessionId: string,
    messageIds: LcmMessageId[],
    operator: 'LLM-Map' | 'Agentic-Map',
    trigger?: LcmTrigger,
  ): Promise<{ summaryId: LcmSummaryId; reportedTokens: number[]; calls: LcmSummarySurface[] }> {
    const fresh = this.store.getMessagesByIds(messageIds);
    if (fresh.length !== messageIds.length) throw this.missing(messageIds, fresh);
    const uncovered = fresh.filter((m) => m.summaryId === undefined);
    if (uncovered.length === 0) {
      // Every message is already covered. Return the summary that covers the requested set when
      // one summary covers all of it, so a caller that drops them still names a real archive.
      const covering = new Set(fresh.map((m) => m.summaryId!));
      const first = [...covering][0];
      if (covering.size === 1 && first !== undefined) {
        return { summaryId: first, reportedTokens: [], calls: [] };
      }
      const newest = this.rootSummaries(sessionId).at(-1);
      if (newest) return { summaryId: newest.id, reportedTokens: [], calls: [] };
      throw new Error('LCM compaction was asked to summarize messages that are already covered, and no summary covers them.');
    }

    const units = this.unitsOf(uncovered);
    const groups = packUnits(units);
    const reported: number[] = [];
    const calls: LcmSummarySurface[] = [];
    const level0: ParentUnit[] = [];

    for (const group of groups) {
      const output = await this.callBounded(group, 0, operator);
      // F7: an injected summarizer may return a credential the model echoed, so the store keeps
      // the masked text, not whatever came back. The call's own surface still hashes the true
      // bytes; the archive is the model-facing side.
      const content = redactCredentials(summaryContent(output));
      const contentTokens = estimateTokens(content);
      const messageIdsInGroup = [...new Set(group.flatMap((u) => (u.messageId ? [u.messageId] : [])))];
      const summaryId = this.store.insertSummary(content, contentTokens, 0, operator, [], messageIdsInGroup);
      this.store.markSummarized(messageIdsInGroup, summaryId);
      const spent = reportedTokensOf(output, content);
      reported.push(spent);
      const surface = await this.recordCall({
        sessionId, summaryId, level: 0, messageIds: messageIdsInGroup, parentIds: [],
        content, contentTokens, output, trigger, inputTokens: promptTokensOf(group),
      });
      if (surface) calls.push(surface);
      level0.push({ id: summaryId, content });
    }

    // F9: summarize the summaries upward until one root covers everything. Nothing is dropped
    // without a parent: each level names its children as `parentIds` and links every descendant
    // message, so `lcm.expand` on the root recovers the whole segment.
    const rootId = await this.raise(level0, 1, operator, sessionId, trigger, reported, calls);
    return { summaryId: rootId, reportedTokens: reported, calls };
  }

  /** Builds level+1 summaries over `children` until exactly one root remains. */
  private async raise(
    children: ParentUnit[],
    level: number,
    operator: 'LLM-Map' | 'Agentic-Map',
    sessionId: string,
    trigger: LcmTrigger | undefined,
    reported: number[],
    calls: LcmSummarySurface[],
  ): Promise<LcmSummaryId> {
    if (children.length === 1) return children[0]!.id;

    // Each child's rendered text is split into byte-bounded units that carry its id, so a child
    // too large for one prompt is genuinely split across summaries (R11) and each summary names
    // exactly the children whose text it saw (F4). The version this replaces built one unit per
    // child and then claimed every child in the chunk regardless: a summary could name a parent
    // whose text had been elsewhere, and a comment described a split that never happened.
    const units: Unit[] = [];
    for (const child of children) {
      const rendered = `[Level-${level - 1} summary ${child.id}]\n${child.content}`;
      for (const content of splitByBytes(rendered, MAX_SUMMARY_PROMPT_BYTES - SUMMARY_UNIT_OVERHEAD)) {
        units.push({ role: 'system', content, summaryId: child.id });
      }
    }
    const parents: ParentUnit[] = [];
    for (const chunk of packUnits(units)) {
      const childIds = [...new Set(chunk.flatMap((unit) => (unit.summaryId ? [unit.summaryId] : [])))];
      const output = await this.callBounded(chunk, level, operator);
      // R10: the same masking as level 0. A model can echo a credential it read, and this text is
      // stored and shown by `lcm.expand` exactly like a level-0 summary's.
      const content = redactCredentials(summaryContent(output));
      const contentTokens = estimateTokens(content);
      const childSummaries = childIds
        .map((id) => this.store.getSummary(id))
        .filter((summary): summary is LcmSummary => summary !== undefined);
      const messageIds = [...new Set(childSummaries.flatMap((s) => s.messageIds))];
      const summaryId = this.store.insertSummary(content, contentTokens, level, operator, childIds, messageIds);
      reported.push(reportedTokensOf(output, content));
      const surface = await this.recordCall({
        sessionId, summaryId, level, messageIds, parentIds: childIds,
        content, contentTokens, output, trigger, inputTokens: promptTokensOf(chunk),
      });
      if (surface) calls.push(surface);
      parents.push({ id: summaryId, content });
    }
    return this.raise(parents, level + 1, operator, sessionId, trigger, reported, calls);
  }

  /**
   * The Upward archive, newest first, compacting the oldest roots upward when they no longer fit
   * (D-52 F2/F9). Summaries get room before anything else the injector renders, because they are
   * what the injector renders; `roots` is returned so a budget too small for every root can fall
   * back to cues (R12).
   */
  private async fitUpward(
    sessionId: string,
    budget: number,
    trigger: LcmTrigger | undefined,
  ): Promise<{ summaries: LcmSummary[]; calls: LcmSummarySurface[]; roots: LcmSummary[] }> {
    const calls: LcmSummarySurface[] = [];
    let roots = this.rootSummaries(sessionId);
    if (roots.length === 0) return { summaries: [], calls, roots };
    // Bounded: each pass halves the root count or stops. A budget too small for even one root
    // stops the loop rather than summarizing forever.
    for (let pass = 0; pass < 8 && roots.length > 1; pass++) {
      const overflow = overflowNewestFirst(roots, budget);
      if (overflow.length === 0) break;
      // Summarize the oldest roots — at least two, so the parent covers more than it replaces.
      const take = Math.max(2, overflow.length);
      const oldest = roots.slice(0, take);
      const operator = this.config.operator ?? 'LLM-Map';
      const level = Math.max(...oldest.map((s) => s.level)) + 1;
      // A group is bounded by the byte cap, so a large set of roots becomes several summaries.
      // A root whose text exceeds one prompt is split into byte-bounded units carrying its id,
      // exactly as `raise` does (R11); no summary's text is truncated and no prompt overflows.
      const units: Unit[] = [];
      for (const summary of oldest) {
        const rendered = `[Level-${summary.level} summary ${summary.id}]\n${summary.content}`;
        for (const content of splitByBytes(rendered, MAX_SUMMARY_PROMPT_BYTES - SUMMARY_UNIT_OVERHEAD)) {
          units.push({ role: 'system', content, summaryId: summary.id });
        }
      }
      for (const group of packUnits(units)) {
        const parentIds = [...new Set(group.flatMap((unit) => (unit.summaryId ? [unit.summaryId] : [])))];
        const children = parentIds
          .map((id) => this.store.getSummary(id))
          .filter((summary): summary is LcmSummary => summary !== undefined);
        const messageIds = [...new Set(children.flatMap((s) => s.messageIds))];
        const output = await this.callBounded(group, level, operator);
        const content = redactCredentials(summaryContent(output));
        const summaryId = this.store.insertSummary(
          content, estimateTokens(content), level, operator, parentIds, messageIds,
        );
        const surface = await this.recordCall({
          sessionId, summaryId, level, messageIds, parentIds,
          content, contentTokens: estimateTokens(content), output, trigger,
          inputTokens: promptTokensOf(group),
        });
        if (surface) calls.push(surface);
      }
      roots = this.rootSummaries(sessionId);
    }
    const fit = overflowNewestFirst(roots, budget);
    const kept = roots.filter((s) => !fit.includes(s));
    return { summaries: kept.slice().reverse(), calls, roots }; // chronological for the prompt
  }

  /** Roots: summaries no other summary names as a parent, oldest first. */
  private rootSummaries(sessionId: string): LcmSummary[] {
    const all = this.store.getSummariesForSession(sessionId);
    const parents = new Set(all.flatMap((summary) => summary.parentIds));
    return all.filter((summary) => !parents.has(summary.id));
  }

  /**
   * Fits ghost cues, newest first, into `budget`, appending the ones that fit. A cue is a single
   * sentence, so one the budget cannot hold is skipped rather than truncated: a truncated cue
   * would name an id that is no longer the whole id, and the model would expand nothing.
   */
  private fitCues(roots: LcmSummary[], budget: number, ghosts: GhostCue[]): number {
    let used = 0;
    for (const cue of this.ghostCues.buildWithContent(roots)) {
      const cost = estimateTokens(cue.cueText);
      if (used + cost > budget) continue;
      ghosts.push(cue);
      used += cost;
    }
    return used;
  }

  // ── The model call ───────────────────────────────────────────────────────────

  /**
   * One bounded summarization call, retried when it failed in transport (F5). The retry is on the
   * typed error only: a call the model answered badly is a verdict, not a transport failure.
   */
  private async callBounded(
    units: Unit[],
    depth: number,
    operator: 'LLM-Map' | 'Agentic-Map',
  ): Promise<SummaryOutput> {
    const attempts = 1 + Math.max(0, this.config.summaryRetry ?? 1);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.callOperator(units, depth, operator);
      } catch (err: unknown) {
        lastError = err;
        if (!isTransport(err)) break;
      }
    }
    throw lastError;
  }

  private async callOperator(
    units: Unit[],
    depth: number,
    operator: 'LLM-Map' | 'Agentic-Map',
  ): Promise<SummaryOutput> {
    // F7: masked again here, not only at `addMessage`. A summary can be re-summarized at a higher
    // level, and `summaryChunk` accepts ids from any caller, so the input is masked at the one
    // place every prompt passes through.
    const sources = units.map((unit) => ({ role: unit.role, content: redactCredentials(unit.content) }));
    if (operator === 'Agentic-Map') {
      if (!this.agenticMap) {
        throw new Error('Agentic-Map was requested but this LcmEngine has no runSubAgent; supply one or use LLM-Map.');
      }
      return this.agenticMap.complete(sources, depth);
    }
    return this.llmMap.complete(sources, depth);
  }

  private async recordCall(call: {
    sessionId: string;
    summaryId: LcmSummaryId;
    level: number;
    messageIds: LcmMessageId[];
    parentIds: LcmSummaryId[];
    content: string;
    contentTokens: number;
    output: SummaryOutput;
    trigger: LcmTrigger | undefined;
    /** The rendered prompt's estimate — the input half of the charge when nothing was reported. */
    inputTokens: number;
  }): Promise<LcmSummarySurface> {
    const reported = typeof call.output === 'string' ? undefined : call.output.tokensUsed;
    const modelSurface = typeof call.output === 'string' ? undefined : call.output.surface;
    const model = typeof call.output === 'string' ? undefined : call.output.model;
    // R5: what the call spent against the triggering node's budget. The backend's count when it
    // gave one — note openrouter reports prompt plus output, which is exactly the whole call — and
    // otherwise the same estimate the package uses everywhere: input plus output.
    const charged = isTokenCount(reported)
      ? Math.ceil(reported)
      : call.inputTokens + call.contentTokens;
    const surface: LcmSummarySurface = {
      summaryId: call.summaryId,
      level:     call.level,
      messages:  call.messageIds.length,
      chars:     call.content.length,
      contentTokens: call.contentTokens,
      tokenBudgetCharged: charged,
      ...(call.trigger?.nodeId !== undefined ? { nodeId: call.trigger.nodeId } : {}),
      ...(call.trigger?.taskId !== undefined ? { taskId: call.trigger.taskId } : {}),
      ...(isTokenCount(reported) ? { reportedTokens: Math.ceil(reported) } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(modelSurface?.systemPromptSha256 !== undefined
        ? { systemPromptSha256: modelSurface.systemPromptSha256 } : {}),
      ...(modelSurface?.promptSha256 !== undefined ? { promptSha256: modelSurface.promptSha256 } : {}),
      ...(modelSurface?.outputSha256 !== undefined ? { outputSha256: modelSurface.outputSha256 } : {}),
    };
    if (!this.config.recordSummaryCall) return surface;
    await this.config.recordSummaryCall({
      sessionId: call.sessionId,
      summaryId: call.summaryId,
      level: call.level,
      messageIds: call.messageIds,
      parentIds: call.parentIds,
      content: call.content,
      contentTokens: call.contentTokens,
      tokenBudgetCharged: charged,
      ...(isTokenCount(reported) ? { reportedTokens: Math.ceil(reported) } : {}),
      ...(typeof call.output !== 'string' && call.output.model !== undefined ? { model: call.output.model } : {}),
      ...(typeof call.output !== 'string' && call.output.surface !== undefined ? { surface: call.output.surface } : {}),
      ...(call.trigger !== undefined ? { trigger: call.trigger } : {}),
    });
    return surface;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Splits each message into units at the byte cap and keeps its attribution (R3). The cap is
   * bytes, because that is what the operating system counts: a 64 KiB prompt of `'中'` is 192 KiB
   * on the wire and the process refused to start.
   */
  private unitsOf(messages: LcmMessage[]): Unit[] {
    const perUnit = MAX_SUMMARY_PROMPT_BYTES - SUMMARY_UNIT_OVERHEAD;
    const units: Unit[] = [];
    for (const message of messages) {
      for (const content of splitByBytes(message.content, perUnit)) {
        units.push({ role: message.role, content, messageId: message.id });
      }
    }
    return units;
  }

  private missing(requested: LcmMessageId[], found: LcmMessage[]): Error {
    const known = new Set(found.map((m) => m.id));
    const missing = requested.filter((id) => !known.has(id));
    return new Error(
      `LCM compaction was asked to summarize ${requested.length} message(s) but ${missing.length} ` +
      `are not in the store (${missing.slice(0, 3).join(', ')}). Refusing to drop context that would ` +
      `not be in the summary.`,
    );
  }

  /** One compaction per session: each call waits for the previous one, which never rejects. */
  private serialize<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const next = prior.then(work, work);
    this.sessionLocks.set(sessionId, next.then(() => undefined, () => undefined));
    return next;
  }
}

function isTransport(err: unknown): boolean {
  // `instanceof` across the package boundary would be enough in this monorepo, but a structured
  // check also survives a duplicated copy of `@maf/types` in a host: the class carries the name.
  return err instanceof Error && (err.name === 'TransportError' || err.constructor?.name === 'TransportError');
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function reportedTokensOf(output: SummaryOutput, content: string): number {
  if (typeof output !== 'string' && isTokenCount(output.tokensUsed)) return Math.ceil(output.tokensUsed);
  return estimateTokens(content);
}

/**
 * Units into groups whose rendered prompt fits one argument, measured in bytes (R3).
 *
 * `splitByBytes` bounds every unit, so a unit always fits a group on its own; the `group.length > 0`
 * guard keeps that invariant rather than producing an empty group for one oversized unit.
 */
function packUnits(units: Unit[]): Unit[][] {
  const groups: Unit[][] = [];
  let group: Unit[] = [];
  let size = 0;
  for (const unit of units) {
    const cost = byteLength(unit.content) + SUMMARY_UNIT_OVERHEAD;
    if (group.length > 0 && size + cost > MAX_SUMMARY_PROMPT_BYTES) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(unit);
    size += cost;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/**
 * Splits text into chunks of at most `maxBytes` UTF-8 bytes without splitting a code point. The
 * previous cap sliced by UTF-16 code unit, which both miscounted non-ASCII text and could cut a
 * surrogate pair in half.
 */
function splitByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let size = 0;
  for (const char of text) {
    const bytes = byteLength(char);
    if (chunk !== '' && size + bytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += char;
    size += bytes;
  }
  if (chunk !== '' || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

/** The prompt as the summarizer renders it, estimated the package's one way (R5's input half). */
function promptTokensOf(units: Unit[]): number {
  return estimateTokens(units.map((unit) => `[${unit.role.toUpperCase()}] ${unit.content}`).join('\n'));
}

/**
 * Root summaries fitted newest-first into `budget` without compacting (R14): the Dolt archive for a
 * caller that cannot expand a cue. Returned oldest-first, like the Upward archive, because that is
 * the order the injector renders.
 */
function fitRootsNewestFirst(
  roots: LcmSummary[],
  budget: number,
): { summaries: LcmSummary[]; used: number } {
  const kept: LcmSummary[] = [];
  let used = 0;
  for (let i = roots.length - 1; i >= 0; i--) {
    const summary = roots[i]!;
    if (used + summary.tokens > budget) continue;
    kept.push(summary);
    used += summary.tokens;
  }
  return { summaries: kept.reverse(), used };
}

/**
 * The newest messages fitted into the room the archive left (R4c). `candidates` is oldest-first, so
 * iterating backwards renders newest-first; a message that does not fit is skipped here and is
 * compacted by `assembleContext` at this same assembly (V1), not left for a later one. The wrapper
 * and per-message overheads are the injector's own rendering costs, so the returned size is the
 * rendered size, not an estimate of the content alone.
 */
function fitRecent(
  candidates: LcmMessage[],
  budget: number,
): { messages: LcmMessage[]; tokens: number } {
  if (budget <= RECENT_WRAPPER_TOKENS || candidates.length === 0) return { messages: [], tokens: 0 };
  const kept: LcmMessage[] = [];
  let used = RECENT_WRAPPER_TOKENS;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const message = candidates[i]!;
    const cost = estimateTokens(message.content) + RECENT_MESSAGE_OVERHEAD_TOKENS;
    if (used + cost > budget) continue;
    kept.push(message);
    used += cost;
  }
  return { messages: kept, tokens: used };
}

/**
 * The summaries that do NOT fit when taken newest-first: the oldest ones, plus any oversized
 * newer one. `roots` is oldest-first, so iterating backwards is newest-first.
 */
function overflowNewestFirst(roots: LcmSummary[], budget: number): LcmSummary[] {
  let used = 0;
  const kept = new Set<LcmSummaryId>();
  for (let i = roots.length - 1; i >= 0; i--) {
    const summary = roots[i]!;
    if (used + summary.tokens > budget) continue;
    kept.add(summary.id);
    used += summary.tokens;
  }
  return roots.filter((summary) => !kept.has(summary.id));
}

function emptyContext(mode: LcmMode): LcmContext {
  return {
    messages: [], ghosts: [], totalTokens: 0,
    ...(mode === 'Upward' ? { summaries: [] } : {}),
  };
}
