import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolInput, ToolResult } from '@maf/types';
import { BaseTool } from '../ToolPlugin.js';
import { makeToolId } from '@maf/types';

const execFileAsync = promisify(execFile);

/**
 * How the git helper starts its child. Every git tool takes one, so a test can assert the argv and
 * environment a call produces without a repository; production uses `execFile`.
 */
export type GitExec = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const execGit: GitExec = (file, args, options) => execFileAsync(file, args, options);

/**
 * The base every git tool extends, so that none of them can reach git except through `git`
 * below and the environment it sets.
 */
export abstract class GitTool<I extends ToolInput> extends BaseTool<I> {
  constructor(protected readonly exec: GitExec = execGit) { super(); }
}

/** A model-supplied value as an error message should show it: strings and objects as JSON. */
function asWritten(value: unknown): string {
  return typeof value === 'string' || (typeof value === 'object' && value !== null)
    ? JSON.stringify(value)
    : String(value);
}

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

/**
 * The one list git.diff both declares and diffs. `paths` is the field; the legacy `path` is folded
 * into it here and nowhere else, because the two used to disagree: `declaredPaths` read `paths`
 * while `execute` read `path`, so policy approved one set of files and git diffed another.
 */
function diffPaths(input: DiffInput): string[] {
  const named = [...(Array.isArray(input.paths) ? input.paths : []), input.path];
  return [...new Set(named.filter((p): p is string => typeof p === 'string' && p !== ''))];
}

/**
 * Config pinned on git's command line ahead of every subcommand. Command-line config outranks
 * the repository's own and anything a parent exported, so a repository cannot turn these back on.
 *
 * - `core.hooksPath=/dev/null`: every hook git looks up becomes `/dev/null/<hook>`, which cannot
 *   exist, so none runs and git says nothing. A relative hooksPath in the user's config (husky's
 *   `.husky`) resolves in the working tree, where the agent writes — code it wrote would run
 *   outside every gate (F12).
 * - `core.fsmonitor=`: the fsmonitor hook is chosen by this key, not by hooksPath, and runs on
 *   status, add, diff and commit. Empty rather than `false`: before git 2.36 the value is a
 *   program to run, and `false` would be one.
 * - `commit.gpgsign=false`: the agent's commit is not the user's to sign, and signing would run
 *   whatever `gpg.program` names.
 */
const ISOLATION_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '-c', 'commit.gpgsign=false'] as const;

/**
 * Host git config that arrives through the environment rather than a file: what `git -c` exports
 * to its children, the counted form of the same, and `GIT_CONFIG`, which points `git config` —
 * the identity lookup below — at a file of the host's choosing.
 */
const HOST_CONFIG_ENV = /^GIT_CONFIG(?:_PARAMETERS|_COUNT|_KEY_\d+|_VALUE_\d+)?$/;

/**
 * The environment every tool's git runs in: the host's, minus its git configuration. The same
 * policy as `runIsolatedGit` in `@maf/git-ops`, which MAF's own git calls use; restated rather than
 * imported because `tools` does not depend on `git-ops` (the edge would change the lockfile), the
 * tools must keep their injectable `GitExec`, and the agent's git also needs the prompt and
 * identity handling below.
 */
function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!HOST_CONFIG_ENV.test(key)) env[key] = value;
  return {
    ...env,
    GIT_CONFIG_GLOBAL:     '/dev/null',
    GIT_CONFIG_NOSYSTEM:   '1',
    // Nothing here can answer a prompt; a credential or passphrase request fails instead of hanging.
    GIT_TERMINAL_PROMPT:   '0',
    // Literal pathspecs: a path the model names is a file name to git, as it is to policy. With
    // pathspec magic on, a declared `*.env` matches no rule written for `.env` and stages `.env`.
    GIT_LITERAL_PATHSPECS: '1',
  };
}

