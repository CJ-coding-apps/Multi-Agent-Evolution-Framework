import { chmod, cp, mkdir, mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshotDiff, runIsolatedGit } from '@maf/git-ops';
import { refusePrototypeKey } from '@maf/types';
import type { GoldenTask } from './GoldenTask.js';
import { assertGoldenCorpus } from './GoldenTask.js';
import { checkUnmodified, runVerifier } from './verifiers.js';
import type { VerifierContext, VerifierOutcome } from './verifiers.js';
import { computeCorpusSha } from './corpusSha.js';
import type { JudgeDisclosure } from './judge.js';
import { findHiddenMarkers, loadHiddenStore, readExpectations, readHiddenFile } from './hiddenStore.js';
import { compareObservations, runHiddenCheck } from './hiddenCheck.js';
import type { HiddenStoreFile } from './hiddenStore.js';

/**
 * R6-H1: one piece of text a run recorded, with a label a report can print. The caller supplies
 * the ones this package cannot see (the attested tool calls and the transcript); the runner adds
 * the final output and the worktree it leaves behind.
 */
export interface RecordedSurface {
  label: string;
  text: string;
}

/** R6-M1: the caller's budget, asked after every task so a run can stop inside the suite. */
export interface GoldenRunLimit {
  /** A sentence when the budget is crossed and the run must stop now, or undefined to continue. */
  crossed(): string | undefined;
}

export interface AttemptResult {
  attempt: number;
  output: string;
  outcomes: VerifierOutcome[];
  passed: boolean;
  error?: string;
  /**
   * R6-H1: the attempt read hidden material (or the runner could not prove it did not). It is
   * scored as a failure whatever the verifiers would have said, and a gate session containing one
   * refuses to report an improvement.
   */
  contaminated?: { evidence: string[] };
}

/** R6-H1: one voided attempt, as the suite result and the report list it. */
export interface ContaminatedAttempt {
  taskId: string;
  attempt: number;
  evidence: string[];
}

export interface GoldenTaskResult {
  taskId: string;
  role: string;
  /** pass@k: solved if any attempt passes. */
  passed: boolean;
  attempts: AttemptResult[];
}

export interface GoldenSuiteResult {
  harnessSha: string;
  harnessId: string;
  // Optional in the type so results written before 0.3.0 still load; the runner always sets them.
  /** sha256 over the canonical corpus (D-14); results with different shas do not compare. */
  corpusSha?: string;
  /** pass@k: attempts per task. */
  attempts?: number;
  /** The adapter (and model) under evaluation. */
  adapter?: string;
  model?: string;
  /** Who judged the llm-judge verifiers; absent when no judge was wired (they then fail closed). */
  judge?: JudgeDisclosure;
  /**
   * D-57: the split this run measured, named in the result. A full-corpus run (the `goldens run`
   * default, and every result written before the split existed) names none.
   */
  split?: 'train' | 'held-out';
  /** D-57: sha of the split definition. Results from different splits do not compare. */
  splitsSha?: string;
  tasks: GoldenTaskResult[];
  /** Task ids that passed. */
  solvedTaskIds: string[];
  /** R6-H1: attempts voided for reading hidden material. Absent when there were none. */
  contamination?: { attempts: ContaminatedAttempt[]; statement: string };
  /**
   * R6-M1: the run stopped inside the suite because the caller's budget was crossed. `tasks` and
   * `solvedTaskIds` then describe only the tasks before the crossing, and `statement` says so:
   * a partial result is never a whole one, and a caller must not compare it as if it were.
   */
  partial?: { reason: string; completedTasks: number; totalTasks: number; statement: string };
  ranAt: string;
}

/**
 * The shell contract: how a golden task is dispatched under a given harness.
 * The CLI wires this to RoleDispatcher; tests wire it to a stub adapter.
 * Receives an isolated working directory (fixture copy).
 */
export type TaskDispatcher = (task: GoldenTask, workDir: string, opts: {
  temperature: number; timeoutMs: number;
}) => Promise<string>;

