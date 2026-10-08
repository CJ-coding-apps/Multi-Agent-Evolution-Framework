import type {
  DagNode, RunId, RetryPolicy, BlackboardValue, CliAdapter, AdapterInvokeOptions,
  AdapterInvokeResult, PartialNodeOutcome, SecurityReviewResult,
} from '@maf/types';
import { isTurnAdapter, makeTaskId, NodeFailure, GateRefused } from '@maf/types';
import type { ToolRegistry } from '@maf/tools';
import type { PolicyEngine } from '@maf/policy-engine';
import type { GraphAwareInjector } from '@maf/prompt-injector';
import type { Attestor } from '@maf/attestation';
import type { MemoryGraph } from '@maf/memory-graph';
import type { TranscriptLogger } from '@maf/transcript';
import type { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import type { ReviewGate, SecurityReviewGate } from '@maf/git-ops';
import { snapshotDiff, runIsolatedGit, GIT_EMPTY_TREE } from '@maf/git-ops';
import type { HarnessConfig } from '@maf/harness-config';
import {
  ProcessorPipeline, createDefaultProcessorRegistry, DEFAULT_BUNDLE_REFS,
} from '@maf/processors';
import type { ProcessorDeps } from '@maf/processors';
import { InProcessAgentLoop } from '@maf/tool-loop';
import type { InProcessLoopResult } from '@maf/tool-loop';
import type { RoleConfig } from './RoleConfig.js';
import type { RoleRegistry } from './RoleRegistry.js';
import { RoleToolRegistry } from './RoleToolRegistry.js';
import { isWriterRole } from './isWriterRole.js';

export interface RoleDispatcherConfig {
  adapter:        CliAdapter;
  baseTools:      ToolRegistry;
  roles:          RoleRegistry;
  injector:       GraphAwareInjector;
  policy:         PolicyEngine;
  attestor:       Attestor;
  graph:          MemoryGraph;
  transcript:     TranscriptLogger;
  lcmBridge:      BlackboardToLcmAdapter;
  reviewGate?:    ReviewGate;
  securityGate?:  SecurityReviewGate;
  cwd:            string;
  sessionId:      string;
  runId:          RunId;
  modelOverride?: string;
  /** Pinned sampling temperature (e.g. 0 for golden determinism); forwarded to the adapter. */
  temperature?:   number;
  /** Phase 1: the resolved harness for this run (processor bundles live here). */
  harness?:       HarnessConfig;
}

export interface RoleNodeOutput {
  output: BlackboardValue;
}

const MAX_OUTPUT_BYTES        = 2 * 1024 * 1024;  // 2MB per node response
const MAX_STORED_OUTPUT_CHARS = 64_000;
/** Enough of a failed call's output to show its last error, without pasting a transcript into an error. */
const OUTPUT_TAIL_CHARS       = 500;

/** The end of an adapter's output, quoted so an empty or whitespace-only tail is still visible. */
function outputTail(output: string): string {
  return JSON.stringify(
    output.length > OUTPUT_TAIL_CHARS ? `…${output.slice(-OUTPUT_TAIL_CHARS)}` : output,
  );
}

/**
 * Whether a CLI-tier result counts as the role having done its work (D-04). Until this, the
 * result's `success` and `exitCode` were never read, so a timeout (exit 124), an expired login or
 * an HTTP error body was stored as the node's output and the node was recorded as succeeded.
 *
 * Empty output is held against writers only. A writer that says nothing is what a CLI that died
 * or was cut off looks like, and accepting it records a coder that did nothing as one that
 * succeeded; a read-only role with nothing to report has changed nothing by saying so.
 */
function cliShortfall(
  role: RoleConfig,
  adapterName: string,
  result: AdapterInvokeResult,
): NodeFailure | undefined {
  if (!result.success) {
    return new NodeFailure(
      'adapter_failed',
      `adapter "${adapterName}" was expected to succeed for role "${role.role}", but it reported ` +
      `failure (exit code ${result.exitCode}). Output tail: ${outputTail(result.output)}`,
      result.exitCode,
    );
  }
  if (isWriterRole(role) && result.output.trim() === '') {
    return new NodeFailure(
      'empty_output',
      `role "${role.role}" holds a write tool, so adapter "${adapterName}" was expected to report ` +
      `what it did, but it returned no output (exit code ${result.exitCode}). ` +
      `Output tail: ${outputTail(result.output)}`,
      result.exitCode,
    );
  }
  return undefined;
}

/** The in-process counterpart: a loop that ran out of its own budget did not finish (D-04). */
function loopShortfall(role: RoleConfig, loop: InProcessLoopResult): NodeFailure | undefined {
  if (loop.outcome !== 'budget_exhausted') return undefined;
  // The loop names the cause only for maxTurns; a token budget or a processor stopping the
  // loop at step_start leaves `error` unset.
  const cause = loop.error ?? 'the token budget ran out or a processor stopped the loop';
  return new NodeFailure(
    'budget_exhausted',
    `in-process role "${role.role}" was expected to finish, but its loop stopped with ` +
    `budget_exhausted (${cause}). Set allowPartial: true on the node to accept partial work.`,
  );
}

function gitSaid(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The gate cannot read a diff without a repository, and skipping it would attest an
 * unreviewed coder diff as reviewed. The message has to say what to do about it, because
 * the fix is one command the user can run.
 */
function notARepository(cwd: string, err: unknown): Error {
  return new Error(
    `cannot review the coder diff — no usable git repository at ${cwd} (git said: ${gitSaid(err)}). ` +
    `The security gate reads the working-tree diff, so it needs a repository to see what the ` +
    `coder changed; run "git init" in ${cwd} (or run maf inside an existing repository).`,
  );
}

export class RoleDispatcher {
  constructor(private readonly config: RoleDispatcherConfig) {}

  /**
   * The commit each node first started from, keyed by run and node, held until the node ends.
   * A retry re-enters `runNode`, and a coder that committed on the failed attempt would hand a
   * freshly captured baseline its own change — attempt 2 would diff clean and the gate would
   * call it reviewed (D-06). Only a successful capture is held: one that failed ended its
   * attempt before the node did anything, so the next attempt has nothing to answer for.
   */
  private readonly baselines = new Map<string, string>();

  /**
   * The node has ended, succeeded or failed, and will not be attempted again: forget its
   * baseline. Call it from the scheduler's `onNodeEnd`, which fires once per node after its
   * last attempt; a later run of the same node then starts from wherever the tree is.
   */
  endNode(nodeId: DagNode['id']): void {
    this.baselines.delete(this.baselineKey(nodeId));
  }

  private baselineKey(nodeId: DagNode['id']): string {
    return JSON.stringify([this.config.runId, nodeId]);
  }

  private async baselineFor(nodeId: DagNode['id']): Promise<string> {
    const key = this.baselineKey(nodeId);
    const held = this.baselines.get(key);
    if (held !== undefined) return held;
    const commit = await this.startCommit();
    this.baselines.set(key, commit);
    return commit;
  }

  async runNode(node: DagNode): Promise<Record<string, BlackboardValue>> {
    const role = this.config.roles.getRole(node.agentRole);
    const taskId = makeTaskId(node.id);

    // Captured BEFORE the node does anything, and before any model call is spent. A
    // writer that commits its own work would otherwise diff clean against HEAD, so the
    // security gate would be handed an empty diff and call the change reviewed. Which
    // roles are writers is decided by the tools they hold, not their name (D-07), and
    // the baseline is captured once per node so a retry reviews against the same commit (D-06).
    const startCommit = isWriterRole(role) ? await this.baselineFor(node.id) : undefined;

    await this.config.transcript.append(
      'user',
      `[${role.role}] ${node.label}: ${JSON.stringify(node.metadata)}`,
      { agentRole: role.role, nodeId: node.id },
    );

    const roleTools = new RoleToolRegistry(this.config.baseTools, role.allowedTools);
    const rolePrompt = await this.config.roles.loadPrompt(role);

    const { systemPromptPrefix } = await this.config.injector.assemble(
      node.label, this.config.sessionId, role.role,
    );
    const systemPrompt = [systemPromptPrefix, rolePrompt].filter(Boolean).join('\n');

    const nodeTask = (node.metadata as Record<string, unknown>)['taskDescription'];
    const userPrompt = typeof nodeTask === 'string' && nodeTask ? nodeTask : node.label;

    const invokeOpts: AdapterInvokeOptions = {
      prompt:         userPrompt,
      systemPrompt,
      tools:          roleTools.getAll(),
      workingDir:     this.config.cwd,
      timeoutMs:      role.timeoutMs ?? node.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    };
    const modelChoice = role.model ?? this.config.modelOverride;
    if (modelChoice) invokeOpts.model = modelChoice;
    if (role.tokenBudget) invokeOpts.tokenBudget = role.tokenBudget;
    if (this.config.temperature !== undefined) invokeOpts.temperature = this.config.temperature;

    // ── Phase 1 gate: in-process roles go through the processor pipeline loop ──
    // Requires BOTH a sendTurn implementation AND the inProcessLoop capability:
    // an adapter may ship sendTurn but keep the capability off (e.g. Codex, whose
    // autonomous mode would bypass the gate) — that adapter must stay on CLI.
    const wantsInProcess = (role.execution ?? 'cli') === 'in-process';
    const adapter = this.config.adapter;
    const canInProcess = isTurnAdapter(adapter) && adapter.capabilities().inProcessLoop;
    if (wantsInProcess && !canInProcess) {
      await this.config.transcript.append(
        'system',
        `[warn] role "${role.role}" requested execution=in-process but adapter "${adapter.name}" lacks the capability; falling back to CLI dispatch`,
        { agentRole: role.role, nodeId: node.id },
      );
    }

    let outputForMemory: string;
    // Built where the evidence is, thrown only after the transcript has the node's output and
    // the security gate has seen its diff: an agent can change the tree before it fails, and
    // a diff left behind is reviewed whatever the outcome — the in-process tier does the same
    // at task_end, where the gate runs on budget_exhausted too.
    let shortfall: NodeFailure | undefined;
    const ranInProcess = wantsInProcess && canInProcess;
    if (ranInProcess) {
      const loop = await this.runInProcess(node, role, invokeOpts, taskId, startCommit);
      outputForMemory = loop.finalText.slice(0, MAX_STORED_OUTPUT_CHARS);
      shortfall = loopShortfall(role, loop);
    } else {
      const result = await adapter.invoke(invokeOpts);
      outputForMemory = result.output.slice(0, MAX_STORED_OUTPUT_CHARS);
      shortfall = cliShortfall(role, adapter.name, result);
    }

    await this.config.transcript.append('assistant', outputForMemory, { agentRole: role.role, nodeId: node.id });
    await this.config.lcmBridge.flush();

    if (startCommit !== undefined && !ranInProcess) {
      // In-process runs reach the security gate at task_end via SecurityGateProcessor
      // (which still calls it only for a role named 'coder'); the CLI path, including the
      // adapter-capability fallback, runs it here. `startCommit !== undefined` and
      // `isWriterRole(role)` are the same condition by construction.
      await this.runPostCoderGates(node, startCommit);
    }

    if (shortfall) {
      // Only running out of the node's own budget can be accepted, and only by a node that
      // asked for it; an adapter that failed or a writer that said nothing has no partial work
      // to keep.
      if (shortfall.reason !== 'budget_exhausted' || node.allowPartial !== true) throw shortfall;
      await this.config.transcript.append(
        'system',
        `[partial] node "${node.id}" stopped early and allowPartial accepts it: ${shortfall.message}`,
        { agentRole: role.role, nodeId: node.id },
      );
      const partial: PartialNodeOutcome = {
        status: 'partial', reason: shortfall.reason, detail: shortfall.message,
      };
      return {
        output:  { kind: 'string', value: outputForMemory },
        outcome: { kind: 'json', value: partial },
      };
    }

    return { output: { kind: 'string', value: outputForMemory } };
  }

  /**
   * In-process execution: processor pipeline around every turn/tool call, policy
   * gated per call. Processor bundle = harness.processorBundles, or the default
   * bundle when the harness carries none (see DEFAULT_BUNDLE_REFS in @maf/processors).
   */
  private async runInProcess(
    node: DagNode,
    role: ReturnType<RoleRegistry['getRole']>,
    invokeOpts: AdapterInvokeOptions,
    taskId: ReturnType<typeof makeTaskId>,
    startCommit: string | undefined,
  ): Promise<InProcessLoopResult> {
    const adapter = this.config.adapter;
    if (!isTurnAdapter(adapter)) throw new Error('unreachable: gated by caller');

    const harness = this.config.harness;
    const refs = harness && harness.processorBundles.length > 0
      ? harness.processorBundles
      : [...DEFAULT_BUNDLE_REFS];
    const deps: ProcessorDeps = {
      transcript: this.config.transcript,
      // The processor invokes this only for coder events, which are exactly the events
      // that have a start commit; a node without one gets no runner at all.
      ...(startCommit !== undefined
        ? { securityRunner: () => this.runPostCoderGates(node, startCommit) }
        : {}),
    };
    const pipeline = ProcessorPipeline.build(refs, createDefaultProcessorRegistry(), deps);

    const toolList = new RoleToolRegistry(this.config.baseTools, role.allowedTools).getAll();
    const loop = new InProcessAgentLoop(
      {
        role:         role.role,
        harnessSha:   harness?.sha ?? '0'.repeat(64),
        systemPrompt: invokeOpts.systemPrompt ?? '',
        userPrompt:   invokeOpts.prompt,
        tools:        toolList,
        maxTurns:     role.maxToolIterations ?? 10,
        timeoutMs:    invokeOpts.timeoutMs,
        workingDir:   invokeOpts.workingDir,
        projectRoot:  this.config.cwd,
        sessionId:    this.config.sessionId,
        ...(invokeOpts.maxOutputBytes !== undefined ? { maxOutputBytes: invokeOpts.maxOutputBytes } : {}),
        ...(invokeOpts.tokenBudget !== undefined ? { tokenBudget: invokeOpts.tokenBudget } : {}),
        ...(invokeOpts.model !== undefined ? { model: invokeOpts.model } : {}),
      },
      {
        adapter,
        policy:    this.config.policy,
        attestor:  this.config.attestor,
        runId:     this.config.runId,
        taskId,
        pipeline,
      },
    );

    const result = await loop.run();
    if (result.outcome === 'failed') {
      throw new NodeFailure('loop_failed', `in-process role "${role.role}" failed: ${result.error ?? 'unknown'}`);
    }
    // budget_exhausted is returned, not thrown: whether it fails the node depends on the node's
    // allowPartial, which the caller decides after the transcript has the output.
    return result;
  }

  /**
   * The commit the node is about to start from. Diffing against HEAD instead would miss
   * everything an agent that commits its own work changed — the gate would be handed an
   * empty diff and would call the change reviewed, which is the same fail-open reached by
   * another route.
   *
   * A repository with no commits yet is fine: the empty tree is a valid diff base, so the
   * first `git init` + first coder change still produces a reviewable diff. Only an
   * actual absence of a repository is an error.
   */
  private async startCommit(): Promise<string> {
    try {
      const { stdout } = await runIsolatedGit(this.config.cwd, ['rev-parse', 'HEAD']);
      return stdout.trim();
    } catch (err: unknown) {
      try {
        await runIsolatedGit(this.config.cwd, ['rev-parse', '--git-dir']);
      } catch {
        throw notARepository(this.config.cwd, err);
      }
      return GIT_EMPTY_TREE;
    }
  }

  private async runPostCoderGates(node: DagNode, startCommit: string): Promise<void> {
    // The CLI run path does not currently create per-task worktrees, so we read the diff
    // from `git` instead of WorktreeManager.harvest. `snapshotDiff` stages the whole
    // working tree into a throwaway index, so a file the coder created without staging it
    // is reviewed like any other change — see packages/git-ops/src/SnapshotDiff.ts.
    // A failure here is an error, never an empty diff: "we could not look" and "nothing
    // changed" must not be the same verdict.
    const diff = await snapshotDiff(this.config.cwd, startCommit);
    if (!diff.trim()) return;

    const securityGate = this.config.securityGate;
    if (!securityGate) return;

    // A diff over the gate's size cap is refused by a throw, before any model call. It is
    // still this node's verdict, so it is attested and remembered like a blocking finding
    // before it propagates, rather than surfacing only as a crash.
    let secRes: SecurityReviewResult;
    let refusal: GateRefused | undefined;
    try {
      secRes = await securityGate.reviewDiff(diff);
    } catch (err: unknown) {
      if (!(err instanceof GateRefused)) throw err;
      refusal = err;
      secRes = { findings: err.findings, summary: err.message, passed: false };
    }
    this.config.attestor.recordSecurityFindings(node.id, secRes);

    if (!secRes.passed) {
      await this.config.graph.addNode({
        kind:       'Failure',
        label:      `security:${node.id}`,
        properties: {
          nodeId:   node.id,
          findings: JSON.stringify(secRes.findings),
          summary:  secRes.summary,
        },
        runId: this.config.runId,
      });
      // GateRefused rather than a plain Error, so the scheduler can tell a verdict from a
      // transport failure: a retried attempt diffs a tree the first may already have
      // committed, and an empty diff passes (D-06).
      if (refusal) throw refusal;
      const blockingCount = secRes.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
      throw new GateRefused(
        `Security review refused the change from node ${node.id}: ${blockingCount} blocking ` +
        `(critical or high) finding(s).${secRes.summary ? ` ${secRes.summary}` : ''}`,
        secRes.findings,
      );
    }
  }
}

// Re-exported for callers that build DAG nodes inline without the planner.
export const DEFAULT_NODE_RETRY: RetryPolicy = {
  maxAttempts: 3, backoffMs: 1000, backoffFactor: 2, jitterMs: 500,
};
