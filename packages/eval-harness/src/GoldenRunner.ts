import { cp, mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GoldenTask } from './GoldenTask.js';
import { assertGoldenCorpus } from './GoldenTask.js';
import { runVerifiers } from './verifiers.js';
import type { VerifierContext, VerifierOutcome } from './verifiers.js';

const execFileAsync = promisify(execFile);

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
  securityScore?: VerifierContext['securityScore'];
  llmJudge?: VerifierContext['llmJudge'];
}

export class GoldenRunner {
  constructor(private readonly opts: GoldenRunnerOptions) {}

  async loadCorpus(): Promise<GoldenTask[]> {
    const text = await readFile(path.join(this.opts.corpusRoot, 'corpus.json'), 'utf8');
    const parsed: unknown = JSON.parse(text);
    assertGoldenCorpus(parsed);
    return parsed;
  }

  async run(): Promise<GoldenSuiteResult> {
    const corpus = await this.loadCorpus();
    const tasks: GoldenTaskResult[] = [];
    for (const task of corpus) {
      tasks.push(await this.runTask(task));
    }
    return {
      harnessSha: this.opts.harnessSha,
      harnessId: this.opts.harnessId,
      tasks,
      solvedTaskIds: tasks.filter((t) => t.passed).map((t) => t.taskId),
      ranAt: new Date().toISOString(),
    };
  }

  private async runTask(task: GoldenTask): Promise<GoldenTaskResult> {
    const attempts: AttemptResult[] = [];
    const k = this.opts.attempts ?? 2;
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

  private async runAttempt(task: GoldenTask, attempt: number): Promise<AttemptResult> {
    const workRoot = await mkdtemp(path.join(tmpdir(), 'maf-golden-'));
    const workDir = path.join(workRoot, 'repo');
    try {
      await cp(path.join(this.opts.corpusRoot, task.repoFixture), workDir, { recursive: true });
      const baseline = await initBaselineRepo(workDir);
      const output = await this.opts.dispatch(task, workDir, {
        temperature: this.opts.temperature ?? 0,
        timeoutMs: this.opts.timeoutMs ?? 120_000,
      });
      const diff = await computeDiff(workDir, baseline);
      const outcomes = await runVerifiers(task.verifiers, {
        workDir, output, diff, corpusRoot: this.opts.corpusRoot,
        ...(this.opts.securityScore ? { securityScore: this.opts.securityScore } : {}),
        ...(this.opts.llmJudge ? { llmJudge: this.opts.llmJudge } : {}),
      });
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
 * Every git call the runner makes runs with the host's configuration switched off:
 * global hooks (core.hooksPath), init.templateDir and any diff.external would otherwise
 * run inside a golden repo, and the score would depend on whose machine it ran on.
 * `-c` must precede the subcommand; the branch is pinned so a host
 * init.defaultBranch cannot change the baseline either.
 */
function gitIn(workDir: string) {
  return (args: string[]) => execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: workDir,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL:  '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
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

// Working-tree diff against the baseline commit. Two things here are load-bearing:
//
//  * the base is the RECORDED baseline, not HEAD. Diffing against HEAD would see nothing
//    at all from an agent that commits its own work — an empty diff that scores every
//    security verifier clean.
//  * a git failure is an ERROR, not an empty diff: "no repository" and "no changes" must
//    not be indistinguishable, because that indistinguishability IS the fail-open.
async function computeDiff(workDir: string, baseline: string): Promise<string> {
  const git = gitIn(workDir);
  const status = await git(['status', '--porcelain']).catch((err: unknown) => { throw notDiffable(workDir, err); });
  const diff = await git(['diff', baseline]).catch((err: unknown) => { throw notDiffable(workDir, err); });
  const untracked = status.stdout.split('\n').filter((l) => l.startsWith('?? ')).map((l) => `new file: ${l.slice(3)}`);
  return [diff.stdout, ...untracked].filter(Boolean).join('\n');
}

function notDiffable(workDir: string, err: unknown): Error {
  return new Error(
    `cannot compute the golden diff: no usable git repository at ${workDir} ` +
    `(git said: ${err instanceof Error ? err.message : String(err)})`,
  );
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
