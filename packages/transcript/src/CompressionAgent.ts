import type { LcmMessageId, LcmSummaryId, TranscriptEntry } from '@maf/types';
import type { LcmEngine } from '@maf/lcm';

export interface CompressionAgentConfig {
  lcm:          LcmEngine;
  chunkSize:    number;   // messages per compaction run, default 20
  softThreshold: number;  // token count above which compaction triggers
  // Optional: called after each compaction with the new summary ID
  onCompacted?: (summaryId: LcmSummaryId, tokensFreed: number) => void;
  /**
   * A compaction that failed. Compaction runs in the background from `ingest`, so a rejection
   * cannot be thrown at the caller; it must not vanish either. The logger this replaces dropped
   * it with `.catch(() => undefined)`, which is how a run kept losing context (D-26).
   */
  onError?: (err: unknown) => void;
}

interface Pending {
  entry:     TranscriptEntry;
  messageId: LcmMessageId;
}

export class CompressionAgent {
  private inFlight: Promise<void> | undefined;
  private pending: Pending[] = [];
  private totalTokens = 0;

  constructor(private readonly config: CompressionAgentConfig) {}

  /**
   * Feed an entry and the id the LCM store gave it. Both are required: compaction must summarize
   * the rows that exist, and the transcript entry's own id is not one of them (the `as never[]`
   * cast in the version this replaces made every compaction summarize nothing).
   */
  ingest(entry: TranscriptEntry, messageId: LcmMessageId): void {
    this.pending.push({ entry, messageId });
    this.totalTokens += entry.tokens;

    // One pass may not be enough: an entry appended while a pass is in flight has to be picked up
    // after it, or a run that keeps appending strands a growing backlog (D-26's silent loss in a
    // quieter form). The loop ends when the threshold is met or the queue is empty; a failure
    // rejects out of the loop, is reported, and leaves the entries in place.
    if (this.inFlight === undefined && this.overThreshold()) {
      const run = this.drain();
      this.inFlight = run;
      run
        .catch((err: unknown) => this.config.onError?.(err))
        .finally(() => { this.inFlight = undefined; });
    }
  }

  private overThreshold(): boolean {
    return this.totalTokens > this.config.softThreshold && this.pending.length > 0;
  }

  private async drain(): Promise<void> {
    while (this.overThreshold()) await this.compactOldest();
  }

  // Force an immediate compaction pass (returns null if nothing to compact).
  async compactNow(): Promise<LcmSummaryId | null> {
    await this.idle();
    const chunk = this.pending.slice(0, this.config.chunkSize);
    if (chunk.length === 0) return null;
    return this.compact(chunk);
  }

  /** Resolves once the background compaction started by `ingest` has settled, either way. */
  async idle(): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  private async compactOldest(): Promise<void> {
    const chunk = this.pending.slice(0, this.config.chunkSize);
    if (chunk.length === 0) return;
    await this.compact(chunk);
  }

  private async compact(chunk: Pending[]): Promise<LcmSummaryId> {
    const messageIds = chunk.map((p) => p.messageId);
    // The summary covers exactly these messages; `summaryId` is linked to them inside the LCM.
    const summaryId = await this.config.lcm.summarizeChunk(messageIds, 'LLM-Map');
    const freed     = chunk.reduce((s, p) => s + p.entry.tokens, 0);

    this.pending.splice(0, chunk.length);
    this.totalTokens = Math.max(0, this.totalTokens - freed);
    this.config.onCompacted?.(summaryId, freed);
    return summaryId;
  }

  getTotalTokens(): number { return this.totalTokens; }
  getPendingCount(): number { return this.pending.length; }
  /** The entries not yet compacted, oldest first. */
  getPendingEntries(): TranscriptEntry[] { return this.pending.map((p) => p.entry); }
}