export interface GoldenRunnerOptions {
  corpusRoot: string;
  harnessSha: string;
  harnessId: string;
  /** pass@k attempts per task (default 2). */
  attempts?: number;
  /** Pinned sampling temperature (default 0). */
  temperature?: number;
  timeoutMs?: number;
  dispatch: TaskDispatcher;
  /** The adapter (and model) the dispatcher evaluates, recorded on the result. */
  adapter: string;
  model?: string;
  securityScore?: VerifierContext['securityScore'];
  /** The judge and who it is: a judge cannot be wired without being disclosed (D-14). */
  llmJudge?: {
    verdict: NonNullable<VerifierContext['llmJudge']>;
    disclosure: JudgeDisclosure;
  };
  /** D-57: stamped on every result this runner emits (the caller still names the ids to run()). */
  split?: { name: 'train' | 'held-out'; sha: string };
  /** R6-H1: the encoded hidden store, relative to the corpus root or absolute. */
  hiddenStore?: string;
  /**
   * R6-H1: everything else the caller recorded for a task — attested tool inputs and outputs, the
   * transcript — so the canary scan reaches the record and not only the final answer. A hook that
   * throws voids the attempt: a scan that cannot run proves nothing.
   */
  recordedSurfaces?: (task: GoldenTask) => Promise<readonly RecordedSurface[]>;
  /** R6-M1: asked after every task; a sentence stops the run and marks the result partial. */
  limit?: GoldenRunLimit;
}

export class GoldenRunner {
  constructor(private readonly opts: GoldenRunnerOptions) {}

  async loadCorpus(): Promise<GoldenTask[]> {
    const text = await readFile(path.join(this.opts.corpusRoot, 'corpus.json'), 'utf8');
    // WP-3.9 G5: a corpus is a file the operator names, read through the shared reviver.
    const parsed: unknown = JSON.parse(text, refusePrototypeKey);
    assertGoldenCorpus(parsed);
    return parsed;
  }

  /** Runs the corpus, or only the tasks named in `only` (each must be in the corpus). */
  async run(only?: readonly string[]): Promise<GoldenSuiteResult> {
    const corpus = await this.loadCorpus();
    // D-57: a split-scoped runner must be given that split's ids. Without this a caller that
    // forgot them would measure the whole corpus and stamp it `train` — a result that names a
    // split it did not measure, and a held-out task silently spent on the evolver.
    if (this.opts.split !== undefined && only === undefined)
      throw new Error(
        `goldens: a ${this.opts.split.name} runner must be given the split's task ids; run(only) was called without them.`,
      );
    const store = await loadHiddenStore(this.opts.corpusRoot, this.opts.hiddenStore);
    const corpusSha = await computeCorpusSha(
      this.opts.corpusRoot, corpus,
      this.opts.hiddenStore !== undefined ? { hiddenStore: this.opts.hiddenStore } : {},
    );
    const missing = (only ?? []).filter((id) => !corpus.some((t) => t.id === id));
    if (missing.length > 0) {
      throw new Error(`goldens: task(s) ${missing.join(', ')} are not in the corpus at ${this.opts.corpusRoot}.`);
    }
    const selected = corpus.filter((t) => only === undefined || only.includes(t.id));
    const tasks: GoldenTaskResult[] = [];
    let partial: GoldenSuiteResult['partial'];
    for (const task of selected) {
      tasks.push(await this.runTask(task, store));
      // R6-M1: the ceiling is asked after every task, not only before the run. The overshoot is
      // then the task that crossed it, not the rest of the suite.
      const crossed = this.opts.limit?.crossed();
      if (crossed !== undefined && tasks.length < selected.length) {
        partial = {
          reason: crossed,
          completedTasks: tasks.length,
          totalTasks: selected.length,
          statement:
            `${tasks.length} of ${selected.length} tasks ran before the budget was crossed (${crossed}); ` +
            'the rest of the suite was not started and this result is partial.',
        };
        break;
      }
    }
    const contaminatedAttempts = tasks.flatMap((t) => t.attempts.flatMap((a) => a.contaminated === undefined
      ? []
      : [{ taskId: t.taskId, attempt: a.attempt, evidence: a.contaminated.evidence }]));
    return {
      harnessSha: this.opts.harnessSha,
      harnessId: this.opts.harnessId,
      corpusSha,
      attempts: this.attempts(),
      adapter: this.opts.adapter,
      ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
      ...(this.opts.llmJudge ? { judge: this.opts.llmJudge.disclosure } : {}),
      ...(this.opts.split ? { split: this.opts.split.name, splitsSha: this.opts.split.sha } : {}),
      tasks,
      solvedTaskIds: tasks.filter((t) => t.passed).map((t) => t.taskId),
      ...(contaminatedAttempts.length > 0 ? {
        contamination: {
          attempts: contaminatedAttempts,
          statement:
            `${contaminatedAttempts.length} attempt${contaminatedAttempts.length === 1 ? '' : 's'} ` +
            `read hidden material and ${contaminatedAttempts.length === 1 ? 'is' : 'are'} void ` +
            `(${contaminatedAttempts.map((a) => `${a.taskId}#${a.attempt}`).join(', ')}): ` +
            'this result cannot support an improvement claim.',
        },
      } : {}),
      ...(partial !== undefined ? { partial } : {}),
      ranAt: new Date().toISOString(),
    };
  }

