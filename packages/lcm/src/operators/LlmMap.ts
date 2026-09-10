import type { LcmMessage, LcmSummaryId } from '@maf/types';
import type { LcmStore } from '../LcmStore.js';

export interface LlmMapConfig {
  // Calls the underlying LLM with the messages and returns a summary string
  summarize(messages: LcmMessage[], depth: number): Promise<string>;
  store: LcmStore;
}

// LLM-Map operator: independently summarizes each chunk with a single LLM call.
// Equivalent to a map() over the message sequence — no inter-chunk state.
export class LlmMap {
  constructor(private readonly config: LlmMapConfig) {}

  async run(
    messages: LcmMessage[],
    depth = 0,
    parentIds: LcmSummaryId[] = [],
  ): Promise<LcmSummaryId> {
    const content = await this.config.summarize(messages, depth);
    const tokens  = Math.ceil(content.length / 4);
    const messageIds = messages.map((m) => m.id);
    const summaryId  = this.config.store.insertSummary(content, tokens, depth, 'LLM-Map', parentIds, messageIds);
    this.config.store.markSummarized(messageIds, summaryId);
    return summaryId;
  }

  // Hierarchical map: summarize in chunks, then summarize the summaries
  async runHierarchical(messages: LcmMessage[], chunkSize = 20): Promise<LcmSummaryId> {
    if (messages.length <= chunkSize) {
      return this.run(messages, 0);
    }

    // Level-0: chunk and summarize
    const level0Ids: LcmSummaryId[] = [];
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize);
      level0Ids.push(await this.run(chunk, 0));
    }

    // Level-1: summarize the summaries by generating stub messages from summaries
    const level0Messages: LcmMessage[] = level0Ids.map((id, idx) => {
      const stub = this.config.store.getSummary(id);
      return {
        id:        id as unknown as import('@maf/types').LcmMessageId,
        sessionId: 'merge',
        runId:     'merge' as import('@maf/types').RunId,
        role:      'assistant' as const,
        content:   stub?.content ?? `[summary ${idx}]`,
        tokens:    stub?.tokens ?? 0,
        createdAt: new Date(),
        summaryId: id,
      };
    });

    return this.run(level0Messages, 1, level0Ids);
  }
}
