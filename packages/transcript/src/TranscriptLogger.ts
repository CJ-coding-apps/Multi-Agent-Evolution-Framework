import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { TranscriptEntry, RunId, AgentId, LcmSummaryId } from '@maf/types';
import type { LcmEngine } from '@maf/lcm';
import { CompressionAgent } from './CompressionAgent.js';

// Rough estimate: 4 chars ≈ 1 token
function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

export interface TranscriptLoggerConfig {
  logDir:           string;
  softThreshold:    number;   // tokens before background compaction fires, default 20_000
  chunkSize:        number;   // messages per compaction chunk, default 20
  lcm:              LcmEngine;
  /**
   * A background compaction that failed. Compaction cannot throw at `append`, so this replaces the
   * `.catch(() => undefined)` the previous logger used — which hid a FOREIGN KEY failure and left
   * compaction never running, while the transcript still dropped entries (D-17).
   */
  onCompactionError?: (err: unknown) => void;
}

export class TranscriptLogger {
  private readonly agent: CompressionAgent;
  private readonly logPath: string;

  constructor(
    private readonly runId: RunId,
    private readonly agentId: AgentId,
    private readonly config: TranscriptLoggerConfig,
  ) {
    this.logPath = path.join(config.logDir, `${runId}.jsonl`);
    this.agent = new CompressionAgent({
      lcm:           config.lcm,
      chunkSize:     config.chunkSize,
      softThreshold: config.softThreshold,
      onError:       config.onCompactionError ?? defaultCompactionErrorReporter,
    });
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

    // Append to JSONL log
    await appendFile(this.logPath, JSON.stringify(entry) + '\n', 'utf8');

    // Add to the LCM store and keep the id *it* assigned. Compaction summarizes rows in the LCM,
    // and the transcript entry's own id is not one of them: the version this replaces passed
    // `chunk.map(e => e.id) as never[]`, so compaction failed the foreign key and the entries were
    // spliced away anyway (D-17).
    const messageId = await this.config.lcm.addMessage({
      sessionId: this.runId,
      runId:     this.runId,
      role,
      content,
      tokens,
    });

    this.agent.ingest(entry, messageId);
  }

  /**
   * Compact now rather than waiting for the soft threshold, and report the summary. A run can
   * flush before it ends; a caller that is not sure a background pass ran can await this.
   */
  async compactNow(): Promise<LcmSummaryId | null> { return this.agent.compactNow(); }

  getTotalTokens(): number { return this.agent.getTotalTokens(); }
  /** The entries not yet compacted, oldest first. */
  getEntries(): TranscriptEntry[] { return this.agent.getPendingEntries(); }
}

function defaultCompactionErrorReporter(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[maf] warning: transcript compaction failed and context was kept: ${message}`);
}
