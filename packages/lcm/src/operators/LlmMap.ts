import type { LcmMessage, LcmSummaryId } from '@maf/types';
import type { LcmStore } from '../LcmStore.js';
import { summaryContent, summaryTokens, type SummaryOutput } from '../summarizer.js';

/** The part of a message a summary prompt is built from. */
export interface SummarySource {
  role:    LcmMessage['role'];
  content: string;
}

export interface LlmMapConfig {
  /** The run's model call: summarize this chunk of messages. */
  summarize(messages: LcmMessage[], depth: number): Promise<SummaryOutput>;
  store: LcmStore;
}

// LLM-Map operator: independently summarizes each chunk with a single LLM call.
// Equivalent to a map() over the message sequence — no inter-chunk state.
export class LlmMap {
  constructor(private readonly config: LlmMapConfig) {}

  /**
   * Calls the model and returns its answer (WP-3.2). The engine owns insertion, because a summary
   * may be a level-0 summary of messages or a level-1 summary of summaries, and only the engine
   * knows which parent ids and which descendant messages the record must carry.
   */
  async complete(sources: SummarySource[], depth = 0): Promise<SummaryOutput> {
    // The summarizer in production reads only `role` and `content`. Sources built from summaries
    // are given synthetic messages so this seam stays one shape; they never reach the store.
    const messages = sources.map((source, index) => ({
      id:        `unit-${index}` as LcmMessage['id'],
      sessionId: '',
      runId:     '' as LcmMessage['runId'],
      role:      source.role,
      content:   source.content,
      tokens:    0,
      createdAt: new Date(0),
    })) as LcmMessage[];
    return this.config.summarize(messages, depth);
  }

  async run(
    messages: LcmMessage[],
    depth = 0,
    parentIds: LcmSummaryId[] = [],
  ): Promise<LcmSummaryId> {
    const output  = await this.complete(messages, depth);
    const content = summaryContent(output);
    const tokens  = summaryTokens(output, content);
    const messageIds = messages.map((m) => m.id);
    const summaryId  = this.config.store.insertSummary(content, tokens, depth, 'LLM-Map', parentIds, messageIds);
    this.config.store.markSummarized(messageIds, summaryId);
    return summaryId;
  }

  // Hierarchical map: summarize in chunks, then summarize the summaries. Kept for callers that
  // use the operator on its own; the engine's compaction does the same thing without the stub
  // message ids this used to fabricate.
  async runHierarchical(messages: LcmMessage[], chunkSize = 20): Promise<LcmSummaryId> {
    if (messages.length <= chunkSize) {
      return this.run(messages, 0);
    }

    const level0Ids: LcmSummaryId[] = [];
    for (let i = 0; i < messages.length; i += chunkSize) {
      level0Ids.push(await this.run(messages.slice(i, i + chunkSize), 0));
    }

    const level0: LcmMessage[] = level0Ids.map((id) => {
      const summary = this.config.store.getSummary(id)!;
      return {
        id:        id as unknown as LcmMessage['id'],
        sessionId: '',
        runId:     '' as LcmMessage['runId'],
        role:      'assistant' as const,
        content:   summary.content,
        tokens:    summary.tokens,
        createdAt: summary.createdAt,
        summaryId: id,
      };
    });

    return this.run(level0, 1, level0Ids);
  }
}
