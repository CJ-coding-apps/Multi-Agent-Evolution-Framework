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
      const output = await this.opts.dispatch(task, workDir, {
        temperature: this.opts.temperature ?? 0,
        timeoutMs: this.opts.timeoutMs ?? 120_000,
      });
      const diff = await computeDiff(workDir);
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

/** Working-tree diff vs fixture initial state; empty when not a git repo (tasks may self-init). */
async function computeDiff(workDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: workDir });
    if (!stdout.trim()) return '';
    const diff = await execFileAsync('git', ['diff', 'HEAD'], { cwd: workDir, maxBuffer: 8 * 1024 * 1024 });
    const untracked = stdout.split('\n').filter((l) => l.startsWith('?? ')).map((l) => `new file: ${l.slice(3)}`);
    return [diff.stdout, ...untracked].filter(Boolean).join('\n');
  } catch {
    return '';
  }
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
