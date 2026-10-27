import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { makeAgentId, makeNodeId, makeTaskId } from '@maf/types';
import type { DagNode, CliAdapter, GraphQueryRunner, RunId } from '@maf/types';
import { BlackboardStore } from '@maf/blackboard';
import { LcmEngine, createAdapterSummarizer, createAdapterSubAgent } from '@maf/lcm';
import { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import { MemoryGraph } from '@maf/memory-graph';
import { Attestor } from '@maf/attestation';
import { createApprovalGate } from '@maf/approval-gate';
import { PolicyLoader } from '@maf/policy-engine';
import type { PolicyEngine } from '@maf/policy-engine';
import { SecurityReviewGate } from '@maf/git-ops';
import { GraphAwareInjector } from '@maf/prompt-injector';
import { TranscriptLogger } from '@maf/transcript';
import { createDefaultRegistry } from '@maf/tools';
import type { ToolRegistry } from '@maf/tools';
import { RoleDispatcher, RoleRegistry, harnessRoleSetFromRegistry, roleSetFromHarness } from '@maf/roles';
import { LEGACY_DEFAULT_ID, assertPromptsCarried, resolveHarnessRef, shortSha } from '@maf/harness-config';
import type { HarnessConfig, HarnessStore, ResolvedHarness } from '@maf/harness-config';
import type { TaskDispatcher } from '@maf/eval-harness';
import { importHarness, locateStoredHarness } from './commands/harness.js';
import { goldensAssetRoot, readAsset } from './assets.js';
import type { ResolvedMafConfig } from './config/ConfigLoader.js';

/**
 * Shared CLI wiring for run/goldens/evolve commands: one component stack per
 * invocation, one TaskDispatcher factory producing isolated RoleDispatchers.
 * Keep component construction here, nowhere else (single home per §5).
 */

export const SECURITY_REVIEW_FALLBACK_PROMPT = `You are a security auditor. Review the supplied diff for vulnerabilities. Respond with a strict JSON block:
{ "findings": [ { "severity": "critical|high|medium|low|info", "category": "t", "file": "f", "line": 0, "rationale": "r", "remediation": "x" } ], "summary": "s", "passed": true }`;

/**
 * What a command was told about its policy: the `--policy` value (the flag's default when it was
 * not typed) and whether the user typed it. The second half is what makes an absent flag mean the
 * shipped default and a typed path mean that file and nothing else (D-49, F4).
 */
export interface PolicyChoice {
  readonly value: string;
  readonly typed: boolean;
}

/**
 * The rules an executing command runs under, decided in one place (F7, D-49). `run`, `goldens`,
 * `evolve` and the in-process demo all call this, so they cannot disagree about what an absent
 * `--policy` means.
 *
 * - untyped flag: `.maf/policy.yaml` if it is there, else the policy shipped in the package;
 * - typed path that names no file: the run stops (F4) — a typo must not become "no rules", which is
 *   the fail-open class D-49 exists to close;
 * - typed `none`: no rules at all, recorded as `sourceKind: "none"`.
 */
export async function loadCommandPolicy(
  cwd: string,
  choice: PolicyChoice,
  graph: GraphQueryRunner,
): Promise<PolicyEngine> {
  const none = choice.typed && choice.value === 'none';
  return PolicyLoader.loadEngine(
    path.resolve(cwd, choice.value),
    graph,
    none
      ? { none: true }
      : choice.typed
        ? { explicit: true }
        : { builtInText: await readAsset('policy.yaml') },
  );
}

/**
 * The model summarization calls use (D-17): `lcm.model` when the config names one, else the model
 * the run was given, else the adapter's own. Summarization has its own setting so an operator can
 * buy a cheaper model for compaction without changing the model that does the work. Defined beside
 * the one construction that reads it (R1), not in a command file.
 */
export function summarizerModelFor(cfg: Pick<ResolvedMafConfig, 'lcm' | 'model'>): string | undefined {
  return cfg.lcm.model ?? cfg.model;
}

export interface RunLcmInput {
  mafDir:    string;
  /** Where the summarizer's backend runs: the run's working directory. */
  cwd:       string;
  adapter:   CliAdapter;
  /** The model the run was given; `lcm.model` wins for summarization alone. */
  model?:    string;
  /** The resolved `lcm` settings the command read. */
  lcm:       ResolvedMafConfig['lcm'];
  /** The session this run's archive belongs to (R9): `maf run` uses the run id. */
  sessionId: string;
  attestor:  Attestor;
}

export interface RunLcm {
  engine: LcmEngine;
  /** `lcm.expand` for this run's archive (F8). */
  expand(summaryId: string): ReturnType<LcmEngine['expandSummary']>;
  close(): void;
}

/**
 * The run's LCM wiring — one construction, used by `maf run` and by goldens/evolve (R1).
 *
 * The two commands used to each build the engine, the summarizer and the recorder. Two copies is
 * how `maf run`'s copy survived seven mutants no test touched, so this is the only place they are
 * built now: the settings that are in force are recorded once on the attestor (R4a), every summary
 * call is recorded against the node that triggered it with its charge (F1, R5), and a degraded
 * compaction is recorded and logged (F5).
 */
export function createRunLcm(input: RunLcmInput): RunLcm {
  const summarizerModel = summarizerModelFor({
    lcm: input.lcm,
    ...(input.model !== undefined ? { model: input.model } : {}),
  });
  const summarizerOptions = {
    adapter:    input.adapter,
    workingDir: input.cwd,
    timeoutMs:  input.lcm.summaryTimeoutMs,
    ...(summarizerModel !== undefined ? { model: summarizerModel } : {}),
  };
  // R4a: what this run actually ran with, recorded once, so a reader of the bundle does not have
  // to infer the mode, operator or thresholds from the source or from the config it might have had.
  input.attestor.recordLcmSettings({
    mode:             input.lcm.mode,
    operator:         input.lcm.operator === 'agentic-map' ? 'Agentic-Map' : 'LLM-Map',
    contextThreshold: input.lcm.contextThreshold,
    freshTailCount:   input.lcm.freshTailCount,
    summaryTimeoutMs: input.lcm.summaryTimeoutMs,
    ...(summarizerModel !== undefined ? { model: summarizerModel } : {}),
  });
  const engine = new LcmEngine({
    dbPath:  path.join(input.mafDir, 'lcm.db'),
    // R9: `.maf/lcm.db` outlives the run, so the engine may only expand its own session's archive.
    sessionId:       input.sessionId,
    contextThreshold: input.lcm.contextThreshold,
    freshTailCount:   input.lcm.freshTailCount,
    mode:             input.lcm.mode,
    operator:         input.lcm.operator === 'agentic-map' ? 'Agentic-Map' : 'LLM-Map',
    summarize:   createAdapterSummarizer(summarizerOptions),
    runSubAgent: createAdapterSubAgent(summarizerOptions),
    // F1/R5: a summary is a model call like any other. It goes into the same array, under the node
    // whose assembly triggered it — with no trigger (a background pass) it is attributed to the
    // session rather than made to look like a node's call. The charge is the engine's own record.
    recordSummaryCall: (call) => {
      // R6 makes the summarizer supply a surface on every backend, so this guard is for a caller
      // that supplied its own summarizer and did not: recording nothing is honest, inventing a
      // digest for text this layer never saw is not.
      if (!call.surface) return;
      input.attestor.recordModelSurface({
        role: 'lcm',
        taskId: call.trigger?.taskId ?? makeTaskId(`lcm-${call.sessionId}`),
        turn: 1,
        tier: 'cli',
        nativeTools: 'none',
        kind: 'lcm-summary',
        ...call.surface,
        ...(call.model !== undefined ? { model: call.model } : {}),
        lcmSummary: {
          summaryId: call.summaryId,
          level: call.level,
          messages: call.messageIds.length,
          chars: call.content.length,
          contentTokens: call.contentTokens,
          tokenBudgetCharged: call.tokenBudgetCharged,
          ...(call.trigger?.taskId !== undefined ? { taskId: call.trigger.taskId } : {}),
          ...(call.trigger?.nodeId !== undefined ? { nodeId: call.trigger.nodeId } : {}),
          ...(call.reportedTokens !== undefined ? { reportedTokens: call.reportedTokens } : {}),
        },
      });
    },
    // F5: continue uncompacted, and say so where an operator will see it. The transcript line is
    // written by the dispatcher from `ctx.degraded`, which is per-node; this one is the run's log,
    // for a background pass that has no node.
    onDegraded: (record) => {
      // L3c: an oversized root is not a failed compaction; say which one and what the injector does.
      console.error(record.reason === 'root-over-budget'
        ? `[lcm] archive root ${record.summaryId ?? '(unknown)'} still exceeds the injector budget ` +
          `(${record.tokens ?? '?'} tokens) after a tighter retry; rendering cues instead`
        : `[lcm] compaction failed: ${record.reason}; continuing uncompacted`);
      input.attestor.recordLcmDegraded(record);
    },
  });
  return {
    engine,
    expand: (summaryId) => engine.expandSummary(summaryId),
    close: () => engine.close(),
  };
}

export interface RunStack {
  adapter: CliAdapter;
  graph: MemoryGraph;
  attestor: Attestor;
  lcm: LcmEngine;
  securityPrompt: string;
  rolesFor(harness: HarnessConfig): RoleRegistry;
  /**
   * Reads the loaded policy's in-force record into the attestor (F6). Call it after the last tool
   * call and before `bundle`, so the counts are final. Kept on the stack because the policy is
   * built here, and a caller that reaches into two fields to pair them can pair them wrongly.
   */
  recordPolicyInForce(): void;
  dispatchTask(harness: HarnessConfig, role: string, prompt: string, workDir: string, timeoutMs: number, temperature?: number): Promise<string>;
  /** Resolves once the graph's files are released; a caller may remove `mafDir` after awaiting it. */
  close(): Promise<void>;
}

export async function buildRunStack(cfg: {
  cwd: string;
  mafDir: string;
  /** The `--policy` flag as the command received it; resolved by {@link loadCommandPolicy}. */
  policy: PolicyChoice;
  adapter: CliAdapter;
  model?: string;
  runId: RunId;
  harnessSha: string;
  /** `--allow-ungoverned`: a writer role may run on the cli tier (D-01). */
  allowUngoverned?: boolean;
  /** No one is asked anything: an escalated tool call is refused (D-02). goldens and evolve run so. */
  headless?: boolean;
  /**
   * The resolved `lcm` settings the command read (WP-3.2 F12). Passed in rather than hard-coded
   * here: the mode, threshold, tail, model and operator are operator choices, and a second copy
   * of their defaults in this file is how `maf run`'s config section became inert before.
   */
  lcm: ResolvedMafConfig['lcm'];
}): Promise<RunStack> {
  const graph = new MemoryGraph(path.join(cfg.mafDir, 'memory.kuzu'));
  // M1: a setup that fails after this point must not leak the handle. Kùzu keeps files open under
  // `mafDir`, and a caller that removes that directory on the way out — goldens' evaluation
  // directory — then fails with ENOTEMPTY, which would replace the error that caused the removal
  // (a mistyped `--policy`, in the reported case). The close below is awaited: `close()` now
  // resolves only after the database is released, so the removal that follows it cannot race the
  // native writes (WP-3.8 follow-up). Nothing here can use a half-built stack.
  let lcm: LcmEngine | undefined;
  try {
    const attestor = new Attestor(cfg.runId, graph, path.join(cfg.mafDir, 'attestations'), Attestor.resolveSigningSecret(process.env), cfg.harnessSha);
    const policy = await loadCommandPolicy(cfg.cwd, cfg.policy, graph);
    // One gate for every task of the stack, outside dispatchTask, so request ids are unique across them.
    const approvalGate = createApprovalGate({
      recorder: attestor, mafDir: cfg.mafDir,
      env: cfg.headless === true ? { ...process.env, MAF_HEADLESS: '1' } : process.env,
    });
    const board = new BlackboardStore();
    // R1: the one LCM construction, shared with `maf run`. Building it here from the same pieces
    // is what produced two copies and left `run`'s untested; the settings recorded on the attestor
    // and the attribution of each summary call are therefore the same in goldens and evolve.
    const runLcm = createRunLcm({
      mafDir: cfg.mafDir,
      cwd:    cfg.cwd,
      adapter: cfg.adapter,
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      lcm:       cfg.lcm,
      sessionId: cfg.runId,
      attestor,
    });
    const engine = runLcm.engine;
    lcm = engine;
    // F8: the Dolt cue names `lcm.expand`; the tool exists in every role registry and resolves
    // against this run's archive. One expander, shared by the allowlist registry and each task's.
    const lcmExpand = (summaryId: string) => runLcm.expand(summaryId);
    const baseTools = createDefaultRegistry({ lcmExpand });
    const injector = new GraphAwareInjector({ graph, lcm: engine, maxNodes: 40, tokenBudget: 4096 });
    const lcmBridge = new BlackboardToLcmAdapter(board, engine, cfg.runId, cfg.runId);

    const stack: RunStack = {
      adapter: cfg.adapter,
      graph,
      attestor,
      lcm: engine,
      securityPrompt: SECURITY_REVIEW_FALLBACK_PROMPT,
      rolesFor: (harness) => RoleRegistry.fromSet(roleSetFromHarness(harness.roleSet), cfg.mafDir, baseTools),
      recordPolicyInForce: () => attestor.recordPolicyInForce(policy.inForce()),
      async dispatchTask(harness, role, prompt, workDir, timeoutMs, temperature) {
        const taskId = makeTaskId(crypto.randomUUID());
        const roles = stack.rolesFor(harness);
        // `role` arrives as a corpus string, and this is the only place it can be checked against
        // the harness. A task naming a role the harness does not define is refused; it previously
        // reached the dispatcher as a bare string and came back out as the *default* role — `coder`,
        // a writer — so a corpus file and a harness that disagree produced a silently privileged run
        // instead of an error. `TaskDispatcher` keeps its `role: string` signature because that is
        // what the corpus carries; the conversion happens here, where the role set is in hand.
        const resolvedRole = roles.resolveRole(role);
        if (!resolvedRole.ok) {
          throw new Error(
            `goldens: task asks for unknown role "${role}". ` +
            `Known roles: ${resolvedRole.error.known.join(', ')}.`,
          );
        }
        const transcript = new TranscriptLogger(cfg.runId, makeAgentId(taskId), {
          logDir: path.join(cfg.mafDir, 'transcripts'), softThreshold: 20_000, chunkSize: 20, lcm: engine,
        });
        await transcript.init();
        const gate = new SecurityReviewGate({
          adapter: cfg.adapter, projectRoot: workDir, securityPrompt: stack.securityPrompt,
          ...(cfg.model ? { model: cfg.model } : {}),
        });
        // Bound to this task's directory so the git tools learn its repository root before the agent
        // acts (WP-2.17); the shared `baseTools` above only validates role allowlists.
        const taskTools = createDefaultRegistry({ projectRoot: workDir, lcmExpand });
        const dispatcher = new RoleDispatcher({
          adapter: cfg.adapter, baseTools: taskTools, roles, injector, policy,
          attestor, approvalGate, graph, transcript, lcmBridge, securityGate: gate,
          cwd: workDir, sessionId: cfg.runId, runId: cfg.runId, harness,
          ...(cfg.allowUngoverned === true ? { allowUngoverned: true } : {}),
          ...(cfg.model ? { modelOverride: cfg.model } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
        });
        const node: DagNode = {
          id: makeNodeId(`task-${taskId}`), label: prompt, agentRole: resolvedRole.value,
          dependencies: [], retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
          timeoutMs, inputs: {}, outputs: {}, metadata: { taskDescription: prompt },
        };
        const out = await dispatcher.runNode(node);
        const value = out['output'];
        return value && value.kind === 'string' ? value.value : '';
      },
      async close() {
        await graph.close();
        engine.close();
      },
    };
    return stack;
  } catch (err) {
    lcm?.close();
    await graph.close();
    throw err;
  }
}

/** Refs `resolveHarnessRef` gives a meaning of its own: a plain run, and the roles file as it is now. */
export const RESOLVER_REFS: ReadonlySet<string> = new Set(['current', 'CURRENT', LEGACY_DEFAULT_ID]);

export interface RunHarnessOptions {
  store:     HarnessStore;
  /** `--harness`, or `legacy-default` when only `--roles` was typed; absent for a plain run. */
  ref?:      string | undefined;
  /** The legacy roles file a plain run, or `legacy-default`, mints from. */
  rolesPath: string;
  mafDir:    string;
  baseTools: ToolRegistry;
}

/** The harness a command dispatches, plus the write that makes it storable (WP-3.6, R1). */
export interface PlannedRunHarness {
  harness: HarnessConfig;
  source:  ResolvedHarness['source'];
  /** Stores what the resolution needed written — nothing when it needed no write. */
  persist: () => Promise<void>;
}

/**
 * The harness a command dispatches, resolved without writing anything (WP-2.9, WP-2.7, WP-3.6 R1).
 * A stored ref — an id, a sha or a unique sha prefix — or a committed `default-<sha>.json`, resolved
 * to its full sha; then `resolveHarnessRef` loads it, else an operator-set CURRENT, else
 * `legacy-default` minted from the roles file now — never a stale snapshot of it, and never a
 * harness whose prompts live outside its sha.
 *
 * Two writes can be needed to make that harness storable: importing a committed default into the
 * store (an attestation can only name a stored harness), and adopting a freshly minted legacy one.
 * Both are deferred to `persist`, because `run --plan-from` resolves the harness to get the role set
 * its spec is validated against, and a spec it refuses must leave the repository and `.maf/` as it
 * found them. Every other command calls `resolveRunHarness`, which is this plus `persist()`.
 */
export async function planRunHarness(o: RunHarnessOptions): Promise<PlannedRunHarness> {
  let ref = o.ref;
  if (ref !== undefined && !RESOLVER_REFS.has(ref)) {
    const found = await locateStoredHarness(o.store, ref);
    if (found.source !== path.join(o.store.dir, `${found.harness.sha}.yaml`)) {
      assertPromptsCarried(found.harness.roleSet,
        `Harness ${JSON.stringify(found.harness.id)} (${shortSha(found.harness.sha)})`,
        'Re-mint it from the roles file (a plain run, or --harness legacy-default), which inlines the text.');
      const source = found.source;
      return {
        harness: found.harness,
        source:  'flag',
        persist: async () => { await importHarness(o.store, source); },
      };
    }
    ref = found.harness.sha;
  }
  const resolved = await resolveHarnessRef({
    harness: ref,
    legacyRoleSet: async () => harnessRoleSetFromRegistry(
      await RoleRegistry.fromYamlOrDefault(o.rolesPath, o.mafDir, o.baseTools)),
    persist: false,
  }, o.store);
  return { harness: resolved.harness, source: resolved.source, persist: resolved.persist ?? (async () => {}) };
}

/** `planRunHarness` and the write: the harness is in the store when this resolves. */
export async function resolveRunHarness(o: RunHarnessOptions): Promise<ResolvedHarness> {
  const { harness, source, persist } = await planRunHarness(o);
  await persist();
  return { harness, source };
}

/**
 * Resolve the golden corpus root (L6). Prefers the requested path; if it has no `corpus.json`,
 * falls back to the seed corpus a source checkout keeps at `tests/goldens`, then — for an installed
 * package, where no checkout exists — to the corpus the package ships beside `dist/`. All three hold
 * `corpus.json` AND `rubrics/`, so rubric resolution works the same way from any of them.
 */
export async function resolveCorpusRoot(cwd: string, optPath: string): Promise<string> {
  const primary = path.resolve(cwd, optPath);
  try {
    await readFile(path.join(primary, 'corpus.json'), 'utf8');
    return primary;
  } catch { /* fall through to the seed corpus */ }
  const checkout = path.resolve(cwd, 'tests', 'goldens');
  try {
    await readFile(path.join(checkout, 'corpus.json'), 'utf8');
    console.log(`[maf] corpus not found at ${primary}; using seed corpus at ${checkout}`);
    return checkout;
  } catch { /* fall through to the packaged corpus */ }
  const packaged = goldensAssetRoot();
  try {
    await readFile(path.join(packaged, 'corpus.json'), 'utf8');
    console.log(`[maf] corpus not found at ${primary}; using the corpus shipped with maf at ${packaged}`);
    return packaged;
  } catch {
    return primary; // let the caller's own read surface a clear error for the requested path
  }
}

export { type TaskDispatcher };
