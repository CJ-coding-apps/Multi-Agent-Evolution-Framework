import type {
  Dag, DagNode, NodeId, RunId, AgentId, CliAdapter,
  AdapterInvokeOptions, BlackboardKey, BlackboardValue, RunOutcome, RunStatus,
  FailureRecorder, NodeFailureRecord,
} from '@maf/types';
import { makeAgentId, NodeFailure } from '@maf/types';
import type { BlackboardStore } from '@maf/blackboard';
import { NodeStateMachine } from './NodeStateMachine.js';
import { withRetry } from './RetryOrchestrator.js';
import { validateDag } from './validateDag.js';

export type NodeExecutor = (
  node: DagNode,
  inputValues: Record<string, BlackboardValue | undefined>,
  runId: RunId,
) => Promise<Record<string, BlackboardValue>>;

export interface DagRunnerOptions {
  dag:      Dag;
  board:    BlackboardStore;
  executor: NodeExecutor;
  /**
   * Which nodes write to the shared working tree. Writers are serialized: at most
   * one runs at a time. Defaults to *every* node, because a CLI-tier agent has its
   * own file tools whatever its allowlist says.
   */
  isWriter?:     (node: DagNode) => boolean;
  onNodeStart?:  (nodeId: NodeId) => void;
  onNodeEnd?:    (nodeId: NodeId, status: 'Succeeded' | 'Failed') => void;
  /**
   * Told about each node judged failed, once its retries are spent, so the planner can recall it
   * (D-16). A seam rather than the graph, so the scheduler stays free of the graph backend.
   */
  failureRecorder?: FailureRecorder;
  /** How long a failure is given to be recorded before the run moves on without it. Default 10 s. */
  failureRecordTimeoutMs?: number;
}

const FAILURE_RECORD_TIMEOUT_MS = 10_000;

export class DagRunner {
  private sm = new NodeStateMachine();

  async run(opts: DagRunnerOptions): Promise<RunOutcome> {
    const { dag, board, executor } = opts;
    validateDag(dag);

    // Initialize all nodes
    for (const nodeId of dag.nodes.keys()) {
      this.sm.init(nodeId, dag.runId);
      board.setDagState(nodeId, 'Unclaimed');
    }

    const maxConcurrent = dag.config.maxConcurrent;

    // The waiting set. Each promise evicts itself the instant it settles, so a
    // finished promise can never be a member to spin on: racing this map only
    // ever resolves on work that is genuinely still in flight.
    const running = new Map<NodeId, Promise<void>>();

    // Writer serialization. Two coder nodes with no dependency path between them are
    // a normal plan, so the scheduler serializes them rather than refusing the plan —
    // global serialization is exactly equivalent to pairwise serialization over nodes
    // with no dependency path, and it is the form that stays correct as the plan grows.
    const isWriter = opts.isWriter ?? (() => true);
    const runningWriters = new Set<NodeId>();
    const deferredWriters = new Set<NodeId>();

    const dispatch = async (): Promise<void> => {
      while (true) {
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
          await Promise.race([...running.values()]);
          continue;
        }

        // Dispatch up to maxConcurrent. A writer may not start while another writer
        // is running, so scan past a blocked writer instead of stopping at it.
        while (ready.length > 0 && running.size < maxConcurrent) {
          const index = ready.findIndex((node) => !isWriter(node) || runningWriters.size === 0);
          if (index === -1) {
            for (const node of ready) deferredWriters.add(node.id);
            break;
          }

          const node = ready.splice(index, 1)[0]!;
          this.sm.transition(node.id, 'Claimed');
          this.sm.transition(node.id, 'Running', makeAgentId(`runner-${node.id}`));
          board.setDagState(node.id, 'Running');
          opts.onNodeStart?.(node.id);
          if (isWriter(node)) runningWriters.add(node.id);

          const promise = this.executeNode(node, dag.runId, board, executor, opts);
          running.set(node.id, promise);
          // Self-evict on settle. Both arms are handled so a rejection can neither
          // leak an entry nor surface as an unhandled rejection.
          const release = (): void => {
            running.delete(node.id);
            runningWriters.delete(node.id);
          };
          void promise.then(release, release);
        }

        if (running.size > 0) await Promise.race([...running.values()]);
      }
    };

