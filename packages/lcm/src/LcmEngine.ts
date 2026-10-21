import type {
  LcmApi, LcmMessage, LcmSummary, LcmContext, LcmMode,
  LcmMessageId, LcmSummaryId, GhostCue, RunId,
} from '@maf/types';
import { LcmStore } from './LcmStore.js';
import { GhostCueBuilder } from './GhostCueBuilder.js';
import { SessionMerger } from './SessionMerger.js';
import { LlmMap } from './operators/LlmMap.js';
import { AgenticMap } from './operators/AgenticMap.js';
import { estimateTokens, type SummaryOutput } from './summarizer.js';

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
  runSubAgent?(systemPrompt: string, userMessages: string[]): Promise<string>;
  /** Operator automatic compaction uses. Default `LLM-Map`. */
  operator?: 'LLM-Map' | 'Agentic-Map';
}

export class LcmEngine implements LcmApi {
  private readonly store: LcmStore;
  private readonly config: LcmEngineConfig;
  private readonly llmMap: LlmMap;
  private readonly agenticMap?: AgenticMap;
  private readonly ghostCues = new GhostCueBuilder();
  private readonly merger: SessionMerger;

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

  async addMessage(msg: Omit<LcmMessage, 'id' | 'createdAt'>): Promise<LcmMessageId> {
    return this.store.insertMessage(msg);
  }

  /**
   * Summarizes exactly `messageIds` — no more and no fewer. An id that is not in the store is an
   * error: the version this replaces was handed transcript-entry ids it had never stored (the
   * `as never[]` cast), summarized nothing, and then dropped those entries from the in-memory
   * transcript, so a run lost context with no error anywhere (D-26).
   */
  async summarizeChunk(
    messageIds: LcmMessageId[],
    operator: 'LLM-Map' | 'Agentic-Map',
  ): Promise<LcmSummaryId> {
    if (messageIds.length === 0) {
      throw new Error('LCM compaction was asked to summarize an empty chunk; there is nothing to drop.');
    }
    const messages = this.store.getMessagesByIds(messageIds);
    if (messages.length !== messageIds.length) {
      const known = new Set(messages.map((m) => m.id));
      const missing = messageIds.filter((id) => !known.has(id));
      throw new Error(
        `LCM compaction was asked to summarize ${messageIds.length} message(s) but ${missing.length} ` +
        `are not in the store (${missing.slice(0, 3).join(', ')}). Refusing to drop context that would ` +
        `not be in the summary.`,
      );
    }
    const depth = 0; // leaf-level summary
    if (operator === 'Agentic-Map') {
      if (!this.agenticMap) {
        throw new Error('Agentic-Map was requested but this LcmEngine has no runSubAgent; supply one or use LLM-Map.');
      }
      return this.agenticMap.run(messages, depth);
    }
    return this.llmMap.run(messages, depth);
  }

  /**
   * The context a node is given (WP-3.2, D-17). Both modes keep the newest `freshTailCount`
   * messages raw, summarize exactly the uncompacted messages older than that, and count every
   * piece they return — fresh messages, summaries, ghost cues — against `tokenBudget`, so the
   * caller's budget is a ceiling and not a suggestion.
   *
   *  - `Dolt`: the archive is offered as ghost cues (`lcm_expand` recovers it on demand).
   *  - `Upward`: the summaries themselves are in `summaries` and the injector renders them, so
   *    the model reads the archive without a tool call.
   */
  async assembleContext(
    sessionId: string,
    tokenBudget: number,
    mode: LcmMode = this.config.mode,
  ): Promise<LcmContext> {
    if (tokenBudget <= 0) return emptyContext(mode);

    const uncompacted = this.store.getUncompactedMessages(sessionId, 0);
    const rawTokens   = uncompacted.reduce((s, m) => s + m.tokens, 0);
    const overBudget  = rawTokens > tokenBudget * this.config.contextThreshold;

    if (overBudget) {
      const droppable = this.store.getUncompactedMessages(sessionId, this.config.freshTailCount);
      if (droppable.length > 0) {
        await this.summarizeChunk(droppable.map((m) => m.id), this.config.operator ?? 'LLM-Map');
      }
    }

    // What stays raw: everything uncompacted when the budget is roomy, only the fresh tail when
    // compaction ran. Both are chronological.
    const raw = overBudget
      ? this.store.getFreshTail(sessionId, this.config.freshTailCount)
      : uncompacted;
    const messages = fitOldestFirst(raw, tokenBudget);

    const summaries = this.store.getSummariesForSession(sessionId);
    let used = messages.reduce((s, m) => s + m.tokens, 0);
    let included: LcmSummary[] = [];
    const ghosts: GhostCue[] = [];

    if (mode === 'Upward') {
      // Newest first while fitting, then back to chronological for the prompt.
      const newestFirst = [...summaries].reverse();
      for (const summary of newestFirst) {
        if (used + summary.tokens > tokenBudget) continue;
        included.push(summary);
        used += summary.tokens;
      }
      included = included.reverse();
    } else {
      for (const cue of this.ghostCues.buildWithContent(summaries)) {
        const cost = estimateTokens(cue.cueText);
        if (used + cost > tokenBudget) continue;
        ghosts.push(cue);
        used += cost;
      }
    }

    return {
      messages,
      ghosts,
      totalTokens: used,
      ...(mode === 'Upward' ? { summaries: included } : {}),
    };
  }

  async lcm_grep(query: string, sessionId: string): Promise<LcmMessage[]> {
    return this.store.searchMessages(query, sessionId);
  }

  async lcm_expand(summaryId: LcmSummaryId): Promise<LcmMessage[]> {
    const summary = this.store.getSummary(summaryId);
    if (!summary) return [];
    // Recursively expand: if messages are themselves summaries, drill further
    return this.store.getMessagesByIds(summary.messageIds);
  }

  async mergeRuns(runIds: RunId[], targetRunId: RunId): Promise<void> {
    // One implementation (D-18): the same union merge `SessionMerger` exposes, so the two
    // cannot drift apart.
    await this.merger.mergeRuns(runIds, targetRunId);
  }

  close(): void { this.store.close(); }
}

/** The oldest messages are dropped first, so the newest stay. */
function fitOldestFirst(messages: LcmMessage[], budget: number): LcmMessage[] {
  let used = messages.reduce((s, m) => s + m.tokens, 0);
  let start = 0;
  while (start < messages.length && used > budget) {
    used -= messages[start]?.tokens ?? 0;
    start++;
  }
  return start === 0 ? messages : messages.slice(start);
}

function emptyContext(mode: LcmMode): LcmContext {
  return { messages: [], ghosts: [], totalTokens: 0, ...(mode === 'Upward' ? { summaries: [] } : {}) };
}
