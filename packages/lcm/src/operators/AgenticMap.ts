import type { LcmMessage, LcmSummaryId, RunId } from '@maf/types';
import { makeRunId } from '@maf/types';
import type { LcmStore } from '../LcmStore.js';

export interface AgenticMapConfig {
  store: LcmStore;
  // Spawns a full sub-agent session and returns its output
  runSubAgent(systemPrompt: string, userMessages: string[]): Promise<string>;
}

// Agentic-Map operator: each chunk gets a full sub-agent session.
// Higher quality than LLM-Map but more expensive — use for critical context.
export class AgenticMap {
  private static readonly SYSTEM_PROMPT = `You are a context summarization agent.
Your job is to distill a sequence of conversation messages into a dense, accurate summary.
Preserve all factual claims, decisions made, errors encountered, and solutions found.
Output in plain prose. Do not include metadata or timestamps.`;

  constructor(private readonly config: AgenticMapConfig) {}

  async run(
    messages: LcmMessage[],
    depth = 0,
    parentIds: LcmSummaryId[] = [],
  ): Promise<LcmSummaryId> {
    const formatted = messages.map((m) => `[${m.role.toUpperCase()}] ${m.content}`);
    const content   = await this.config.runSubAgent(AgenticMap.SYSTEM_PROMPT, formatted);
    const tokens    = Math.ceil(content.length / 4);
    const messageIds = messages.map((m) => m.id);
    const summaryId  = this.config.store.insertSummary(content, tokens, depth, 'Agentic-Map', parentIds, messageIds);
    this.config.store.markSummarized(messageIds, summaryId);
    return summaryId;
  }

  // Per-item agentic processing: each message chunk triggers an independent sub-agent.
  // Used when individual items require reasoning beyond simple text compression.
  async runPerItem(
    items: LcmMessage[],
    runId: RunId = makeRunId('agentic-map'),
  ): Promise<LcmSummaryId[]> {
    const results: LcmSummaryId[] = [];
    for (const msg of items) {
      const id = await this.run([msg], 0);
      results.push(id);
    }
    return results;
  }
}
