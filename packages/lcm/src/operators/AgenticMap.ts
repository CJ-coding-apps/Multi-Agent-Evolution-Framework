import type { LcmMessage, LcmSummaryId, RunId } from '@maf/types';
import { makeRunId } from '@maf/types';
import type { LcmStore } from '../LcmStore.js';
import { summaryContent, summaryTokens, type SummaryOutput } from '../summarizer.js';
import type { SummarySource } from './LlmMap.js';

export interface AgenticMapConfig {
  store: LcmStore;
  /**
   * Spawns a full sub-agent session and returns its output. An object is accepted as well as a
   * string, so the backend's own token count and model-facing surface travel back with the text
   * (WP-3.2 F1): a summary made through this operator is recorded and budgeted like any other.
   */
  runSubAgent(systemPrompt: string, userMessages: string[]): Promise<SummaryOutput>;
}

// Agentic-Map operator: each chunk gets a full sub-agent session.
// Higher quality than LLM-Map but more expensive — use for critical context.
export class AgenticMap {
  private static readonly SYSTEM_PROMPT = `You are a context summarization agent.
Your job is to distill a sequence of conversation messages into a dense, accurate summary.
Preserve all factual claims, decisions made, errors encountered, and solutions found.
Output in plain prose. Do not include metadata or timestamps.`;

  constructor(private readonly config: AgenticMapConfig) {}

  /**
   * Calls the sub-agent and returns its answer; the engine inserts the summary (WP-3.2). The
   * caller chooses this operator through `lcm.operator` and gets an error if no sub-agent was
   * supplied — never a silent fall back to LLM-Map.
   */
  async complete(sources: SummarySource[], _depth = 0, targetTokens?: number): Promise<SummaryOutput> {
    const formatted = sources.map((source) => `[${source.role.toUpperCase()}] ${source.content}`);
    // L3: the sub-agent gets the same stated target the LLM-Map path does. It is an instruction,
    // not a guarantee; the engine decides what to do when the answer still does not fit.
    const systemPrompt = targetTokens === undefined
      ? AgenticMap.SYSTEM_PROMPT
      : `${AgenticMap.SYSTEM_PROMPT}\nAim for at most ${targetTokens} tokens.`;
    return this.config.runSubAgent(systemPrompt, formatted);
  }

  async run(
    messages: LcmMessage[],
    depth = 0,
    childIds: LcmSummaryId[] = [],
    targetTokens?: number,
  ): Promise<LcmSummaryId> {
    const output    = await this.complete(messages, depth, targetTokens);
    const content   = summaryContent(output);
    const tokens    = summaryTokens(output, content);
    const messageIds = messages.map((m) => m.id);
    const summaryId  = this.config.store.insertSummary(content, tokens, depth, 'Agentic-Map', childIds, messageIds);
    this.config.store.markSummarized(messageIds, summaryId);
    return summaryId;
  }

  // Per-item agentic processing: each message chunk triggers an independent sub-agent.
  // Used when individual items require reasoning beyond simple text compression.
  async runPerItem(
    items: LcmMessage[],
    runId: RunId = makeRunId('agentic-map'),
  ): Promise<LcmSummaryId[]> {
    void runId;
    const results: LcmSummaryId[] = [];
    for (const msg of items) {
      results.push(await this.run([msg], 0));
    }
    return results;
  }
}
