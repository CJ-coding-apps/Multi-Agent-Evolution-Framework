import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { TranscriptEntry, RunId, AgentId, LcmSummaryId } from '@maf/types';
import type { LcmEngine } from '@maf/lcm';

// Rough estimate: 4 chars ≈ 1 token
function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

export interface TranscriptLoggerConfig {
  logDir:           string;
  softThreshold:    number;   // tokens before background compaction fires, default 20_000
  chunkSize:        number;   // messages per compaction chunk, default 20
  lcm:              LcmEngine;
}

export class TranscriptLogger {
  private entries:     TranscriptEntry[] = [];
  private totalTokens  = 0;
  private compacting   = false;
  private logPath:     string;

  constructor(
    private readonly runId: RunId,
    private readonly agentId: AgentId,
    private readonly config: TranscriptLoggerConfig,
  ) {
    this.logPath = path.join(config.logDir, `${runId}.jsonl`);
  }

  async init(): Promise<void> {
    await mkdir(this.config.logDir, { recursive: true });
  }

  async append(role: TranscriptEntry['role'], content: string, metadata: Record<string, unknown> = {}): Promise<void> {
    const tokens = estimateTokens(content);
    const entry: TranscriptEntry = {
      id:        crypto.randomUUID(),
      runId:     this.runId,
      agentId:   this.agentId,
      role,
      content,
      tokens,
      timestamp: new Date(),
      metadata,
    };

    this.entries.push(entry);
    this.totalTokens += tokens;

    // Append to JSONL log
    await appendFile(this.logPath, JSON.stringify(entry) + '\n', 'utf8');

    // Add to LCM store
    await this.config.lcm.addMessage({
      sessionId: this.runId,
      runId:     this.runId,
      role,
      content,
      tokens,
    });

    // Trigger background compaction if over soft threshold
    if (this.totalTokens > this.config.softThreshold && !this.compacting) {
      this.compactOldest().catch(() => undefined);
    }
  }

  private async compactOldest(): Promise<LcmSummaryId | undefined> {
    this.compacting = true;
    try {
      const chunk = this.entries.slice(0, this.config.chunkSize);
      if (chunk.length === 0) return undefined;
      const messageIds = chunk.map((e) => e.id) as never[];
      // summarizeChunk expects LcmMessageId[] but we stored them in LCM with same IDs
      const summaryId = await this.config.lcm.summarizeChunk(messageIds, 'LLM-Map');
      const compactedTokens = chunk.reduce((s, e) => s + e.tokens, 0);
      this.entries.splice(0, this.config.chunkSize);
      this.totalTokens -= compactedTokens;
      return summaryId;
    } finally {
      this.compacting = false;
    }
  }

  getTotalTokens(): number { return this.totalTokens; }
  getEntries(): TranscriptEntry[] { return [...this.entries]; }
}
