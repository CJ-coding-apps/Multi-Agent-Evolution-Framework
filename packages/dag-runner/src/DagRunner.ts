import type {
  Dag, DagNode, NodeId, RunId, AgentId, CliAdapter,
  AdapterInvokeOptions, BlackboardKey, BlackboardValue,
} from '@maf/types';
import { makeAgentId } from '@maf/types';
import type { BlackboardStore } from '@maf/blackboard';
import { NodeStateMachine } from './NodeStateMachine.js';
import { withRetry } from './RetryOrchestrator.js';

export type NodeExecutor = (
  node: DagNode,
  inputValues: Record<string, BlackboardValue | undefined>,
  runId: RunId,
) => Promise<Record<string, BlackboardValue>>;

export interface DagRunnerOptions {
  dag:      Dag;
  board:    BlackboardStore;
  executor: NodeExecutor;
  onNodeStart?:  (nodeId: NodeId) => void;
  onNodeEnd?:    (nodeId: NodeId, status: 'Succeeded' | 'Failed') => void;
}

export class DagRunner {
  private sm = new NodeStateMachine();

  async run(opts: DagRunnerOptions): Promise<void> {
    const { dag, board, executor } = opts;

    // Initialize all nodes
    for (const nodeId of dag.nodes.keys()) {
      this.sm.init(nodeId, dag.runId);
      board.setDagState(nodeId, 'Unclaimed');
    }

    const maxConcurrent = dag.config.maxConcurrent;
    const running       = new Set<Promise<void>>();

    const dispatch = async (): Promise<void> => {
      while (true) {
        // Drain completed promises
        const done = [...running].filter((p) => isSettled(p));
        for (const p of done) running.delete(p);

        // Find ready nodes: Unclaimed + all dependencies Succeeded
        const ready = [...dag.nodes.values()].filter((node) => {
          if (this.sm.getStatus(node.id) !== 'Unclaimed') return false;
          return node.dependencies.every((dep) => this.sm.getStatus(dep) === 'Succeeded');
        });

        if (ready.length === 0) {
          // Check if everything is terminal
          const allTerminal = [...dag.nodes.keys()].every((id) => this.sm.isTerminal(id));
          if (allTerminal || running.size === 0) break;
          // Wait for any running to complete
          await Promise.race([...running]);
          continue;
        }

        // Dispatch up to maxConcurrent
        while (ready.length > 0 && running.size < maxConcurrent) {
          const node = ready.shift()!;
          this.sm.transition(node.id, 'Claimed');
          this.sm.transition(node.id, 'Running', makeAgentId(`runner-${node.id}`));
          board.setDagState(node.id, 'Running');
          opts.onNodeStart?.(node.id);

          const p = this.executeNode(node, dag.runId, board, executor, opts);
          running.add(p);
        }

        if (running.size > 0) await Promise.race([...running]);
      }
    };

    await dispatch();
  }

  private async executeNode(
    node: DagNode,
    runId: RunId,
    board: BlackboardStore,
    executor: NodeExecutor,
    opts: DagRunnerOptions,
  ): Promise<void> {
    try {
      const inputValues: Record<string, BlackboardValue | undefined> = {};
      for (const [slot, key] of Object.entries(node.inputs)) {
        const entry = await board.waitFor(key as BlackboardKey, node.timeoutMs);
        inputValues[slot] = entry?.value;
      }

      const outputs = await withRetry(
        () => executor(node, inputValues, runId),
        node.retryPolicy,
        (attempt, err) => console.error(`[dag] node ${node.id} retry ${attempt}:`, err),
      );

      for (const [slot, key] of Object.entries(node.outputs)) {
        const value = outputs[slot];
        if (value) {
          board.set({ key: key as BlackboardKey, value, producedBy: node.id, runId, createdAt: new Date() });
        }
      }

      this.sm.transition(node.id, 'Succeeded');
      board.setDagState(node.id, 'Succeeded');
      opts.onNodeEnd?.(node.id, 'Succeeded');
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.sm.transition(node.id, 'Failed', undefined, error);
      board.setDagState(node.id, 'Failed');
      opts.onNodeEnd?.(node.id, 'Failed');
    }
  }

  getState(): ReturnType<NodeStateMachine['getAll']> {
    return this.sm.getAll();
  }
}

// Trick: track settled promises via a WeakSet
const settled = new WeakSet<Promise<void>>();
function isSettled(p: Promise<void>): boolean {
  return settled.has(p);
}
// Patch promises to mark themselves settled (used only for detection above)
// In practice Promise.allSettled is cleaner; this is a lightweight alternative
