import type { NodeId, DagNodeStatus, BlackboardSnapshot, RunId } from '@maf/types';
import type { BlackboardStore } from '@maf/blackboard';
import type { LcmEngine } from '@maf/lcm';

// Flushes the full blackboard snapshot to LCM as a single 'tool' message
// each time a DAG node transitions to a terminal state.
export class FlushOnSnapshot {
  constructor(
    private readonly board:     BlackboardStore,
    private readonly lcm:       LcmEngine,
    private readonly sessionId: string,
    private readonly runId:     RunId,
  ) {
    board.on('dag:state', ({ nodeId, status }: { nodeId: NodeId; status: DagNodeStatus }) => {
      if (status === 'Succeeded' || status === 'Failed') {
        this.flushSnapshot(nodeId, status).catch(() => undefined);
      }
    });
  }

  private async flushSnapshot(nodeId: NodeId, status: DagNodeStatus): Promise<void> {
    const snapshot  = this.board.snapshot(this.runId);
    const content   = serializeSnapshot(snapshot, nodeId, status);
    const tokens    = Math.ceil(content.length / 4);
    await this.lcm.addMessage({ sessionId: this.sessionId, runId: this.runId, role: 'tool', content, tokens });
  }
}

function serializeSnapshot(snap: BlackboardSnapshot, nodeId: NodeId, status: DagNodeStatus): string {
  const entries = snap.entries.map((e) => {
    const val = e.value.kind === 'string' ? e.value.value
              : e.value.kind === 'json'   ? JSON.stringify(e.value.value)
              : `[${e.value.kind}]`;
    return `  ${e.key}: ${val.slice(0, 200)}`;
  }).join('\n');
  return `[snapshot] node ${nodeId} → ${status}\n${entries}`;
}