    await dispatch();
    return this.outcome(dag, deferredWriters);
  }

  // The verdict the caller (and the signed bundle) needs: "ran nothing", "half
  // unreachable" and "a node failed" were all indistinguishable from success when
  // this method returned void.
  private outcome(dag: Dag, deferredWriters: ReadonlySet<NodeId>): RunOutcome {
    const nodes = this.sm.getAll();
    const unscheduled = [...dag.nodes.keys()].filter((id) => {
      const status = this.sm.getStatus(id);
      return status !== 'Succeeded' && status !== 'Failed' && status !== 'Skipped';
    });

    let status: RunStatus = 'Succeeded';
    if (nodes.some((n) => n.status === 'Failed')) status = 'Failed';
    else if (unscheduled.length > 0) status = 'Unschedulable';

    return { status, nodes, unscheduled, deferredWriters: [...deferredWriters] };
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
      await recordFailure(
        opts.failureRecorder, opts.failureRecordTimeoutMs ?? FAILURE_RECORD_TIMEOUT_MS, node, runId, err, error,
      );
      opts.onNodeEnd?.(node.id, 'Failed');
    }
  }

  getState(): ReturnType<NodeStateMachine['getAll']> {
    return this.sm.getAll();
  }
}

/**
 * Hands a final failure to the recorder. Here, after `withRetry`, the verdict is settled, so an
 * attempt that a retry recovers is never written down. The recorder is memory, not judgment: if
 * it fails, or does not answer within `timeoutMs`, the node is still Failed for its own reason and
 * the run goes on. The wait is bounded because the dispatch loop races this node's promise: a
 * recorder that never settles would otherwise stall the whole run, not only this node.
 */
async function recordFailure(
  recorder: FailureRecorder | undefined,
  timeoutMs: number,
  node: DagNode,
  runId: RunId,
  err: unknown,
  message: string,
): Promise<void> {
  if (!recorder) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), timeoutMs);
    timer.unref();
  });
  try {
    const recorded = recorder.recordFailure(failureRecord(node, runId, err, message));
    if (await Promise.race([recorded, timedOut]) === 'timed-out') {
      console.error(`[dag] node ${node.id} failed, and recording that failure did not finish within ${timeoutMs} ms; the run goes on without it.`);
    }
  } catch (recordErr: unknown) {
    console.error(`[dag] node ${node.id} failed, and recording that failure failed too:`, recordErr);
  } finally {
    clearTimeout(timer);
  }
}

function failureRecord(node: DagNode, runId: RunId, err: unknown, message: string): NodeFailureRecord {
  const description = node.metadata['taskDescription'];
  const runTitle = node.metadata['runTitle'];
  return {
    runId,
    nodeId:  node.id,
    label:   node.label,
    task:    typeof description === 'string' && description.trim() !== '' ? description : node.label,
    ...(typeof runTitle === 'string' && runTitle.trim() !== '' ? { runTitle } : {}),
    role:    node.agentRole,
    reason:  failureReason(err),
    message,
    ...(err instanceof NodeFailure && err.exitCode !== undefined ? { exitCode: err.exitCode } : {}),
  };
}

/**
 * `NodeFailure.reason` when there is one; otherwise the error's class, which is what a planner can
 * learn from. A plain `Error` (or an anonymous subclass) says nothing by its class, so its `name`,
 * which code sets to tell such errors apart, is used instead.
 */
function failureReason(err: unknown): string {
  if (err instanceof NodeFailure) return err.reason;
  if (err instanceof Error) {
    const cls = err.constructor.name;
    return cls !== '' && cls !== 'Error' ? cls : (err.name || 'Error');
  }
  return 'non_error';
}
