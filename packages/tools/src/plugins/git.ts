import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool } from '../ToolPlugin.js';
import { makeToolId } from '@maf/types';

const execFileAsync = promisify(execFile);

/**
 * The paths a git subcommand names explicitly. The rest of these tools operate on the
 * repository as a whole (commit takes whatever is staged, reset takes a revision), which is
 * not a path surface — they declare `[]` for the same reason `test.run` does: inventing a
 * path would make a path rule deny a call that never names one.
 */
function namedPaths(input: { paths?: unknown; path?: unknown }): string[] {
  if (Array.isArray(input.paths)) return input.paths.filter((p): p is string => typeof p === 'string' && p !== '');
  if (typeof input.path === 'string' && input.path) return [input.path];
  return [];
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await execFileAsync('git', args, { cwd });
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

// ── git.status ────────────────────────────────────────────────────────────────

export class GitStatusTool extends BaseTool<Record<string, never>> {
  readonly id: ToolId = makeToolId('git.status');
  readonly name = 'git.status';
  readonly description = 'Show the working tree status (staged, unstaged, untracked files).';
  readonly permissionLevel = 'read' as const;

  /** No path argument: operates on the repository as a whole. */
  declaredPaths(): string[] { return []; }

  async execute(_: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const r = await git(['status', '--porcelain=v2', '--branch'], ctx.cwd);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code, duration: performance.now() - t, metadata: {} };
  }
}

// ── git.diff ──────────────────────────────────────────────────────────────────

interface DiffInput { staged?: boolean; path?: string; [k: string]: unknown }

export class GitDiffTool extends BaseTool<DiffInput> {
  readonly id: ToolId = makeToolId('git.diff');
  readonly name = 'git.diff';
  readonly description = 'Show diffs of unstaged or staged changes.';
  readonly permissionLevel = 'read' as const;

  declaredPaths(input: DiffInput): string[] { return namedPaths(input); }

  async execute(input: DiffInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const args = ['diff'];
    if (input.staged) args.push('--staged');
    if (input.path) args.push('--', input.path);
    const r = await git(args, ctx.cwd);
    return { ...r, exitCode: r.code, duration: performance.now() - t, metadata: {} };
  }
}

// ── git.add ───────────────────────────────────────────────────────────────────

interface AddInput { paths: string[]; [k: string]: unknown }

export class GitAddTool extends BaseTool<AddInput> {
  readonly id: ToolId = makeToolId('git.add');
  readonly name = 'git.add';
  readonly description = 'Stage files for commit.';
  readonly permissionLevel = 'write' as const;

  declaredPaths(input: AddInput): string[] { return namedPaths(input); }

  async execute(input: AddInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const r = await git(['add', '--', ...input.paths], ctx.cwd);
    return { ...r, exitCode: r.code, duration: performance.now() - t, metadata: {} };
  }
}

// ── git.commit ────────────────────────────────────────────────────────────────

interface CommitInput { message: string; allowEmpty?: boolean; [k: string]: unknown }

export class GitCommitTool extends BaseTool<CommitInput> {
  readonly id: ToolId = makeToolId('git.commit');
  readonly name = 'git.commit';
  readonly description = 'Create a git commit with the staged changes.';
  readonly permissionLevel = 'write' as const;

  /** Commits whatever is staged. The staged set is not in the input, so it is not declared here. */
  declaredPaths(): string[] { return []; }

  async execute(input: CommitInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const args = ['commit', '-m', input.message];
    if (input.allowEmpty) args.push('--allow-empty');
    const r = await git(args, ctx.cwd);
    // Extract commit hash from output like "[branch abc1234]"
    const hashMatch = /\[[\w/]+ ([0-9a-f]+)\]/.exec(r.stdout);
    return { ...r, exitCode: r.code, duration: performance.now() - t, metadata: { hash: hashMatch?.[1] } };
  }
}

// ── git.log ───────────────────────────────────────────────────────────────────

interface LogInput { n?: number; oneline?: boolean; [k: string]: unknown }

export class GitLogTool extends BaseTool<LogInput> {
  readonly id: ToolId = makeToolId('git.log');
  readonly name = 'git.log';
  readonly description = 'Show recent git commits.';
  readonly permissionLevel = 'read' as const;

  declaredPaths(): string[] { return []; }

  async execute(input: LogInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const args = ['log', `-${input.n ?? 10}`];
    if (input.oneline !== false) args.push('--oneline');
    const r = await git(args, ctx.cwd);
    return { ...r, exitCode: r.code, duration: performance.now() - t, metadata: {} };
  }
}

// ── git.reset ─────────────────────────────────────────────────────────────────

interface ResetInput { to: string; hard?: boolean; [k: string]: unknown }

export class GitResetTool extends BaseTool<ResetInput> {
  readonly id: ToolId = makeToolId('git.reset');
  readonly name = 'git.reset';
  readonly description = 'Reset HEAD to a specific commit. Use hard=true to discard working tree changes.';
  readonly permissionLevel = 'dangerous' as const;

  /** `to` is a revision, not a path. */
  declaredPaths(): string[] { return []; }

  async execute(input: ResetInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const args = ['reset', input.hard ? '--hard' : '--soft', input.to];
    const r = await git(args, ctx.cwd);
    return { ...r, exitCode: r.code, duration: performance.now() - t, metadata: {} };
  }
}