  private async runTask(task: GoldenTask, store: HiddenStoreFile): Promise<GoldenTaskResult> {
    const attempts: AttemptResult[] = [];
    const k = this.attempts();
    for (let i = 0; i < k; i++) {
      attempts.push(await this.runAttempt(task, i, store));
    }
    return {
      taskId: task.id,
      role: task.role,
      passed: attempts.some((a) => a.passed),
      attempts,
    };
  }

  private attempts(): number {
    return this.opts.attempts ?? 2;
  }

  private async runAttempt(task: GoldenTask, attempt: number, store: HiddenStoreFile): Promise<AttemptResult> {
    const workRoot = await mkdtemp(path.join(tmpdir(), 'maf-golden-'));
    const workDir = path.join(workRoot, 'repo');
    const fixtureDir = path.join(this.opts.corpusRoot, task.repoFixture);
    try {
      await cp(fixtureDir, workDir, { recursive: true, filter: (src) => !isHiddenDir(fixtureDir, src) });
      const baseline = await initBaselineRepo(workDir);
      const output = await this.opts.dispatch(task, workDir, {
        temperature: this.opts.temperature ?? 0,
        timeoutMs: this.opts.timeoutMs ?? 120_000,
      });
      // The base is the RECORDED baseline, not HEAD: an agent that commits its own work would
      // diff clean against HEAD, and an empty diff scores every security verifier clean.
      const diff = await snapshotDiff(workDir, baseline);
      const protectedFiles = task.mustNotModify && task.mustNotModify.length > 0
        ? [await checkUnmodified(workDir, fixtureDir, task.mustNotModify)]
        : [];
      // R6-H1: the agent has stopped and its session's processes are reaped (the dispatcher
      // resolves after the tool loop, and `test.run` kills its whole detached group). Only now is
      // the record asked what it saw. A hit voids the attempt: it is scored as a failure whatever
      // the checks would have said, because a run that read the checks did not solve the task.
      const evidence = await this.contamination(task, workDir, output);
      if (evidence.length > 0)
        return { attempt, output, outcomes: [], passed: false, contaminated: { evidence } };
      // R5-P1 / R6-H1: the checks are decoded into a fresh private directory — never into the
      // worktree the agent still has open — and scoring happens there, on a copy of the final
      // worktree. The directory is removed in `finally`, and with it the only plaintext copy.
      const scoringRoot = await mkdtemp(path.join(tmpdir(), 'maf-score-'));
      // mkdtemp already asks for 0700; asking again makes the guarantee explicit and testable.
      await chmod(scoringRoot, 0o700);
      let outcomes: VerifierOutcome[];
      try {
        const scoringRepo = path.join(scoringRoot, 'repo');
        await cp(workDir, scoringRepo, { recursive: true });
        outcomes = [...protectedFiles, ...await this.runChecks(task, scoringRepo, store, fixtureDir, {
          output, diff,
        })];
      } finally {
        await rm(scoringRoot, { recursive: true, force: true });
      }
      return { attempt, output, outcomes, passed: outcomes.every((o) => o.passed) };
    } catch (err) {
      return {
        attempt, output: '', outcomes: [],
        passed: false, error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * R7-H2: every `test-script` verifier is scored across a process boundary. A held-out task's
   * source is its stored hidden check; a train task's is the visible `test.js`, read from the
   * pristine fixture rather than the worktree, so the script that judges the run is the one the
   * corpus shipped. The expected values come from the store and stay in this process.
   *
   * A task that declares a `test-script` verifier but has no expectations for it fails closed: a
   * check with nothing to compare against is a check that proves nothing, and scoring it as passed
   * (or as absent) would let a run through on no evidence at all.
   */
  private async runChecks(
    task: GoldenTask, scoringRepo: string, store: HiddenStoreFile, fixtureDir: string,
    ctx: { output: string; diff: string },
  ): Promise<VerifierOutcome[]> {
    const outcomes: VerifierOutcome[] = [];
    const hidden = task.hiddenChecks ?? [];
    for (const v of task.verifiers) {
      if (v.kind !== 'test-script') {
        outcomes.push(await runVerifier(v, {
          workDir: scoringRepo, output: ctx.output, diff: ctx.diff, corpusRoot: this.opts.corpusRoot,
          ...(this.opts.securityScore ? { securityScore: this.opts.securityScore } : {}),
          ...(this.opts.llmJudge ? { llmJudge: this.opts.llmJudge.verdict } : {}),
        }));
        continue;
      }
      const rel = hidden.find((h) => h.slice('.checks/'.length) === v.args[0]) ?? hidden[0];
      let source: string;
      let key: string;
      if (rel !== undefined) {
        source = readHiddenFile(store, 'checks', task.id, rel);
        key = rel;
      } else {
        key = v.args[0] ?? '';
        if (!task.mustNotModify?.includes(key)) {
          outcomes.push({
            kind: 'test-script', passed: false,
            detail: `${v.command} ${v.args.join(' ')}: the script is neither a stored hidden check nor a protected fixture file, so it cannot be scored across the process boundary`,
          });
          continue;
        }
        try {
          source = await readFile(path.join(fixtureDir, key), 'utf8');
        } catch (err) {
          outcomes.push({
            kind: 'test-script', passed: false,
            detail: `${key} could not be read from the pristine fixture: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
      }
      let expectations;
      try {
        expectations = readExpectations(store, task.id, key);
      } catch (err) {
        outcomes.push({
          kind: 'test-script', passed: false,
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const run = await runHiddenCheck(source, scoringRepo, {
        ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
      });
      if (run.failure !== undefined) {
        outcomes.push({ kind: 'test-script', passed: false, detail: `hidden check: ${run.failure}` });
        continue;
      }
      const verdict = compareObservations(run.observations, expectations);
      outcomes.push({ kind: 'test-script', passed: verdict.passed, detail: verdict.detail });
    }
    return outcomes;
  }

  /**
   * R6-H1: every surface this attempt could have left a canary in — the final answer, what the
   * caller recorded (attested tool calls, transcript), and the worktree it left. A hook that
   * cannot read its surfaces returns evidence rather than passing: an unscannable attempt has not
   * shown that it is clean.
   */
  private async contamination(task: GoldenTask, workDir: string, output: string): Promise<string[]> {
    const evidence = new Set<string>(findHiddenMarkers(output, 'the final assistant output'));
    try {
      for (const surface of await this.opts.recordedSurfaces?.(task) ?? [])
        for (const hit of findHiddenMarkers(surface.text, surface.label)) evidence.add(hit);
    } catch (err) {
      evidence.add(`the recorded surfaces could not be scanned: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      for (const hit of await scanWorktree(workDir)) evidence.add(hit);
    } catch (err) {
      evidence.add(`the final worktree could not be scanned: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [...evidence];
  }
}

/**
 * R6-H1: hidden checks and reference solutions are not stored as plain files (D-57). They live in
 * the encoded store, and a fixture tree that still carries either directory is a corpus that has
 * not been migrated — the copy filter refuses it anyway, but the fixture itself would remain
 * readable by anything the agent runs.
 */
const NEVER_IN_WORKTREE = new Set(['.checks', '.reference']);

function isHiddenDir(fixtureDir: string, source: string): boolean {
  return path.relative(fixtureDir, source).split(path.sep).some((seg) => NEVER_IN_WORKTREE.has(seg));
}

/** Files above this are not where a canary lives, and reading them all would cost more than it finds. */
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/**
 * The worktree the agent left, as text: every path and every file's content, except `.git` — whose
 * objects are compressed and whose index is binary, so a canary the agent committed is found in
 * the file it committed, not there.
 */
async function scanWorktree(root: string): Promise<string[]> {
  const findings: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (rel === '.git') continue;
        findings.push(...findHiddenMarkers(rel, `the path ${rel}`));
        await walk(full);
        continue;
      }
      findings.push(...findHiddenMarkers(rel, `the path ${rel}`));
      if (!entry.isFile()) continue;
      const info = await stat(full);
      if (info.size > MAX_SCANNED_BYTES) continue;
      const bytes = await readFile(full);
      // A NUL byte in the first block means binary: a canary is text, and decoding the rest as
      // UTF-8 would only produce noise for the substring search.
      if (bytes.subarray(0, 8192).includes(0)) continue;
      findings.push(...findHiddenMarkers(bytes.toString('utf8'), `the file ${rel}`));
    }
  };
  await walk(root);
  return findings;
}

// A baseline the runner creates itself, with a fixed identity and timestamp so the
// same fixture produces the same commit on every machine. Fixtures therefore need no
// .git of their own — which they cannot have anyway: git refuses to track files inside
// a directory that contains one.
const BASELINE_IDENTITY = {
  name:  'maf golden baseline',
  email: 'goldens@maf.invalid',
  date:  '1970-01-01T00:00:00Z',
  message: 'golden fixture baseline',
};

/**
 * Every git call the runner makes adds the fixed identity on top of `runIsolatedGit`, which
 * already switches the host's configuration off — a global `core.hooksPath`, `init.templateDir`
 * or `diff.external` would otherwise run inside a golden repo, and the score would depend on
 * whose machine it ran on. The branch is pinned so a host `init.defaultBranch` cannot change
 * the baseline either.
 */
function gitIn(workDir: string) {
  return (args: string[]) => runIsolatedGit(workDir, args, {
    env: {
      GIT_AUTHOR_NAME:     BASELINE_IDENTITY.name,
      GIT_AUTHOR_EMAIL:    BASELINE_IDENTITY.email,
      GIT_COMMITTER_NAME:  BASELINE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: BASELINE_IDENTITY.email,
      GIT_AUTHOR_DATE:     BASELINE_IDENTITY.date,
      GIT_COMMITTER_DATE:  BASELINE_IDENTITY.date,
    },
  });
}

/** Commits the fixture as it was copied, and returns that commit — the diff base. */
async function initBaselineRepo(workDir: string): Promise<string> {
  const git = gitIn(workDir);
  await git(['-c', 'init.defaultBranch=maf-baseline', 'init', '-q']);
  await git(['add', '-A']);
  // --allow-empty: a copied fixture may already carry a repo with this tree committed.
  await git(['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', BASELINE_IDENTITY.message]);
  const { stdout } = await git(['rev-parse', 'HEAD']);
  return stdout.trim();
}

// ─── Seesaw comparator (pure core: decide, don't perform — plan §10.6) ───────

export type SeesawDecision =
  | { kind: 'ship';      improvements: string[] }
  | { kind: 'reject';    regressions: string[] }
  | { kind: 'no-change' };

/**
 * The seesaw constraint: a candidate ships only if it regresses NOTHING that
 * currently passes and improves at least one task. Pure function over two
 * suite results (constitution §10.6).
 */
export function seesawDecision(current: GoldenSuiteResult, candidate: GoldenSuiteResult): SeesawDecision {
  const cur = new Set(current.solvedTaskIds);
  const cand = new Set(candidate.solvedTaskIds);
  const regressions = [...cur].filter((id) => !cand.has(id)).sort();
  if (regressions.length > 0) return { kind: 'reject', regressions };
  const improvements = [...cand].filter((id) => !cur.has(id)).sort();
  if (improvements.length === 0) return { kind: 'no-change' };
  return { kind: 'ship', improvements };
}
