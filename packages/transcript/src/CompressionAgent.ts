import type { LcmSummaryId } from '@maf/types';
import type { LcmEngine } from '@maf/lcm';
import type { TranscriptEntry } from '@maf/types';

export interface CompressionAgentConfig {
  lcm:          LcmEngine;
  chunkSize:    number;   // messages per compaction run, default 20
  softThreshold: number;  // token count above which compaction triggers
  // Optional: called after each compaction with the new summary ID
  onCompacted?: (summaryId: LcmSummaryId, tokensFreed: number) => void;
}

export class CompressionAgent {
  private compacting = false;
  private pendingEntries: TranscriptEntry[] = [];
  private totalTokens   = 0;

  constructor(private readonly config: CompressionAgentConfig) {}

  // Feed entries into the agent. Compaction fires in the background when over threshold.
  ingest(entry: TranscriptEntry): void {
    this.pendingEntries.push(entry);
    this.totalTokens += entry.tokens;

    if (this.totalTokens > this.config.softThreshold && !this.compacting) {
      this.compactOldest().catch(() => undefined);
    }
  }

  // Force an immediate compaction pass (returns null if nothing to compact)
  async compactNow(): Promise<LcmSummaryId | null> {
    const chunk = this.pendingEntries.slice(0, this.config.chunkSize);
    if (chunk.length === 0) return null;
    return this.compact(chunk);
  }

  private async compactOldest(): Promise<void> {
    this.compacting = true;
    try {
      const chunk = this.pendingEntries.slice(0, this.config.chunkSize);
      if (chunk.length === 0) return;
      await this.compact(chunk);
    } finally {
      this.compacting = false;
    }
  }

  private async compact(chunk: TranscriptEntry[]): Promise<LcmSummaryId> {
    const messageIds = chunk.map((e) => e.id) as never[];
    const summaryId  = await this.config.lcm.summarizeChunk(messageIds, 'LLM-Map');
    const freed      = chunk.reduce((s, e) => s + e.tokens, 0);

    this.pendingEntries.splice(0, chunk.length);
    this.totalTokens = Math.max(0, this.totalTokens - freed);

    this.config.onCompacted?.(summaryId, freed);
    return summaryId;
  }

  getTotalTokens(): number { return this.totalTokens; }
  getPendingCount(): number { return this.pendingEntries.length; }
}
