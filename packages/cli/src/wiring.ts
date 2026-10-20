import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { makeAgentId, makeNodeId, makeTaskId } from '@maf/types';
import type { DagNode, CliAdapter, GraphQueryRunner, RunId } from '@maf/types';
import { BlackboardStore } from '@maf/blackboard';
import { LcmEngine } from '@maf/lcm';
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
import { LEGACY_DEFAULT_ID, resolveHarnessRef } from '@maf/harness-config';
import type { HarnessConfig, HarnessStore, ResolvedHarness } from '@maf/harness-config';
import type { TaskDispatcher } from '@maf/eval-harness';
import { importHarness, locateStoredHarness } from './commands/harness.js';
import { goldensAssetRoot, readAsset } from './assets.js';

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
  close(): void;
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
}): Promise<RunStack> {
  const graph = new MemoryGraph(path.join(cfg.mafDir, 'memory.kuzu'));
  // M1: a setup that fails after this point must not leak the handle. Kùzu keeps files open under
  // `mafDir`, and a caller that removes that directory on the way out — goldens' evaluation
  // directory — then fails with ENOTEMPTY, which would replace the error that caused the removal
  // (a mistyped `--policy`, in the reported case). Nothing here can use a half-built stack.
  let lcm: LcmEngine | undefined;
  try {
    const attestor = new Attestor(cfg.runId, graph, path.join(cfg.mafDir, 'attestations'), Attestor.resolveSigningSecret(process.env), cfg.harnessSha);
    const policy = await loadCommandPolicy(cfg.cwd, cfg.policy, graph);
    // One gate for every task of the stack, outside dispatchTask, so request ids are unique across them.
    const approvalGate = createApprovalGate({
      recorder: attestor, mafDir: cfg.mafDir,
      env: cfg.headless === true ? { ...process.env, MAF_HEADLESS: '1' } : process.env,
    });
    const baseTools = createDefaultRegistry();
    const board = new BlackboardStore();
    const engine = new LcmEngine({
      dbPath: path.join(cfg.mafDir, 'lcm.db'),
      contextThreshold: 0.75, freshTailCount: 64, mode: 'Upward',
      summarize: async (msgs) => msgs.map((m) => m.content.slice(0, 200)).join('\n'),
    });
    lcm = engine;
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
        const taskTools = createDefaultRegistry({ projectRoot: workDir });
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
      close() {
        graph.close();
        engine.close();
      },
    };
    return stack;
  } catch (err) {
    lcm?.close();
    graph.close();
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

/**
 * The harness a command dispatches, by the one path `run` takes (WP-2.9, WP-2.7). A stored ref — an
 * id, a sha or a unique sha prefix — or a committed `default-<sha>.json`, imported into the store on
 * the way because an attestation can only name a stored harness, is resolved to its full sha; then
 * `resolveHarnessRef` loads it, else an operator-set CURRENT, else `legacy-default` minted from the
 * roles file now — never a stale snapshot of it, and never a harness whose prompts live outside its sha.
 */
export async function resolveRunHarness(o: RunHarnessOptions): Promise<ResolvedHarness> {
  let ref = o.ref;
  if (ref !== undefined && !RESOLVER_REFS.has(ref)) {
    const found = await locateStoredHarness(o.store, ref);
    if (found.source !== path.join(o.store.dir, `${found.harness.sha}.yaml`)) await importHarness(o.store, found.source);
    ref = found.harness.sha;
  }
  return resolveHarnessRef({
    harness: ref,
    legacyRoleSet: async () => harnessRoleSetFromRegistry(
      await RoleRegistry.fromYamlOrDefault(o.rolesPath, o.mafDir, o.baseTools)),
  }, o.store);
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
