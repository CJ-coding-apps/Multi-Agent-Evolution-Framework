import { EventEmitter } from 'node:events';
import type {
  BlackboardKey, BlackboardEntry, BlackboardSnapshot, BlackboardValue, NodeId, RunId, DagNodeStatus,
} from '@maf/types';

export class BlackboardConflictError extends Error {
  constructor(key: BlackboardKey) { super(`Blackboard key already set: ${key}`); }
}

export class BlackboardTimeoutError extends Error {
  constructor(key: BlackboardKey, ms: number) { super(`Timed out waiting for blackboard key: ${key} (${ms}ms)`); }
}

export class BlackboardStore extends EventEmitter {
  private entries = new Map<BlackboardKey, BlackboardEntry>();
  private dagState = new Map<NodeId, DagNodeStatus>();

  set(entry: BlackboardEntry, force = false): void {
    if (!force && this.entries.has(entry.key)) {
      throw new BlackboardConflictError(entry.key);
    }
    this.entries.set(entry.key, entry);
    this.emit(`entry:${entry.key}`, entry);
    this.emit('entry:created', entry);
  }

  get(key: BlackboardKey): BlackboardEntry | undefined {
    return this.entries.get(key);
  }

  getValue(key: BlackboardKey): BlackboardValue | undefined {
    return this.entries.get(key)?.value;
  }

  // Blocking read — unblocks when the key is produced or times out
  waitFor(key: BlackboardKey, timeoutMs: number): Promise<BlackboardEntry> {
    const existing = this.entries.get(key);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener(`entry:${key}`, onEntry);
        reject(new BlackboardTimeoutError(key, timeoutMs));
      }, timeoutMs);

      const onEntry = (entry: BlackboardEntry) => {
        clearTimeout(timer);
        resolve(entry);
      };
      this.once(`entry:${key}`, onEntry);
    });
  }

  setDagState(nodeId: NodeId, status: DagNodeStatus): void {
    this.dagState.set(nodeId, status);
    this.emit('dag:state', { nodeId, status });
  }

  getDagState(nodeId: NodeId): DagNodeStatus | undefined {
    return this.dagState.get(nodeId);
  }

  snapshot(runId: RunId): BlackboardSnapshot {
    return {
      runId,
      timestamp: new Date(),
      entries: [...this.entries.values()],
      dagState: new Map(this.dagState),
    };
  }

  restore(snapshot: BlackboardSnapshot): void {
    this.entries.clear();
    this.dagState.clear();
    for (const entry of snapshot.entries) this.entries.set(entry.key, entry);
    for (const [k, v] of snapshot.dagState) this.dagState.set(k, v);
  }

  keys(): BlackboardKey[] {
    return [...this.entries.keys()];
  }

  size(): number {
    return this.entries.size;
  }
}
