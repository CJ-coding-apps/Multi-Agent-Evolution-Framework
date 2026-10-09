import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { makeAgentId, makeNodeId, makeTaskId } from '@maf/types';
import type { DagNode, CliAdapter, RunId } from '@maf/types';
import { BlackboardStore } from '@maf/blackboard';
import { LcmEngine } from '@maf/lcm';
import { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import { MemoryGraph } from '@maf/memory-graph';
import { Attestor } from '@maf/attestation';
import { PolicyLoader } from '@maf/policy-engine';
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

/**
 * Shared CLI wiring for run/goldens/evolve commands: one component stack per
 * invocation, one TaskDispatcher factory producing isolated RoleDispatchers.
 * Keep component construction here, nowhere else (single home per §5).
 */

export const SECURITY_REVIEW_FALLBACK_PROMPT = `You are a security auditor. Review the supplied diff for vulnerabilities. Respond with a strict JSON block:
{ "findings": [ { "severity": "critical|high|medium|low|info", "category": "t", "file": "f", "line": 0, "rationale": "r", "remediation": "x" } ], "summary": "s", "passed": true }`;

export interface RunStack {
  adapter: CliAdapter;
  graph: MemoryGraph;
  attestor: Attestor;
  lcm: LcmEngine;
  securityPrompt: string;
  rolesFor(harness: HarnessConfig): RoleRegistry;
  dispatchTask(harness: HarnessConfig, role: string, prompt: string, workDir: string, timeoutMs: number, temperature?: number): Promise<string>;
  close(): void;
}

export async function buildRunStack(cfg: {
  cwd: string;
  mafDir: string;
  policyPath: string;
  adapter: CliAdapter;
  model?: string;
  runId: RunId;
  harnessSha: string;
}): Promise<RunStack> {
  const graph = new MemoryGraph(path.join(cfg.mafDir, 'memory.kuzu'));
  const attestor = new Attestor(cfg.runId, graph, path.join(cfg.mafDir, 'attestations'), Attestor.resolveSigningSecret(process.env), cfg.harnessSha);
  const policy = await PolicyLoader.loadEngine(cfg.policyPath, graph);
  const baseTools = createDefaultRegistry();
  const board = new BlackboardStore();
  const lcm = new LcmEngine({
    dbPath: path.join(cfg.mafDir, 'lcm.db'),
    contextThreshold: 0.75, freshTailCount: 64, mode: 'Upward',
    summarize: async (msgs) => msgs.map((m) => m.content.slice(0, 200)).join('\n'),
  });
  const injector = new GraphAwareInjector({ graph, lcm, maxNodes: 40, tokenBudget: 4096 });
  const lcmBridge = new BlackboardToLcmAdapter(board, lcm, cfg.runId, cfg.runId);

  const stack: RunStack = {
    adapter: cfg.adapter,
    graph,
    attestor,
    lcm,
    securityPrompt: SECURITY_REVIEW_FALLBACK_PROMPT,
    rolesFor: (harness) => RoleRegistry.fromSet(roleSetFromHarness(harness.roleSet), cfg.mafDir, baseTools),
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
        logDir: path.join(cfg.mafDir, 'transcripts'), softThreshold: 20_000, chunkSize: 20, lcm,
      });
      await transcript.init();
      const gate = new SecurityReviewGate({
        adapter: cfg.adapter, projectRoot: workDir, securityPrompt: stack.securityPrompt,
        ...(cfg.model ? { model: cfg.model } : {}),
      });
      const dispatcher = new RoleDispatcher({
        adapter: cfg.adapter, baseTools, roles, injector, policy,
        attestor, graph, transcript, lcmBridge, securityGate: gate,
        cwd: workDir, sessionId: cfg.runId, runId: cfg.runId, harness,
        ...(cfg.model ? { modelOverride: cfg.model } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      });
      const node: DagNode = {
        id: makeNodeId(`evolve-${taskId}`), label: prompt, agentRole: resolvedRole.value,
        dependencies: [], retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 },
        timeoutMs, inputs: {}, outputs: {}, metadata: { taskDescription: prompt },
      };
      const out = await dispatcher.runNode(node);
      const value = out['output'];
      return value && value.kind === 'string' ? value.value : '';
    },
    close() {
      graph.close();
      lcm.close();
    },
  };
  return stack;
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
 * Resolve the golden corpus root (L6). Prefers the requested path; if it has no
 * corpus.json, falls back to the repo's committed seed corpus at tests/goldens
 * (which holds corpus.json AND rubrics/, so rubricFile resolution still works).
 */
export async function resolveCorpusRoot(cwd: string, optPath: string): Promise<string> {
  const primary = path.resolve(cwd, optPath);
  try {
    await readFile(path.join(primary, 'corpus.json'), 'utf8');
    return primary;
  } catch { /* fall through to the seed corpus */ }
  const fallback = path.resolve(cwd, 'tests', 'goldens');
  try {
    await readFile(path.join(fallback, 'corpus.json'), 'utf8');
    console.log(`[maf] corpus not found at ${primary}; using seed corpus at ${fallback}`);
    return fallback;
  } catch {
    return primary; // let the caller's own read surface a clear error for the requested path
  }
}

export { type TaskDispatcher };