async function git(args: string[], cwd: string, exec: GitExec): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await exec('git', [...ISOLATION_ARGS, ...args], { cwd, env: isolatedEnv() });
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

// ── git.status ────────────────────────────────────────────────────────────────

export class GitStatusTool extends GitTool<Record<string, never>> {
  readonly id: ToolId = makeToolId('git.status');
  readonly name = 'git.status';
  readonly description = 'Show the working tree status (staged, unstaged, untracked files).';
  readonly permissionLevel = 'read' as const;

  /** No path argument: operates on the repository as a whole. */
  declaredPaths(): string[] { return []; }

  async execute(_: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const r = await git(['status', '--porcelain=v2', '--branch'], ctx.cwd, this.exec);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code, duration: performance.now() - t, metadata: {} };
  }
}

// ── git.diff ──────────────────────────────────────────────────────────────────

/** `path` is the legacy spelling of a one-element `paths`; `diffPaths` merges the two. */
interface DiffInput { staged?: boolean; paths?: string[]; path?: string; [k: string]: unknown }

export class GitDiffTool extends GitTool<DiffInput> {
  readonly id: ToolId = makeToolId('git.diff');
  readonly name = 'git.diff';
  readonly description = 'Show diffs of unstaged or staged changes.';
  readonly permissionLevel = 'read' as const;

  declaredPaths(input: DiffInput): string[] { return diffPaths(input); }

  async execute(input: DiffInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const args = ['diff'];
    if (input.staged) args.push('--staged');
    const paths = diffPaths(input);
    if (paths.length > 0) args.push('--', ...paths);
    const r = await git(args, ctx.cwd, this.exec);
    return { ...r, exitCode: r.code, duration: performance.now() - t, metadata: {} };
  }
}

// ── git.add ───────────────────────────────────────────────────────────────────

interface AddInput { paths: string[]; [k: string]: unknown }

export class GitAddTool extends GitTool<AddInput> {
  readonly id: ToolId = makeToolId('git.add');
  readonly name = 'git.add';
  readonly description = 'Stage files for commit.';
  readonly permissionLevel = 'write' as const;

  declaredPaths(input: AddInput): string[] { return namedPaths(input); }

  async execute(input: AddInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const r = await git(['add', '--', ...input.paths], ctx.cwd, this.exec);
    return { ...r, exitCode: r.code, duration: performance.now() - t, metadata: {} };
  }
}

// ── git.commit ────────────────────────────────────────────────────────────────

interface CommitInput { message: string; allowEmpty?: boolean; [k: string]: unknown }

/** Who commits where the repository does not say: the identity `@maf/git-ops` commits a run as. */
const FALLBACK_IDENTITY = { 'user.name': 'maf', 'user.email': 'maf@maf.invalid' } as const;

/**
 * `-c` pairs naming maf for each of `user.name` and `user.email` the repository leaves unset.
 * With the host's config off, a repository that relied on the user's global identity has none,
 * and git would refuse the commit or invent one from the hostname. A key the repository does set
 * is left alone — the commit is made as the repository's identity, which is what the security
 * gate reviews — and the fallback is per call, never written to the repository's config.
 */
async function fallbackIdentity(cwd: string, exec: GitExec): Promise<string[]> {
  // `-z` records are `key\nvalue\0`; a valueless key has no `\n`. Exit 1 means none is set.
  const r = await git(['config', '-z', '--get-regexp', '^user\\.(name|email)$'], cwd, exec);
  const configured = new Map<string, string>();
  for (const record of r.stdout.split('\0')) {
    const nl = record.indexOf('\n');
    // Later records overwrite earlier ones: git uses a key's last value.
    if (nl > 0) configured.set(record.slice(0, nl), record.slice(nl + 1));
  }
  return Object.entries(FALLBACK_IDENTITY)
    .flatMap(([key, value]) => (configured.get(key) ? [] : ['-c', `${key}=${value}`]));
}

