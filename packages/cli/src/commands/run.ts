import path from 'node:path';
import crypto from 'node:crypto';
import tty from 'node:tty';
import type { Command } from 'commander';
import { makeRunId, makeTaskId, makeAgentId } from '@maf/types';
import type { AdapterName, CliAdapter, DagNode } from '@maf/types';
import { BlackboardStore } from '@maf/blackboard';
import { LcmEngine } from '@maf/lcm';
import { BlackboardToLcmAdapter } from '@maf/lcm-adapter';
import { MemoryGraph } from '@maf/memory-graph';
import { Attestor, componentId } from '@maf/attestation';
import { createApprovalGate } from '@maf/approval-gate';
import { PolicyLoader } from '@maf/policy-engine';
import { ReviewGate, RollbackManager, SecurityReviewGate, WorktreeManager, resolveWorkingDir, runIsolatedGit } from '@maf/git-ops';
import type { FinishResult, Reviewer, RunWorktree } from '@maf/git-ops';
import { DagRunner } from '@maf/dag-runner';
import { GraphAwareInjector } from '@maf/prompt-injector';
import { RetrievalAugmentedPlanner } from '@maf/planning-agent';
import { TranscriptLogger } from '@maf/transcript';
import { createDefaultRegistry } from '@maf/tools';
import type { ToolRegistry } from '@maf/tools';
import { RoleRegistry, RoleDispatcher, effectiveTier, isWriterForLock, isWriterRole, roleSetFromHarness } from '@maf/roles';
import { HarnessStore, LEGACY_DEFAULT_ID, shortSha } from '@maf/harness-config';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';
import { ensureMafDir } from '../ensureMafDir.js';
import { resolveRunHarness } from '../wiring.js';
import { createTtyReviewer, reviewerUnavailable } from '../reviewers/tty.js';
import { ConfigLoader, DEFAULT_MAF_CONFIG, applyDagSettings, resolveConfig } from '../config/ConfigLoader.js';
import type { MafConfig } from '../config/ConfigLoader.js';

const SECURITY_REVIEW_FALLBACK_PROMPT = `You are a security auditor. Review the supplied diff for vulnerabilities. Respond with a strict JSON block:
{
  "findings": [
    { "severity": "critical|high|medium|low|info", "category": "short tag", "file": "path", "line": 0, "rationale": "...", "remediation": "..." }
  ],
  "summary": "one paragraph",
  "passed": true
}
"passed" must be false if any critical or high severity finding exists.`;

/** What `maf run` parses. `adapter` has no commander default: config.yaml sits between the two. */
export interface RunOptions {
  adapter?: string;
  model?:   string;
  dir:      string;
  worktree: boolean;
  policy:   string;
  roles:    string;
  harness?: string;
  /** Let a writer role run on the cli tier, outside MAF's gates (D-01). */
  allowUngoverned?: boolean;
  /** Ask a reviewer to decide each writer change; advisory unless the harness requires review (D-34). */
  review?: boolean;
}

/** The flags whose commander default must be told apart from the same value typed. */
export type GivenFlag = 'adapter' | 'worktree' | 'roles';

/** What `run` takes from the process. A test replaces any of it. */
export interface RunIo {
  stdout: { write(text: string): unknown };
  /** Warnings, and the prompts of the approval gate and the review gate. */
  stderr: NodeJS.WritableStream;
  /** Read only when someone can answer at it (`isTTY`, and not MAF_HEADLESS=1). */
  stdin:  NodeJS.ReadableStream;
  /** Whether stdin is a terminal; `tty.isatty(0)` when unset. */
  isTTY:  boolean;
  /** MAF_SIGNING_KEY and MAF_HEADLESS are read from here. */
  env:    NodeJS.ProcessEnv;
}

export interface RunDeps {
  io?:       Partial<RunIo>;
  /** The adapters `--adapter` can name; `createAdapterRegistry()` when unset. */
  adapters?: () => Map<AdapterName, CliAdapter>;
  /** Decides review requests in place of the terminal reviewer, which needs a TTY. */
  reviewer?: Reviewer;
}

export interface RunContext extends RunDeps {
  /** Whether the user typed `flag`, rather than commander filling in its default. */
  given(flag: GivenFlag): boolean;
}

