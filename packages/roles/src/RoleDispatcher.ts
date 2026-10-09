import type {
  DagNode, RunId, RetryPolicy, BlackboardValue, CliAdapter, AdapterInvokeOptions,
  AdapterInvokeResult, PartialNodeOutcome, SecurityReviewResult, ApprovalGateHandle,
} from '@maf/types';
import { isTurnAdapter, makeTaskId, NodeFailure, GateRefused, ReviewRefused, TransportError, DEFAULT_RETRY_POLICY } from '@maf/types';
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
  ProcessorPipeline, createDefaultProcessorRegistry, DEFAULT_BUNDLE_REFS, redactCredentials } from '@maf/processors';
import type { ProcessorDeps } from '@maf/processors';
import { InProcessAgentLoop } from '@maf/tool-loop';
import type { InProcessLoopResult } from '@maf/tool-loop';
import type { RoleConfig } from './RoleConfig.js';
import type { RoleRegistry } from './RoleRegistry.js';
import { RoleToolRegistry } from './RoleToolRegistry.js';
import { isWriterRole, effectiveTier, requestedTier } from './isWriterRole.js';

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
  /**
   * `--allow-ungoverned`: let a writer role run on the cli tier — because its `execution` says
   * so, or because the adapter cannot run the in-process loop — instead of refusing it (D-01).
   */
  allowUngoverned?: boolean;
  /** Where the ungoverned-run banner goes; `process.stderr` when unset. */
  stderr?:        { write(text: string): unknown };
  /** Asked when the policy escalates an in-process tool call (D-02); absent, Escalate is refused. */
  approvalGate?:  ApprovalGateHandle | undefined;
}

export interface RoleNodeOutput {
  output: BlackboardValue;
}

const MAX_OUTPUT_BYTES        = 2 * 1024 * 1024;  // 2MB per node response
const MAX_STORED_OUTPUT_CHARS = 64_000;
/** Enough of a failed call's output to show its last error, without pasting a transcript into an error. */
const OUTPUT_TAIL_CHARS       = 500;

/**
 * The end of an adapter's output, credentials masked, quoted so an empty or whitespace-only tail
 * is still visible. Masked because the message lands in the signed bundle and the memory graph,
 * which the transcript scrubber never sees.
 */
