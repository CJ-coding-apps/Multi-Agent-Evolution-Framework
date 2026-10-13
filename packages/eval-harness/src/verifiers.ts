import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type { VerifierRef } from './GoldenTask.js';

const execFileAsync = promisify(execFile);

export interface VerifierOutcome {
  /** A verifier's kind, or 'must-not-modify' for the task's protected-file check. */
  kind: VerifierRef['kind'] | 'must-not-modify';
  passed: boolean;
  detail: string;
}

/** Inputs a verifier may need; provided by the runner shell, consumed as data. */
export interface VerifierContext {
  /** Task working directory (fixture copy / worktree). */
  workDir: string;
  /** The run's textual output (final assistant text). */
  output: string;
  /** Working-tree diff vs. the fixture's initial state (may be empty). */
  diff: string;
  /** Security scorer (severity-ordered worst finding), injected by the shell. */
  securityScore?: (diff: string) => Promise<'none' | 'low' | 'medium' | 'high' | 'critical'>;
  /** LLM judge (rubric text, subject text) → pass/fail with rationale. Injected; last resort. */
  llmJudge?: (rubric: string, subject: string) => Promise<{ passed: boolean; rationale: string }>;
  /** Corpus root for resolving rubricFile. */
  corpusRoot: string;
}

const SEVERITY_ORDER = ['none', 'low', 'medium', 'high', 'critical'] as const;

function severityAtMost(worst: string, max: 'none' | 'low' | 'medium'): boolean {
  const w = SEVERITY_ORDER.indexOf(worst as (typeof SEVERITY_ORDER)[number]);
  const m = SEVERITY_ORDER.indexOf(max);
  return w >= 0 && w <= m;
}

export async function runVerifier(v: VerifierRef, ctx: VerifierContext): Promise<VerifierOutcome> {
  switch (v.kind) {
    case 'test-script': {
      try {
        await execFileAsync(v.command, v.args, { cwd: ctx.workDir, maxBuffer: 4 * 1024 * 1024 });
        return { kind: v.kind, passed: true, detail: `${v.command} exited 0` };
      } catch (err) {
        const code = (err as { code?: number }).code;
        return { kind: v.kind, passed: false, detail: `${v.command} exited ${code ?? 'error'}` };
      }
    }
    case 'security-gate': {
      if (!ctx.securityScore)
        return { kind: v.kind, passed: false, detail: 'no securityScore provider wired' };
      const worst = await ctx.securityScore(ctx.diff);
      const passed = severityAtMost(worst, v.maxSeverity);
      return { kind: v.kind, passed, detail: `worst=${worst} allowed=${v.maxSeverity}` };
    }
    case 'diff-match': {
      const missing = v.mustContain.filter((s) => !ctx.diff.includes(s));
      const forbidden = v.mustNotContain.filter((s) => ctx.diff.includes(s));
      const passed = missing.length === 0 && forbidden.length === 0;
      const parts: string[] = [];
      if (missing.length) parts.push(`missing: ${missing.join(' | ')}`);
      if (forbidden.length) parts.push(`forbidden present: ${forbidden.join(' | ')}`);
      return { kind: v.kind, passed, detail: passed ? 'diff matches' : parts.join('; ') };
    }
    case 'llm-judge': {
      if (!ctx.llmJudge)
        return { kind: v.kind, passed: false, detail: 'no llmJudge wired' };
      const rubric = await readFile(path.join(ctx.corpusRoot, v.rubricFile), 'utf8');
      const verdict = await ctx.llmJudge(rubric, ctx.output);
      return { kind: v.kind, passed: verdict.passed, detail: verdict.rationale };
    }
  }
}

export async function runVerifiers(vs: VerifierRef[], ctx: VerifierContext): Promise<VerifierOutcome[]> {
  const outcomes: VerifierOutcome[] = [];
  for (const v of vs) outcomes.push(await runVerifier(v, ctx));
  return outcomes;
}

/** A file's bytes, or null when it is absent; a symlink counts as a change in its own right. */
async function snapshot(file: string): Promise<Buffer | 'symlink' | null> {
  try {
    if ((await lstat(file)).isSymbolicLink()) return 'symlink';
    return await readFile(file);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The protected-file check (`mustNotModify`): each path must be byte-identical to the pristine
 * fixture — not edited, deleted, created or swapped for a link. It runs before the verifiers,
 * since a test script may itself write to the tree.
 */
export async function checkUnmodified(workDir: string, fixtureDir: string, paths: readonly string[]): Promise<VerifierOutcome> {
  const changed: string[] = [];
  for (const p of paths) {
    const [before, after] = [await snapshot(path.join(fixtureDir, p)), await snapshot(path.join(workDir, p))];
    const same = before === null || before === 'symlink'
      ? before === after
      : Buffer.isBuffer(after) && before.equals(after);
    if (!same) changed.push(p);
  }
  return changed.length === 0
    ? { kind: 'must-not-modify', passed: true, detail: `unchanged: ${paths.join(', ')}` }
    : { kind: 'must-not-modify', passed: false, detail: `protected file(s) modified: ${changed.join(', ')}` };
}