export function registerRunCommand(program: Command, deps: RunDeps = {}): void {
  program
    .command('run <task>')
    .description('Run a task using the MAF agent framework')
    .option('-a, --adapter <name>', 'CLI adapter to use (claude|gemini|codex|ollama|openrouter|scripted; default: config.yaml, else claude)')
    .option('-m, --model <model>', 'Model name (adapter-specific)')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .option('--no-worktree', 'Disable git worktree isolation')
    .option('--policy <path>', 'Path to policy YAML file', '.maf/policy.yaml')
    .option('--roles <path>', 'Path to roles YAML file', '.maf/roles.yaml')
    .option('--harness <ref>', 'Harness id, sha, or "current" (default: CURRENT if set, else legacy-default from --roles (overrides --roles when given))')
    .option('--allow-ungoverned', "Let writer roles run on the cli tier, outside MAF's policy, redaction, attestation and processor hooks (D-01)")
    .option('--review', 'Ask at the terminal to approve each writer change (advisory unless the harness requires review; D-34)')
    .action(async (taskDescription: string, opts: RunOptions, cmd: Command) => {
      await runTask(taskDescription, opts, { ...deps, given: (flag) => cmd.getOptionValueSource(flag) === 'cli' });
    });
}

/**
 * `maf run`: plan the task, run the plan, attest it. Exported so a test drives the same wiring the
 * command does, with its own adapters and streams.
 */