function outputTail(output: string): string {
  const masked = redactCredentials(output);
  return JSON.stringify(
    masked.length > OUTPUT_TAIL_CHARS ? `…${masked.slice(-OUTPUT_TAIL_CHARS)}` : masked,
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
): NodeFailure | TransportError | undefined {
  // A transport failure is not a judgement on the work: the backend timed out, exited without
  // a word, or never started. It is the one kind of shortfall a retry can fix, so it keeps its
  // class (D-06) and carries the exit code and tail the same way a judged failure does.
  if (result.transportError) {
    return new TransportError(
      `adapter "${adapterName}" gave no answer for role "${role.role}": ` +
      `${result.transportError.message} (exit code ${result.exitCode}). ` +
      `Output tail: ${outputTail(result.output)}`,
      { cause: result.transportError },
    );
  }
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

/**
 * D-32: a role that expects to change the tree answered, exited 0 and left no diff against the
 * node's start commit. On the cli tier that is what a backend looks like when its own permission
 * settings refused the edit and it said so; read as success, `Succeeded` would mean two things.
 */
function noChangeShortfall(
  role: RoleConfig,
  adapterName: string,
  result: AdapterInvokeResult,
  startCommit: string,
): NodeFailure {
  return new NodeFailure(
    'no_change',
    `role "${role.role}" expects to change the tree, so adapter "${adapterName}" was expected to ` +
    `leave a diff against the node's start commit ${startCommit.slice(0, 12)}, but it answered ` +
    `(exit code ${result.exitCode}) and changed nothing — a backend running under its own ` +
    `permission settings may have refused the edit. Output tail: ${outputTail(result.output)}`,
    result.exitCode,
  );
}

/**
 * The security review of one attempt, run at most once whichever route reaches it first: the
 * security-gate processor at task_end, the end of a cli-tier call, or a backend that threw
 * (D-31). It keeps the diff it read, which is also D-32's evidence — one snapshot per attempt.
 */
class AttemptReview {
  private begun = false;
  private seen: string | undefined;

  constructor(private readonly review: (onDiff: (diff: string) => void) => Promise<void>) {}

  /** The diff the review read, once it has read one. */
  get diff(): string | undefined { return this.seen; }

  async run(): Promise<void> {
    if (this.begun) return;
    this.begun = true;
    await this.review((diff) => { this.seen = diff; });
  }
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

  /** The ungoverned banner goes out once per dispatcher; `maf run` builds one per run. */
  private bannerShown = false;

  /**
   * The tier this node runs on (D-01), decided before it captures anything or spends a model
   * call. A writer lands on the cli tier only by its own `execution: 'cli'` or because the
   * adapter cannot run the loop, and then only with `allowUngoverned`: otherwise it is refused
   * here, not run where no gate sees its tool calls. A reader on the cli tier can change the
   * tree through MAF no more than in-process, so its fallback stays the transcript note it was.
   */
  private resolveTier(role: RoleConfig): { tier: 'cli' | 'in-process'; note?: string; ungoverned?: string } {
    const adapter = this.config.adapter;
    const tier = effectiveTier(role, adapter);
    if (tier === 'in-process') return { tier };
    const asked = requestedTier(role);
    if (!isWriterRole(role)) {
      if (asked === 'cli') return { tier };
      return {
        tier,
        note: `[warn] role "${role.role}" requested execution=in-process but adapter "${adapter.name}" lacks the capability; falling back to CLI dispatch`,
      };
    }
    const why = asked === 'cli'
      ? `its execution is set to 'cli'`
      : `adapter "${adapter.name}" cannot run the in-process loop`;
    if (this.config.allowUngoverned !== true) {
      throw new Error(
        `role "${role.role}" holds a write tool, so it was expected to run on the governed ` +
        `in-process tier, but ${why}. Policy verdicts, secret redaction, attested tool calls and ` +
        `processor hooks exist only in-process (D-01), so MAF refuses to start it; pass ` +
        `--allow-ungoverned to run it on the cli tier anyway.`,
      );
    }
    return { tier, ungoverned: why };
  }

  private ungovernedBanner(role: RoleConfig, why: string): void {
    if (this.bannerShown) return;
    this.bannerShown = true;
    (this.config.stderr ?? process.stderr).write(
      `[maf] UNGOVERNED: --allow-ungoverned lets writer role "${role.role}" run on the cli tier ` +
      `(${why}). There MAF applies no policy verdicts, secret redaction, attested tool calls or ` +
      `processor hooks, and reviews only the diff the node leaves. A CLI backend (claude, codex, ` +
      `gemini) edits the tree with its own tools under its own permission settings` +
      `${this.config.adapter.name === 'codex' ? ' — codex is invoked with --full-auto, its sandboxed automatic mode, so it runs its own commands and edits without asking' : ''}; an HTTP ` +
      `backend (ollama, openrouter) has no file tools and cannot change the tree at all, so a role ` +
      `that expects a change fails with no_change there. Shown once per run; the transcript ` +
      `records each ungoverned node.\n`,
    );
  }

  async runNode(node: DagNode): Promise<Record<string, BlackboardValue>> {
    const role = this.config.roles.getRole(node.agentRole);
    const taskId = makeTaskId(node.id);
    const resolved = this.resolveTier(role);

    // Captured BEFORE the node does anything, and before any model call is spent. A
    // writer that commits its own work would otherwise diff clean against HEAD, so the
    // security gate would be handed an empty diff and call the change reviewed. Which
    // roles are writers is decided by the tools they hold, not their name (D-07), and
    // the baseline is captured once per node so a retry reviews against the same commit (D-06).
    const startCommit = isWriterRole(role) ? await this.baselineFor(node.id) : undefined;
    const review = startCommit === undefined
      ? undefined
      : new AttemptReview((onDiff) => this.runPostCoderGates(node, startCommit, onDiff));

    await this.config.transcript.append(
      'user',
      `[${role.role}] ${node.label}: ${JSON.stringify(node.metadata)}`,
      { agentRole: role.role, nodeId: node.id },
    );
    if (resolved.note !== undefined) {
      await this.config.transcript.append('system', resolved.note, { agentRole: role.role, nodeId: node.id });
    }
    if (resolved.ungoverned !== undefined) {
      this.ungovernedBanner(role, resolved.ungoverned);
      await this.config.transcript.append(
        'system',
        `[ungoverned] role "${role.role}" runs on the cli tier: ${resolved.ungoverned}; allowed by --allow-ungoverned`,
        { agentRole: role.role, nodeId: node.id },
      );
    }

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

    const adapter = this.config.adapter;
    let outputForMemory: string;
    // Built where the evidence is, thrown only after the transcript has the node's output and
    // the security gate has seen its diff: an agent can change the tree before it fails, and
    // a diff left behind is reviewed whatever the outcome — the in-process tier does the same
    // at task_end, where the gate runs on budget_exhausted too.
    let shortfall: NodeFailure | TransportError | undefined;
    let cliResult: AdapterInvokeResult | undefined;
    const ranInProcess = resolved.tier === 'in-process';
    try {
      if (ranInProcess) {
        const loop = await this.runInProcess(role, invokeOpts, taskId, review);
        outputForMemory = loop.finalText.slice(0, MAX_STORED_OUTPUT_CHARS);
        shortfall = loopShortfall(role, loop);
      } else {
        cliResult = await adapter.invoke(invokeOpts);
        outputForMemory = cliResult.output.slice(0, MAX_STORED_OUTPUT_CHARS);
        shortfall = cliShortfall(role, adapter.name, cliResult);
      }
    } catch (err: unknown) {
      // The loop or the adapter threw — a turn timed out, a backend never started. Tools may
      // already have changed the tree, so the diff is reviewed before the failure propagates:
      // a refusal (a verdict) outranks the transport failure, and a clean or empty diff lets
      // the original error through for the scheduler to classify. On the in-process tier the
      // dispatcher has already fired task_end, so this is a no-op unless the bundle has no
      // security-gate processor or a task_end processor ahead of it threw. Not when the error
      // already carries a verdict (GateRefused: the gate has spoken) or comes from a loop that
      // finished its task, task_end review included, and reported failure (NodeFailure).
      const alreadyJudged = err instanceof GateRefused || err instanceof NodeFailure;
      if (review && !alreadyJudged) await review.run();
      throw err;
    }

    await this.config.transcript.append('assistant', outputForMemory, { agentRole: role.role, nodeId: node.id });
    await this.config.lcmBridge.flush();

    // Every writer's diff is reviewed, once per attempt. In-process that normally happened at
    // task_end, through the security-gate processor; the cli tier, and an in-process bundle
    // without that processor, get it here. `review` exists exactly when the role is a writer.
    if (review) await review.run();

    // D-32, judged after the gate so that a refusal still wins, and only where nothing else
    // already failed the node: a cli-tier answer from a role that expects a change, whose diff
    // against the start commit — the one the gate just read — is empty. In-process, every tool
    // call is on the record, and D-04's budget rules judge the loop.
    if (shortfall === undefined && cliResult !== undefined && role.expectsChange === true &&
        startCommit !== undefined && review?.diff?.trim() === '') {
      shortfall = noChangeShortfall(role, adapter.name, cliResult, startCommit);
    }

    if (shortfall) {
      // A transport failure is thrown as itself so the scheduler can retry it (D-06). Of the
      // judged failures, only running out of the node's own budget can be accepted, and only
      // by a node that asked for it; an adapter that failed or a writer that said nothing has
      // no partial work to keep.
      if (shortfall instanceof TransportError) throw shortfall;
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
    role: ReturnType<RoleRegistry['getRole']>,
    invokeOpts: AdapterInvokeOptions,
    taskId: ReturnType<typeof makeTaskId>,
    review: AttemptReview | undefined,
  ): Promise<InProcessLoopResult> {
    const adapter = this.config.adapter;
    if (!isTurnAdapter(adapter)) throw new Error('unreachable: gated by caller');

    const harness = this.config.harness;
    const harnessSha = harness?.sha ?? '0'.repeat(64);
    const refs = harness && harness.processorBundles.length > 0
      ? harness.processorBundles
      : [...DEFAULT_BUNDLE_REFS];
    const deps: ProcessorDeps = {
      transcript: this.config.transcript,
      // Every writer gets a runner and no reader does: `review` exists exactly for writers.
      ...(review !== undefined ? { securityRunner: () => review.run() } : {}),
    };
    const pipeline = ProcessorPipeline.build(refs, createDefaultProcessorRegistry(), deps);
    // Whether the loop reached task_end, recorded as the event goes in: a task_end processor
    // that throws (the transcript sorts before the gate) has still been handed the end of the task.
    let taskEndEmitted = false;
    const runHook = pipeline.run.bind(pipeline);
    pipeline.run = (event) => {
      if (event.hook === 'task_end') taskEndEmitted = true;
      return runHook(event);
    };

    const toolList = new RoleToolRegistry(this.config.baseTools, role.allowedTools).getAll();
    const loop = new InProcessAgentLoop(
      {
        role:         role.role,
        harnessSha,
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
        approvalGate: this.config.approvalGate,
        runId:     this.config.runId,
        taskId,
        pipeline,
      },
    );

    let result: InProcessLoopResult;
    try {
      result = await loop.run();
    } catch (err: unknown) {
      // A tool or the backend threw mid-loop, so the loop never reached task_end, where the
      // processors observe the end of the task: the transcript records it, the security gate
      // reviews what the agent left. Fired here instead; a refusal it reaches outranks the
      // original error (D-31). Not when the throw came from task_end itself — a GateRefused, or
      // any processor there failing — since every processor before it already saw the end once.
      // (The loop's step count went with its stack, hence totalSteps 0.)
      if (!taskEndEmitted) {
        await pipeline.run({
          hook: 'task_end', runId: this.config.runId, taskId, role: role.role, harnessSha,
          finalText: '', totalSteps: 0, outcome: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
    // A harness bundle may leave the security-gate processor out; the writer is reviewed anyway.
    await review?.run();
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

  private async runPostCoderGates(
    node: DagNode,
    startCommit: string,
    onDiff: (diff: string) => void,
  ): Promise<void> {
    // The CLI run path does not currently create per-task worktrees, so we read the diff
    // from `git` instead of WorktreeManager.harvest. `snapshotDiff` stages the whole
    // working tree into a throwaway index, so a file the coder created without staging it
    // is reviewed like any other change — see packages/git-ops/src/SnapshotDiff.ts.
    // A failure here is an error, never an empty diff: "we could not look" and "nothing
    // changed" must not be the same verdict.
    const diff = await snapshotDiff(this.config.cwd, startCommit);
    // Handed back before anything else: an empty diff is also D-32's evidence (no_change).
    onDiff(diff);
    if (!diff.trim()) return;
    this.config.attestor.recordDiffHash?.(`${node.id}.diff`, diff); // a subject of the run's statement (D-13)

    const securityGate = this.config.securityGate;
    if (!securityGate) return this.runReviewGate(node, startCommit, diff);

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
    // After the security verdict, never instead of it: a refused change has thrown above, so
    // nobody is asked to approve what the gate would not pass.
    await this.runReviewGate(node, startCommit, diff);
  }

  /**
   * The human review of a writer's change, alongside the security gate. Required: the node waits
   * for the decision, and anything but an approval fails it with ReviewRefused, a verdict (D-06).
   * Advisory, the default: the node goes on whatever the decision. Either way the request and
   * its outcome are in the attestation before anything is thrown.
   */
  private async runReviewGate(node: DagNode, startCommit: string, diff: string): Promise<void> {
    const gate = this.config.reviewGate;
    // The harness is the configuration the bundle names for this run, so a harness that requires
    // review does not run with an advisory gate or with none: the bundle would attest a
    // requirement nobody enforced.
    const harness = this.config.harness;
    if (harness?.reviewGate?.required === true && gate?.required !== true) {
      throw new ReviewRefused(
        `Harness "${harness.id}" requires a human review of every writer's change, but ` +
        `${gate ? 'the review gate wired for this run is advisory (required: false)' : 'no review gate is wired for this run'}, ` +
        `so the change from node ${node.id} cannot be approved and is refused. Pass a ReviewGate ` +
        `constructed with required: true as RoleDispatcherConfig.reviewGate.`,
      );
    }
    if (!gate) return;
    const outcome = await gate.review({
      runId: this.config.runId, nodeId: node.id, role: node.agentRole, baseCommit: startCommit, diff,
    });
    this.config.attestor.addApproval(outcome.attestation);
    if (outcome.refusal) throw outcome.refusal;
  }
}

// Re-exported for callers that build DAG nodes inline without the planner; the value itself
// is the one default in @maf/types (D-06).
export const DEFAULT_NODE_RETRY: RetryPolicy = DEFAULT_RETRY_POLICY;
