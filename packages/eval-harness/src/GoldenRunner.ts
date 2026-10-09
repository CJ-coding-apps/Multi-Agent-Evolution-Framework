import { cp, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshotDiff, runIsolatedGit } from '@maf/git-ops';
import type { GoldenTask } from './GoldenTask.js';
import { assertGoldenCorpus } from './GoldenTask.js';
import { checkUnmodified, runVerifiers } from './verifiers.js';
import type { VerifierContext, VerifierOutcome } from './verifiers.js';
import { computeCorpusSha } from './corpusSha.js';
import type { JudgeDisclosure } from './judge.js';

export interface AttemptResult {
  attempt: number;
  output: string;
  outcomes: VerifierOutcome[];
  passed: boolean;
  error?: string;
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
  tasks: GoldenTaskResult[];
  /** Task ids that passed. */
  solvedTaskIds: string[];
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
}

export class GoldenRunner {
  constructor(private readonly opts: GoldenRunnerOptions) {}

  async loadCorpus(): Promise<GoldenTask[]> {
    const text = await readFile(path.join(this.opts.corpusRoot, 'corpus.json'), 'utf8');
    const parsed: unknown = JSON.parse(text);
    assertGoldenCorpus(parsed);
    return parsed;
  }

  /** Runs the corpus, or only the tasks named in `only` (each must be in the corpus). */
  async run(only?: readonly string[]): Promise<GoldenSuiteResult> {
    const corpus = await this.loadCorpus();
    const corpusSha = await computeCorpusSha(this.opts.corpusRoot, corpus);
    const missing = (only ?? []).filter((id) => !corpus.some((t) => t.id === id));
    if (missing.length > 0) {
      throw new Error(`goldens: task(s) ${missing.join(', ')} are not in the corpus at ${this.opts.corpusRoot}.`);
    }
    const tasks: GoldenTaskResult[] = [];
    for (const task of corpus) {
      if (only && !only.includes(task.id)) continue;
      tasks.push(await this.runTask(task));
    }
    return {
      harnessSha: this.opts.harnessSha,
      harnessId: this.opts.harnessId,
      corpusSha,
      attempts: this.attempts(),
      adapter: this.opts.adapter,
      ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
      ...(this.opts.llmJudge ? { judge: this.opts.llmJudge.disclosure } : {}),
      tasks,
      solvedTaskIds: tasks.filter((t) => t.passed).map((t) => t.taskId),
      ranAt: new Date().toISOString(),
    };
  }

  private async runTask(task: GoldenTask): Promise<GoldenTaskResult> {
    const attempts: AttemptResult[] = [];
    const k = this.attempts();
    for (let i = 0; i < k; i++) {
      attempts.push(await this.runAttempt(task, i));
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

  private async runAttempt(task: GoldenTask, attempt: number): Promise<AttemptResult> {
    const workRoot = await mkdtemp(path.join(tmpdir(), 'maf-golden-'));
    const workDir = path.join(workRoot, 'repo');
    const fixtureDir = path.join(this.opts.corpusRoot, task.repoFixture);
    try {
      await cp(fixtureDir, workDir, { recursive: true });
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
      const outcomes = [...protectedFiles, ...await runVerifiers(task.verifiers, {
        workDir, output, diff, corpusRoot: this.opts.corpusRoot,
        ...(this.opts.securityScore ? { securityScore: this.opts.securityScore } : {}),
        ...(this.opts.llmJudge ? { llmJudge: this.opts.llmJudge.verdict } : {}),
      })];
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
