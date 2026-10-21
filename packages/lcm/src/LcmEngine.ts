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
  estimateTokens, summaryContent, MAX_SUMMARY_PROMPT_CHARS, type SummaryOutput,
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
  model?:          string;
  surface?:        ModelSurface;
  trigger?:        LcmTrigger;
}

export interface LcmEngineConfig {
  dbPath:            string;
  contextThreshold:  number;   // 0.0–1.0, default 0.75 — triggers compaction
  freshTailCount:    number;   // recent messages protected from compaction, default 64
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
  role:     LcmMessage['role'];
  content:  string;
  messageId?: LcmMessageId;
}

/** A summary a higher level summarizes: its id and what it says. */
interface ParentUnit {
  id:      LcmSummaryId;
  content: string;
}

const SUMMARY_UNIT_OVERHEAD = 32; // `[ASSISTANT] ` + the joining newline, generously rounded.

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
   * The context a node is given (WP-3.2, D-17; budget semantics D-52 F2).
   *
   * `messages` are the loop's own recent history. Compaction summarizes exactly the uncompacted
   * messages outside the fresh tail, and those summarized messages are the only ones not returned
   * raw. If compaction fails, every uncompacted message is returned raw and the failure is recorded
   * (F5): nothing is dropped unsummarized.
   *
   * `totalTokens` counts what the injector renders — summaries or ghost cues — and nothing else,
   * because that is the only thing competing with the rest of the prompt for the injector's
   * budget. A summary call made during this assembly is charged separately (`compactionTokens`)
   * and is reserved out of the archive's share before anything is fitted (F1).
   */
  async assembleContext(
    sessionId: string,
    tokenBudget: number,
    mode: LcmMode = this.config.mode,
    trigger?: LcmTrigger,
  ): Promise<LcmContext> {
    if (mode === 'off' || tokenBudget <= 0) return emptyContext(mode);

    const uncompacted = this.store.getUncompactedMessages(sessionId, 0);
    const rawTokens   = uncompacted.reduce((s, m) => s + m.tokens, 0);
    const summaryCalls: LcmSummarySurface[] = [];
    const degradedRecords: LcmDegradedRecord[] = [];
    let compactionTokens = 0;
    let degraded = false;
    const overThreshold = rawTokens > tokenBudget * this.config.contextThreshold;

    if (overThreshold) {
      const droppable = this.store.getUncompactedMessages(sessionId, this.config.freshTailCount);
      if (droppable.length > 0) {
        try {
          const operator = this.config.operator ?? 'LLM-Map';
          const result = await this.serialize(sessionId, () =>
            this.compactLocked(sessionId, droppable.map((m) => m.id), operator, trigger));
          compactionTokens = result.reportedTokens.reduce((s, n) => s + n, 0);
          summaryCalls.push(...result.calls);
        } catch (err: unknown) {
          // F5: a failed compaction degrades. The node continues uncompacted and the failure is
          // recorded; throwing here would turn a background optimization into a node failure.
          degraded = true;
          const record = {
            sessionId, reason: err instanceof Error ? err.message : String(err),
            ...(trigger?.taskId ? { taskId: trigger.taskId } : {}),
            ...(trigger?.nodeId ? { nodeId: trigger.nodeId } : {}),
          };
          degradedRecords.push(record);
          await this.config.onDegraded?.(record);
        }
      }
    }

    // What stays raw. On success, the fresh tail: everything older is covered by a summary. On
    // failure — or when no compaction was needed or possible — every uncompacted message, so no
    // message is dropped without a summary that covers it (E10).
    const remaining = this.store.getUncompactedMessages(sessionId, 0);
    const messages = degraded
      ? remaining
      : overThreshold
        ? this.store.getFreshTail(sessionId, this.config.freshTailCount)
            .filter((m) => m.summaryId === undefined)
        : remaining;

    const archiveBudget = Math.max(0, tokenBudget - compactionTokens);
    const ghosts: GhostCue[] = [];
    let included: LcmSummary[] = [];
    let used = 0;

    if (mode === 'Upward') {
      const archive = await this.fitUpward(sessionId, archiveBudget, trigger);
      included = archive.summaries;
      summaryCalls.push(...archive.calls);
      used = included.reduce((s, summary) => s + summary.tokens, 0);
    } else {
      // Cues are sentences, newest first: the most recent archive is the most relevant, and a cue
      // the budget cannot hold is skipped rather than crowding out the rest.
      for (const cue of this.ghostCues.buildWithContent(this.rootSummaries(sessionId))) {
        const cost = estimateTokens(cue.cueText);
        if (used + cost > archiveBudget) continue;
        ghosts.push(cue);
        used += cost;
      }
    }

    return {
      messages,
      ghosts,
      totalTokens: used,
      ...(compactionTokens > 0 ? { compactionTokens } : {}),
      ...(mode === 'Upward' ? { summaries: included } : {}),
      ...(summaryCalls.length > 0 ? { summaryCalls } : {}),
      ...(degradedRecords.length > 0 ? { degraded: degradedRecords } : {}),
    };
  }

  async lcm_grep(query: string, sessionId: string): Promise<LcmMessage[]> {
    return this.store.searchMessages(query, sessionId);
  }

  async lcm_expand(summaryId: LcmSummaryId): Promise<LcmMessage[]> {
    return (await this.expandSummary(summaryId))?.messages ?? [];
  }

  /**
   * A summary and the messages it covers, newest API for `lcm.expand` (WP-3.2 F8): the Dolt cue
   * tells the model to call a tool, so the tool needs the summary text as well as the messages.
   *
   * `summaryId` is a plain `string` because this is the tool boundary, where the id comes from a
   * model. The lookup is a bound store parameter (never query text), so the brand adds no safety
   * here; an id from another run simply finds nothing.
   */
  async expandSummary(summaryId: string): Promise<{ summary: LcmSummary; messages: LcmMessage[] } | undefined> {
    const summary = this.store.getSummary(summaryId as LcmSummaryId);
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
        content, contentTokens, output, trigger,
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

    // Each rendered child is packed into a chunk beneath the cap; a child too large for one chunk
    // is split across summaries, and each summary names exactly the children it saw (F4). The
    // previous version named the whole group on every chunk, so a summary could claim a parent
    // whose text was in another call.
    const rendered = children.map((child) => ({
      child,
      unit: { role: 'system' as const, content: `[Level-${level - 1} summary ${child.id}]\n${child.content}` },
    }));
    const parents: ParentUnit[] = [];
    for (const chunk of packUnits(rendered.map((entry) => entry.unit))) {
      const included = rendered.filter((entry) =>
        chunk.some((unit) => unit === entry.unit));
      const output = await this.callBounded(chunk, level, operator);
      const content = summaryContent(output);
      const contentTokens = estimateTokens(content);
      const childIds = included.map((entry) => entry.child.id);
      const childSummaries = childIds
        .map((id) => this.store.getSummary(id))
        .filter((summary): summary is LcmSummary => summary !== undefined);
      const messageIds = [...new Set(childSummaries.flatMap((s) => s.messageIds))];
      const summaryId = this.store.insertSummary(content, contentTokens, level, operator, childIds, messageIds);
      reported.push(reportedTokensOf(output, content));
      const surface = await this.recordCall({
        sessionId, summaryId, level, messageIds, parentIds: childIds,
        content, contentTokens, output, trigger,
      });
      if (surface) calls.push(surface);
      parents.push({ id: summaryId, content });
    }
    return this.raise(parents, level + 1, operator, sessionId, trigger, reported, calls);
  }

  /**
   * The Upward archive, newest first, compacting the oldest roots upward when they no longer fit
   * (D-52 F2/F9). Summaries get room before anything else the injector renders, because they are
   * what the injector renders; the raw tail is the loop's own history and is not charged.
   */
  private async fitUpward(
    sessionId: string,
    budget: number,
    trigger: LcmTrigger | undefined,
  ): Promise<{ summaries: LcmSummary[]; calls: LcmSummarySurface[] }> {
    const calls: LcmSummarySurface[] = [];
    let roots = this.rootSummaries(sessionId);
    if (roots.length === 0) return { summaries: [], calls };
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
      // A group is bounded by the prompt cap, so a large set of roots becomes several parents;
      // the outer loop compacts again until one root covers them all or the budget fits.
      for (const group of packSummaries(oldest)) {
        const messageIds = [...new Set(group.flatMap((s) => s.messageIds))];
        const output = await this.callBounded(
          group.map((summary) => ({
            role: 'system' as const,
            content: `[Level-${summary.level} summary ${summary.id}]\n${summary.content}`,
          })),
          level, operator,
        );
        const content = redactCredentials(summaryContent(output));
        const summaryId = this.store.insertSummary(
          content, estimateTokens(content), level, operator, group.map((s) => s.id), messageIds,
        );
        const surface = await this.recordCall({
          sessionId, summaryId, level, messageIds, parentIds: group.map((s) => s.id),
          content, contentTokens: estimateTokens(content), output, trigger,
        });
        if (surface) calls.push(surface);
      }
      roots = this.rootSummaries(sessionId);
    }
    const fit = overflowNewestFirst(roots, budget);
    const kept = roots.filter((s) => !fit.includes(s));
    return { summaries: kept.slice().reverse(), calls }; // chronological for the prompt
  }

  /** Roots: summaries no other summary names as a parent, oldest first. */
  private rootSummaries(sessionId: string): LcmSummary[] {
    const all = this.store.getSummariesForSession(sessionId);
    const parents = new Set(all.flatMap((summary) => summary.parentIds));
    return all.filter((summary) => !parents.has(summary.id));
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
  }): Promise<LcmSummarySurface> {
    const reported = typeof call.output === 'string' ? undefined : call.output.tokensUsed;
    const modelSurface = typeof call.output === 'string' ? undefined : call.output.surface;
    const model = typeof call.output === 'string' ? undefined : call.output.model;
    const surface: LcmSummarySurface = {
      summaryId: call.summaryId,
      level:     call.level,
      messages:  call.messageIds.length,
      chars:     call.content.length,
      contentTokens: call.contentTokens,
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
      ...(isTokenCount(reported) ? { reportedTokens: Math.ceil(reported) } : {}),
      ...(typeof call.output !== 'string' && call.output.model !== undefined ? { model: call.output.model } : {}),
      ...(typeof call.output !== 'string' && call.output.surface !== undefined ? { surface: call.output.surface } : {}),
      ...(call.trigger !== undefined ? { trigger: call.trigger } : {}),
    });
    return surface;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Splits each message into units at the prompt cap and keeps its attribution. */
  private unitsOf(messages: LcmMessage[]): Unit[] {
    const perUnit = MAX_SUMMARY_PROMPT_CHARS - SUMMARY_UNIT_OVERHEAD;
    const units: Unit[] = [];
    for (const message of messages) {
      for (let start = 0; start < message.content.length; start += perUnit) {
        units.push({
          role:      message.role,
          content:   message.content.slice(start, start + perUnit),
          messageId: message.id,
        });
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

/** Units into groups whose rendered prompt fits one argument. */
function packUnits(units: Unit[]): Unit[][] {
  const groups: Unit[][] = [];
  let group: Unit[] = [];
  let size = 0;
  for (const unit of units) {
    const cost = unit.content.length + SUMMARY_UNIT_OVERHEAD;
    if (group.length > 0 && size + cost > MAX_SUMMARY_PROMPT_CHARS) {
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

/** Stored summaries into groups whose rendered prompts fit one argument (F4, F9). */
function packSummaries(summaries: LcmSummary[]): LcmSummary[][] {
  const groups: LcmSummary[][] = [];
  let group: LcmSummary[] = [];
  let size = 0;
  for (const summary of summaries) {
    const cost = summary.content.length + 64; // level marker, id and separators
    if (group.length > 0 && size + cost > MAX_SUMMARY_PROMPT_CHARS) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(summary);
    size += cost;
  }
  if (group.length > 0) groups.push(group);
  return groups;
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
