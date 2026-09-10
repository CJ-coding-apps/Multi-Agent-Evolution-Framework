import type { BlackboardEntry, RunId } from '@maf/types';
import type { BlackboardStore } from '@maf/blackboard';
import type { LcmEngine } from '@maf/lcm';

export class BlackboardToLcmAdapter {
  private flushQueue: BlackboardEntry[] = [];

  constructor(
    private readonly board:     BlackboardStore,
    private readonly lcm:       LcmEngine,
    private readonly sessionId: string,
    private readonly runId:     RunId,
  ) {
    board.on('entry:created', (entry: BlackboardEntry) => {
      this.flushQueue.push(entry);
    });
  }

  async flush(): Promise<void> {
    const batch = this.flushQueue.splice(0);
    for (const entry of batch) {
      const content = serializeEntry(entry);
      await this.lcm.addMessage({
        sessionId: this.sessionId,
        runId:     this.runId,
        role:      'tool',
        content,
        tokens:    Math.ceil(content.length / 4),
      });
    }
  }

  async flushOnInterval(intervalMs: number): Promise<() => void> {
    const timer = setInterval(() => { this.flush().catch(() => undefined); }, intervalMs);
    return () => clearInterval(timer);
  }
}

function serializeEntry(entry: BlackboardEntry): string {
  const value = entry.value.kind === 'json'
    ? JSON.stringify(entry.value.value)
    : entry.value.kind === 'string'
      ? entry.value.value
      : `[${entry.value.kind}]`;
  return `[blackboard:${entry.key}] produced by ${entry.producedBy}: ${value.slice(0, 500)}`;
}