export class GitCommitTool extends GitTool<CommitInput> {
  readonly id: ToolId = makeToolId('git.commit');
  readonly name = 'git.commit';
  readonly description = 'Create a git commit with the staged changes.';
  readonly permissionLevel = 'write' as const;

  /** Commits whatever is staged. The staged set is not in the input, so it is not declared here. */
  declaredPaths(): string[] { return []; }

  async execute(input: CommitInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const args = [...await fallbackIdentity(ctx.cwd, this.exec), 'commit', '-m', input.message];
    if (input.allowEmpty) args.push('--allow-empty');
    const r = await git(args, ctx.cwd, this.exec);
    // Extract commit hash from output like "[branch abc1234]"
    const hashMatch = /\[[\w/]+ ([0-9a-f]+)\]/.exec(r.stdout);
    return { ...r, exitCode: r.code, duration: performance.now() - t, metadata: { hash: hashMatch?.[1] } };
  }
}

// ── git.log ───────────────────────────────────────────────────────────────────

interface LogInput { n?: number; oneline?: boolean; [k: string]: unknown }

export class GitLogTool extends GitTool<LogInput> {
  readonly id: ToolId = makeToolId('git.log');
  readonly name = 'git.log';
  readonly description = 'Show recent git commits.';
  readonly permissionLevel = 'read' as const;

  declaredPaths(): string[] { return []; }

  async execute(input: LogInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    // Checked against what arrives, not what the type promises: `-${n}` with n = "-output=/tmp/x"
    // is `--output=/tmp/x`, which git obeys by writing the log to that file.
    const n: unknown = input.n === undefined ? 10 : input.n;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
      throw new Error(`git.log expects "n" to be a positive whole number of commits, but got ${asWritten(input.n)}.`);
    }
    const args = ['log', `-${n}`];
    if (input.oneline !== false) args.push('--oneline');
    const r = await git(args, ctx.cwd, this.exec);
    return { ...r, exitCode: r.code, duration: performance.now() - t, metadata: {} };
  }
}

// ── git.reset ─────────────────────────────────────────────────────────────────

interface ResetInput { to: string; hard?: boolean; [k: string]: unknown }

/**
 * The revisions git.reset accepts: a hex object name, `HEAD` with at most one `~N` or `^N` step,
 * or a branch or tag name. Narrower than git's own grammar on purpose — no `@{…}`, `:path` or
 * leading `-` — because `to` comes from the model and only has to name a commit to roll back to.
 */
const REVISION = /^(?:[0-9a-f]{4,64}|HEAD(?:[~^][0-9]*)?|[A-Za-z0-9._/][A-Za-z0-9._/-]*)$/;

export class GitResetTool extends GitTool<ResetInput> {
  readonly id: ToolId = makeToolId('git.reset');
  readonly name = 'git.reset';
  readonly description = 'Reset HEAD to a specific commit. Use hard=true to discard working tree changes.';
  readonly permissionLevel = 'dangerous' as const;

  /** `to` is a revision, not a path. */
  declaredPaths(): string[] { return []; }

  async execute(input: ResetInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const to: unknown = input.to;
    if (typeof to !== 'string' || !REVISION.test(to)) {
      throw new Error(
        `git.reset expects "to" to be a commit hash, HEAD, HEAD~N, HEAD^N, or a branch or tag name ` +
        `that does not start with "-", but got ${asWritten(input.to)}.`,
      );
    }
    // A trailing `--` as well as the pattern: git then reads `to` as a revision by position
    // even if the pattern is ever widened to something a file could be named. (`--end-of-options`
    // would say the same thing, but `git reset` only accepts it from 2.44; the separator works
    // on every git maf supports.)
    const args = ['reset', input.hard ? '--hard' : '--soft', to, '--'];
    const r = await git(args, ctx.cwd, this.exec);
    return { ...r, exitCode: r.code, duration: performance.now() - t, metadata: {} };
  }
}