export async function runTask(taskDescription: string, opts: RunOptions, ctx: RunContext): Promise<void> {
  const stdout = ctx.io?.stdout ?? process.stdout;
  const stderr = ctx.io?.stderr ?? process.stderr;
  const env    = ctx.io?.env ?? process.env;
  // A test that says whether stdin is a terminal hands the gates its streams; otherwise
  // createApprovalGate asks isatty(0) itself, so a headless run never touches process.stdin.
  const terminal = ctx.io?.isTTY !== undefined
    ? { input: ctx.io.stdin ?? process.stdin, output: stderr, isTTY: ctx.io.isTTY }
    : undefined;
  const say  = (line: string): void => { stdout.write(`${line}\n`); };
  const warn = (line: string): void => { stderr.write(`${line}\n`); };

  // `dir` is the project: its .maf/ holds the policy, roles, harnesses and every store, and stays
  // there. Agents work in `cwd`, which is the run's own worktree unless --no-worktree (D-03).
  const dir         = path.resolve(opts.dir);
  const mafDir      = path.join(dir, '.maf');
  // The stores below open files inside .maf/ and do not create it; a repo maf never ran in has none.
  await ensureMafDir(mafDir);

  // flag > config.yaml > built-in default, per key (WP-2.5). Only a flag the user typed is a flag:
  // commander's `--no-worktree` always sets `worktree`, so its source says whether it was typed.
  const fileCfg = await ConfigLoader.load(path.join(mafDir, 'config.yaml'));
  const flags: MafConfig = {
    ...(ctx.given('adapter') && opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(ctx.given('worktree') ? { worktree: opts.worktree } : {}),
  };
  const cfg = resolveConfig({ flags, file: fileCfg, defaults: DEFAULT_MAF_CONFIG });
  const model = cfg.model !== undefined ? { model: cfg.model } : {};

  const runId       = makeRunId(crypto.randomUUID());
  const taskId      = makeTaskId(crypto.randomUUID());
  const sessionId   = runId;

  say(`[maf] run ${runId} | adapter: ${cfg.adapter} | task: ${taskDescription}`);

  // Everything that can refuse the run without opening a store comes first.
  const adapterRegistry = ctx.adapters?.() ?? createAdapterRegistry();
  const adapter = await resolveAdapter(cfg.adapter, adapterRegistry);

  const baseTools = createDefaultRegistry();

  // ── Harness (WP-2.9): --harness, else an operator-set CURRENT, else legacy-default minted from
  // the roles file now. A typed --roles means that file, so it must not lose to CURRENT.
  const harnessStore = new HarnessStore(mafDir);
  const { harness, source: harnessSource } = await resolveRunHarness({
    store:     harnessStore,
    ref:       opts.harness ?? (ctx.given('roles') ? LEGACY_DEFAULT_ID : undefined),
    rolesPath: path.resolve(dir, opts.roles),
    mafDir,
    baseTools,
  });
  // Dispatched FROM the harness, so the sha the attestation names is the content that ran.
  const roles = RoleRegistry.fromSet(roleSetFromHarness(harness.roleSet), mafDir, baseTools);
  say(`[maf] harness: ${harness.id} (${shortSha(harness.sha)}) [${harnessSource}]`);

  // ── Tiers (D-01): the dispatcher refuses an ungoverned writer when its node comes up; refusing
  // here, before planning, saves the planner's tokens and the worktree.
  const ungoverned = roles.list().filter((r) => isWriterRole(r) && effectiveTier(r, adapter) === 'cli');
  if (ungoverned.length > 0 && opts.allowUngoverned !== true) {
    const why = ungoverned.map((r) => `${r.role} (${r.execution === 'cli'
      ? 'its execution is cli'
      : `adapter ${adapter.name} cannot run the in-process loop`})`);
    throw new Error(
      `writer role(s) ${why.join(', ')} would run on the cli tier, outside MAF's policy, redaction, ` +
      'attestation and processor hooks (D-01). Pass --allow-ungoverned to run them there anyway, or ' +
      'give them execution: in-process on an adapter that can run the loop.',
    );
  }

  // ── Review (D-34): a gate exists only when the harness requires review or --review asks for it.
  // Headless, a required review gets no gate — so every writer change is refused, failing closed —
  // and an advisory one cannot be honoured, so the run goes on without it and says so.
  const required = harness.reviewGate?.required === true;
  let reviewGate: ReviewGate | undefined;
  if (required || opts.review === true) {
    const unavailable = ctx.reviewer ? undefined : reviewerUnavailable(ctx.io?.isTTY ?? tty.isatty(0), env);
    const reviewer = ctx.reviewer
      ?? (unavailable === undefined ? createTtyReviewer({ input: ctx.io?.stdin ?? process.stdin, output: stderr }) : undefined);
    if (reviewer) reviewGate = new ReviewGate({ reviewer, required });
    else if (required) warn(`[maf] warning: harness ${harness.id} requires review and no reviewer is available (${unavailable ?? 'none was given'}); every writer change will be refused (D-34).`);
    else warn(`[maf] --review was given, but no reviewer is available (${unavailable ?? 'none was given'}); running without a review gate.`);
  }

  // ── Worktree (D-03): one manager for the whole run — `finish` reads the base commit from it.
  // A directory with no committed files is refused here, before any agent work.
  const worktrees = new WorktreeManager(dir);
  if (cfg.worktree && await hasWorkOutsideHead(dir)) {
    warn(`[maf] warning: ${dir} has uncommitted or untracked changes; the run starts from HEAD in its own worktree and will not see them.`);
  }
  const run = cfg.worktree ? await worktrees.createForRun(runId) : undefined;
  const { cwd, isolated, warning } = resolveWorkingDir({ dir, worktree: cfg.worktree, run });
  if (warning) warn(`[maf] warning: ${warning}`);
  if (run) say(`[maf] worktree: ${run.path} (branch ${run.branch}, from ${run.baseCommit.slice(0, 12)})`);

  let succeeded = false;
  let refusal: string | undefined;
  let graph: MemoryGraph | undefined;
  let lcm: LcmEngine | undefined;
  try {
    // Wire all components
    const board     = new BlackboardStore();
    lcm             = new LcmEngine({
      dbPath:    path.join(mafDir, 'lcm.db'),
      ...cfg.lcm,
      summarize: async (messages) => messages.map((m) => m.content.slice(0, 200)).join('\n'),
    });
    graph           = new MemoryGraph(path.join(mafDir, 'memory.kuzu'));
    const policy    = await PolicyLoader.loadEngine(path.resolve(dir, opts.policy), graph);
    // Confined to the run's worktree branch; without one (--no-worktree) it refuses every reset.
    const rollback  = new RollbackManager(cwd, run);
    const transcript = new TranscriptLogger(runId, makeAgentId(taskId), {
      logDir: path.join(mafDir, 'transcripts'),
      softThreshold: 20_000,
      chunkSize: 20,
      lcm,
    });

    await transcript.init();
    const lcmBridge = new BlackboardToLcmAdapter(board, lcm, sessionId, runId);
    const attestor = new Attestor(runId, graph, path.join(mafDir, 'attestations'), Attestor.resolveSigningSecret(env), harness.sha);
    // One gate for the run (D-02): an escalated tool call is put to the operator at the terminal,
    // or refused and left as a pending record when no one can answer; either way it is attested.
    const approvalGate = createApprovalGate({ recorder: attestor, mafDir, env, ...(terminal ? { terminal } : {}) });

    // `security` may or may not be one of this set's roles; `resolve` answers that without
    // minting the name. The old `hasRole` + `getRole` pair asked twice, and `getRole` answered
    // an unrecognised name with the *default* role — so a role set without `security` would
    // have handed the writer's prompt to the security gate.
    const securityResolved = roles.resolve('security');
    const securityRole = securityResolved.ok ? securityResolved.value.config : undefined;
    const securityPrompt = securityRole
      ? (await roles.loadPrompt(securityRole))
      : SECURITY_REVIEW_FALLBACK_PROMPT;
    const securityGate = new SecurityReviewGate({
      adapter,
      projectRoot:    cwd,
      securityPrompt,
      timeoutMs:      cfg.timeouts.securityReviewMs,
      ...model,
    });

    const injector = new GraphAwareInjector({ graph, lcm, maxNodes: 40, tokenBudget: 4096 });
    const planner  = new RetrievalAugmentedPlanner({
      graph, lcm, injector,
      // The registry is the role set in force: it supplies the default role AND the answer to
      // "is this name real?". The planner used to carry `defaultRole` plus a `validRoles` set
      // and *warn* before assigning the default, which was the writer.
      roles,
      roleCatalog: roles.catalog(),
      generatePlan: async (systemPrompt, userPrompt) => {
        const result = await adapter.invoke({
          prompt: userPrompt, systemPrompt,
          workingDir: cwd, timeoutMs: cfg.timeouts.planMs,
          maxOutputBytes: 64 * 1024, // planning only needs a JSON block
          ...model,
        });
        return result.output;
      },
    });

    const dispatcher = new RoleDispatcher({
      adapter,
      baseTools,
      roles,
      injector,
      policy,
      attestor,
      approvalGate,
      graph,
      transcript,
      lcmBridge,
      securityGate,
      ...(reviewGate ? { reviewGate } : {}),
      cwd,
      sessionId,
      runId,
      harness,
      ...(opts.allowUngoverned === true ? { allowUngoverned: true } : {}),
      stderr,
      ...(cfg.model !== undefined ? { modelOverride: cfg.model } : {}),
    });

    // Record run start in memory graph (harness provenance)
    await graph.addNode({
      kind: 'Run', label: runId,
      properties: { taskDescription, adapter: cfg.adapter, harnessId: harness.id, harness_sha: harness.sha },
      runId,
    });

    // Generate DAG; the run's concurrency and retry policy come from the config (WP-2.5).
    say('[maf] planning...');
    const dag = applyDagSettings(await planner.plan({ title: taskDescription, description: taskDescription, runId, sessionId }), cfg.dag);

    // Run DAG
    const dagRunner = new DagRunner();
    say(`[maf] running DAG with ${dag.nodes.size} node(s)...`);

    const outcome = await dagRunner.run({
      dag,
      board,
      executor: (node) => dispatcher.runNode(node),
      isWriter: writerLock(roles, adapter, baseTools),
      onNodeStart: (id) => say(`[maf] → node ${id} started`),
      onNodeEnd:   (id, status) => {
        // The baseline commit captured for a writer node is held until the node ends, so a
        // retry reviews against the same base (D-06); release it here.
        dispatcher.endNode(id);
        say(`[maf] ← node ${id} ${status}`);
      },
    });

    // Every failed node leaves a Failure node behind. Until now only the security
    // gate wrote one, so no other kind of failure left a trace in the graph.
    for (const node of outcome.nodes ?? []) {
      if (node.status !== 'Failed') continue;
      await graph.addNode({
        kind:       'Failure',
        label:      node.nodeId,
        properties: {
          nodeId: node.nodeId,
          role:   dag.nodes.get(node.nodeId)?.agentRole ?? 'unknown',
          error:  node.error ?? 'unknown',
        },
        runId,
      });
    }

    // Bundle attestation — the harness IS the build's config source (signed): the stored file and
    // its sha, re-verified now, so the digest names what was dispatched.
    const bundle = await attestor.bundle(
      { id: componentId(`@maf/adapter-${cfg.adapter}`), modelVersion: cfg.model ?? 'default' },
      {
        configSource: await harnessStore.configSource(harness),
        parameters:  { harnessId: harness.id },
        environment: {},
      },
      [],
      outcome,
    );

    say(`[maf] done. Attestation: ${path.join(mafDir, 'attestations', runId + '.bundle.json')}`);
    say(`[maf] signature: ${bundle.signature.slice(0, 16)}... (keySource: ${bundle.keySource})`);

    // The bundle is written first so the failed run is still attested; the exit
    // code is what callers and CI actually branch on.
    if (outcome.status !== 'Succeeded') {
      const failed = (outcome.nodes ?? [])
        .filter((n) => n.status === 'Failed')
        .map((n) => n.nodeId);
      throw new Error(
        `run did not succeed (${outcome.status})` +
        ` — failed: [${failed.join(', ')}], never ran: [${outcome.unscheduled.join(', ')}]`,
      );
    }
    succeeded = true;
  } finally {
    // Reached by a failure or a throw as well, so the worktree is always reported. Never removed.
    if (isolated && run) refusal = await finishWorktree(worktrees, run, succeeded, say, warn);
    graph?.close();
    lcm?.close();
  }
  // Only a run that succeeded can be refused a merge; the paths are printed above.
  if (refusal !== undefined) throw new Error(refusal);
}

/**
 * The scheduler's writer predicate. It serializes writers against each other because two agents
 * editing one tree corrupt it, and decides by the tier a role will actually run on (D-01): a role
 * on the cli tier holds the lock whatever its allowlist, because the backend brings file tools of
 * its own. Treating a reader as a writer only costs concurrency; the reverse costs the tree, so a
 * role the registry does not know is a writer.
 */
export function writerLock(roles: RoleRegistry, adapter: CliAdapter, baseTools: ToolRegistry): (node: DagNode) => boolean {
  return (node) => roles.hasRole(node.agentRole) ? isWriterForLock(roles.getRole(node.agentRole), adapter, baseTools) : true;
}

/**
 * Whether the user has work the run's worktree, started from HEAD, will not have. MAF's own
 * `.maf/` under `dir` is left out: the run reads it from `dir`, not from the worktree.
 */
async function hasWorkOutsideHead(dir: string): Promise<boolean> {
  try {
    const { stdout } = await runIsolatedGit(dir, ['status', '--porcelain', '--', ':(top)', ':(exclude).maf'],
      { env: { GIT_LITERAL_PATHSPECS: '0' } });
    return stdout.trim() !== '';
  } catch {
    return false; // not a repository: createForRun refuses it with the reason
  }
}

/**
 * Ends the run's worktree (WP-2.4) and says what the user can do with it. Returns the reason the
 * run must exit non-zero although it succeeded, which only a `refused` branch is. `finish` can
 * throw — the agent switched branch or detached HEAD — and the user still needs the path.
 */
async function finishWorktree(
  worktrees: WorktreeManager, run: RunWorktree, succeeded: boolean,
  say: (line: string) => void, warn: (line: string) => void,
): Promise<string | undefined> {
  let fin: FinishResult;
  try {
    fin = await worktrees.finish(run.runId, succeeded ? 'success' : 'failure');
  } catch (err: unknown) {
    warn(`[maf] ${err instanceof Error ? err.message : String(err)}`);
    warn(`[maf] the run's worktree is kept at ${run.path} (branch ${run.branch}).`);
    return undefined;
  }
  switch (fin.kind) {
    case 'merge':
      say(`[maf] the run's work is on ${fin.branch} (worktree ${fin.path}). To take it: ${fin.mergeCommand}`);
      return undefined;
    case 'no-change':
      say(`[maf] the run changed nothing; ${fin.branch} is still at its base (worktree ${fin.path}).`);
      return undefined;
    case 'refused':
      warn(`[maf] not offering a merge: ${fin.branch} commits MAF runtime state the security gate never reviews: ${fin.paths.join(', ')}; inspect ${fin.path}`);
      return `run ${run.runId} succeeded, but ${fin.branch} commits MAF runtime state (${fin.paths.join(', ')}), so no merge is offered; inspect ${fin.path}`;
    case 'failure':
      warn(`[maf] the run's worktree is kept for inspection at ${fin.path} (branch ${fin.branch}).`);
      return undefined;
  }
}
