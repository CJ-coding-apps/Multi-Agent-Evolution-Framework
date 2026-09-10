import type {
  LcmApi, LcmMessage, LcmSummary, LcmContext, LcmMode,
  LcmMessageId, LcmSummaryId, GhostCue, RunId,
} from '@maf/types';
import { makeLcmSummaryId } from '@maf/types';
import { LcmStore } from './LcmStore.js';

// Rough token count — 4 chars ≈ 1 token
function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

export interface LcmEngineConfig {
  dbPath:            string;
  contextThreshold:  number;   // 0.0–1.0, default 0.75 — triggers compaction
  freshTailCount:    number;   // recent messages protected from compaction, default 64
  mode:              LcmMode;
  // Injected summarizer: takes messages, returns summary text
  summarize(messages: LcmMessage[], depth: number): Promise<string>;
}

export class LcmEngine implements LcmApi {
  private store: LcmStore;
  private config: LcmEngineConfig;

  constructor(config: LcmEngineConfig) {
    this.config = config;
    this.store  = new LcmStore(config.dbPath);
  }

  async addMessage(msg: Omit<LcmMessage, 'id' | 'createdAt'>): Promise<LcmMessageId> {
    return this.store.insertMessage(msg);
  }

  async summarizeChunk(
    messageIds: LcmMessageId[],
    operator: 'LLM-Map' | 'Agentic-Map',
  ): Promise<LcmSummaryId> {
    const messages  = this.store.getMessagesByIds(messageIds);
    const depth     = 0; // leaf-level summary
    const content   = await this.config.summarize(messages, depth);
    const tokens    = estimateTokens(content);
    const summaryId = this.store.insertSummary(content, tokens, depth, operator, [], messageIds);
    this.store.markSummarized(messageIds, summaryId);
    return summaryId;
  }

  async assembleContext(
    sessionId: string,
    tokenBudget: number,
    mode: LcmMode = this.config.mode,
  ): Promise<LcmContext> {
    const allMessages = this.store.getMessagesBySession(sessionId);
    const totalRaw    = allMessages.reduce((s, m) => s + m.tokens, 0);

    // If under threshold: return raw messages, no compaction needed
    if (totalRaw <= tokenBudget * this.config.contextThreshold) {
      return { messages: allMessages, ghosts: [], totalTokens: totalRaw };
    }

    // Need compaction — trigger if not already done
    const uncompacted = this.store.getUncompactedMessages(sessionId, this.config.freshTailCount);
    if (uncompacted.length > 0) {
      await this.summarizeChunk(uncompacted.map((m) => m.id), 'LLM-Map');
    }

    // Re-fetch: fresh tail (raw) + summaries as ghost cues
    const fresh    = this.store.getMessagesBySession(sessionId, this.config.freshTailCount);
    const ghosts   = mode === 'Dolt' ? this.buildGhostCues(sessionId) : [];
    const freshTokens = fresh.reduce((s, m) => s + m.tokens, 0);

    return { messages: fresh, ghosts, totalTokens: freshTokens };
  }

  async lcm_grep(query: string, sessionId: string): Promise<LcmMessage[]> {
    return this.store.searchMessages(query, sessionId);
  }

  async lcm_expand(summaryId: LcmSummaryId): Promise<LcmMessage[]> {
    const summary = this.store.getSummary(summaryId);
    if (!summary) return [];
    // Recursively expand: if messages are themselves summaries, drill further
    const messages = this.store.getMessagesByIds(summary.messageIds);
    return messages;
  }

  async mergeRuns(runIds: RunId[], targetRunId: RunId): Promise<void> {
    // For each run, re-tag its messages to the target run (union merge)
    // In a production system this would handle conflicts; here we do a simple copy
    for (const runId of runIds) {
      const messages = this.store.getMessagesBySession(runId);
      for (const msg of messages) {
        this.store.insertMessage({ ...msg, runId: targetRunId, sessionId: targetRunId });
      }
    }
  }

  private buildGhostCues(sessionId: string): GhostCue[] {
    // Dolt mode: build cues from sessions' summaries so model can recall via lcm_expand
    const messages = this.store.getMessagesBySession(sessionId);
    const summarized = messages.filter((m) => m.summaryId);
    const summaryIds = [...new Set(summarized.map((m) => m.summaryId!))];

    return summaryIds.slice(0, 10).map((summaryId, i) => ({
      summaryId,
      cueText: `[Archived context segment ${i + 1} — call lcm_expand("${summaryId}") to recover]`,
      relevance: 1 - i * 0.1,
    }));
  }

  close(): void { this.store.close(); }
}
