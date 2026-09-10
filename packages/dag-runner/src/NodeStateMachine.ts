import type { DagNodeStatus, NodeId, RunId, AgentId } from '@maf/types';

// Valid transitions (Symphony-style state machine)
const TRANSITIONS: Record<DagNodeStatus, DagNodeStatus[]> = {
  Unclaimed:  ['Claimed', 'Skipped'],
  Claimed:    ['Running', 'Unclaimed'],  // Unclaimed = release on claim failure
  Running:    ['Succeeded', 'Failed'],
  Succeeded:  [],
  Failed:     ['Unclaimed'],             // Retry: re-queue as Unclaimed
  Skipped:    [],
};

export interface NodeExecutionState {
  nodeId:      NodeId;
  runId:       RunId;
  status:      DagNodeStatus;
  attempt:     number;
  agentId?:    AgentId;
  claimedAt?:  Date;
  startedAt?:  Date;
  finishedAt?: Date;
  error?:      string;
}

export class NodeStateMachine {
  private states = new Map<NodeId, NodeExecutionState>();

  init(nodeId: NodeId, runId: RunId): void {
    this.states.set(nodeId, { nodeId, runId, status: 'Unclaimed', attempt: 0 });
  }

  transition(nodeId: NodeId, to: DagNodeStatus, agentId?: AgentId, error?: string): void {
    const state = this.states.get(nodeId);
    if (!state) throw new Error(`Unknown node: ${nodeId}`);

    const allowed = TRANSITIONS[state.status];
    if (!allowed.includes(to)) {
      throw new Error(`Invalid transition ${state.status} → ${to} for node ${nodeId}`);
    }

    const now = new Date();
    state.status = to;
    if (agentId) state.agentId = agentId;
    if (error)   state.error = error;

    if (to === 'Claimed')   state.claimedAt = now;
    if (to === 'Running')   state.startedAt = now;
    if (to === 'Succeeded' || to === 'Failed') state.finishedAt = now;
    if (to === 'Unclaimed') state.attempt++; // re-queue = retry
  }

  get(nodeId: NodeId): NodeExecutionState | undefined {
    return this.states.get(nodeId);
  }

  getStatus(nodeId: NodeId): DagNodeStatus {
    return this.states.get(nodeId)?.status ?? 'Unclaimed';
  }

  getAll(): NodeExecutionState[] {
    return [...this.states.values()];
  }

  isTerminal(nodeId: NodeId): boolean {
    const status = this.getStatus(nodeId);
    return status === 'Succeeded' || status === 'Failed' || status === 'Skipped';
  }
}
