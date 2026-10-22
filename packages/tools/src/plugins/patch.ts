import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool, closedInput } from '../ToolPlugin.js';
import { makeToolId, resolveInside, ToolDeclarationError, toolEnv } from '@maf/types';
import { gitDirRefusal, namesGitDir, refuseGitDirPaths } from './fs.js';

interface PatchInput {
  diff:    string;
  strip?:  number;
  dryRun?: boolean;
  [k: string]: unknown;
}

/** A patch and a diff can both be large; the default child-process buffer is 1 MB. */
const MAX_OUTPUT = 64 * 1024 * 1024;

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Runs `git apply` on `diff`, with the diff written once to a 0600 file in a private directory.
 *
 * The declaration and the apply read the same bytes because they both hand `git apply` the file
 * this writes — never a re-serialised copy of the model's argument. `toolEnv()` keeps the child
 * to the allowlist (no `GIT_DIR`/`GIT_CONFIG_*` from the ambient environment, no maf secrets), and
 * the two `-c` overrides stop a repository setting from running hooks or an fsmonitor process.
 *
 * Synchronous on purpose: `declaredPaths` is called by the gate before policy, and its signature
 * is synchronous for every tool. A local `git apply --numstat` is the price of one parser, and it
 * is measured in milliseconds.
 */
function withDiffFile<T>(diff: string, cwd: string, fn: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'maf-patch-'));
  const file = path.join(dir, 'diff.patch');
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, diff, undefined, 'utf8');
  } finally {
    closeSync(fd);
  }
  try {
    return fn(file);
  } finally {
    try { unlinkSync(file); } catch { /* the call already answered */ }
    try { rmdirSync(dir); } catch { /* ditto */ }
  }
}

function runGitApply(args: readonly string[], file: string, cwd: string): GitResult {
  const r = spawnSync('git', [
    '-c', `core.hooksPath=${devNull}`,
    '-c', 'core.fsmonitor=false',
    'apply', ...args, file,
  ], { cwd, env: toolEnv(), encoding: 'utf8', maxBuffer: MAX_OUTPUT });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(r.error !== undefined ? { error: r.error.message } : {}),
  };
}

/** The reason a git invocation failed, as one line an agent (and an attestation) can read. */
function gitFailure(r: GitResult): string {
  const detail = (r.stderr.trim() || r.error || `exit status ${r.status ?? 'none'}`).replace(/\s+/g, ' ');
  return detail;
}

function refusal(detail: string): ToolDeclarationError {
  return new ToolDeclarationError(
    `patch.apply refuses this diff: ${detail} The call is refused before the policy is asked, because `
    + 'an undeclared write is not an allowed one.',
  );
}

/**
 * The path a diff names, as git reported it, made safe to compare:
 * repeated slashes collapsed, `.` dropped, and absolute or `..` names refused.
 *
 * git refuses those itself at apply time, but only after the policy was asked about a string no
 * rule describes. Refusing here is earlier and names the reason.
 */
function safePath(raw: string): string {
  const collapsed = raw.replace(/\/{2,}/g, '/');
  if (collapsed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(collapsed)) {
    throw refusal(
      `git would write ${JSON.stringify(raw)}, an absolute path. A patch may only name files inside `
      + 'the project root, and an absolute name has no root-relative form a policy glob could cover.',
    );
  }
  const segments = collapsed.split('/');
  if (segments.includes('..')) {
    throw refusal(
      `git would write ${JSON.stringify(raw)}, which contains "..". A patch may only name files inside `
      + 'the project root; a path with ".." is resolved against the working directory and can leave it.',
    );
  }
  const clean = segments.filter((s) => s !== '' && s !== '.').join('/');
  if (clean === '') {
    throw refusal(`git reported ${JSON.stringify(raw)} as a file name, and that names no file.`);
  }
  return clean;
}

/**
 * One `--numstat -z` entry: `<added>\t<deleted>\t<path>`. `-` in either count is a binary patch,
 * which has no readable hunks and no line counts to describe; it is refused.
 */
function numstatPath(entry: string): string {
  const fields = /^([^\t]*)\t([^\t]*)\t([\s\S]+)$/.exec(entry);
  if (fields === null) {
    throw refusal(`git apply --numstat printed ${JSON.stringify(entry)}, which is not a file entry.`);
  }
  const [, added, deleted, raw] = fields;
  if (added === '-' || deleted === '-') {
    throw refusal(
      `git reports a binary patch for ${JSON.stringify(raw)}. A binary patch has no line counts and no `
      + 'readable hunks, so the declaration would not describe what git writes.',
    );
  }
  return safePath(raw!);
}

/**
 * The files a diff touches, from `git apply` itself.
 *
 * This is the one parser fix: the tool no longer reads headers, because every header spelling
 * GNU patch accepts was a chance for the declaration and the apply to disagree, and five separate
 * spellings were still open after the first attempt. The policy is asked about exactly the paths
 * `git apply --numstat -z` reports for the same bytes and the same `-p`, so the checked set and
 * the written set cannot differ.
 *
 * `--summary` is read too, and a diff that renames, copies, changes a mode, or creates a symlink
 * or submodule is refused: `--numstat` gives only the new name for a rename (so a protected file
 * could be renamed away undeclared), and the other forms change the tree in ways a path list does
 * not describe. Binary patches are refused from their `-` line counts. Creation and deletion of
 * regular files are allowed — for those the single name is the whole story.
 *
 * Nothing is applied here: `--numstat` and `--summary` parse the patch and do not touch the tree.
 * The gate calls this synchronously before policy, so every refusal is a `Deny` recorded under
 * `builtin:declaration`, and nothing runs.
 */
function declaredFromGit(diff: string, strip: number): string[] {
  const flags = ['--recount', `-p${strip}`];
  return withDiffFile(diff, tmpdir(), (file) => {
    const numstat = runGitApply([...flags, '--numstat', '-z'], file, tmpdir());
    if (numstat.status !== 0) {
      throw refusal(
        `git apply --numstat could not read it (${gitFailure(numstat)}). patch.apply applies with `
        + 'git, so a diff git cannot parse is one it cannot declare or write.',
      );
    }
    const entries = numstat.stdout.split('\0').filter((entry) => entry !== '');
    if (entries.length === 0) {
      throw refusal(
        'git apply --numstat reported no files, so no path rule can cover what the call would do. '
        + 'Use a unified diff whose headers name the files.',
      );
    }

    const summary = runGitApply([...flags, '--summary'], file, tmpdir());
    if (summary.status !== 0) {
      throw refusal(`git apply --summary could not read it (${gitFailure(summary)}).`);
    }
    for (const line of summary.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')) {
      if (/^(rename|copy|mode change)\b/.test(line) || /\bmode (120000|160000)\b/.test(line)) {
        throw refusal(
          `git reports ${JSON.stringify(line)}. patch.apply refuses renames, copies, mode changes, `
          + 'symlinks and submodules: the file list git reports for them does not describe everything '
          + 'the apply changes. Use fs.move for a rename, and a diff for content.',
        );
      }
    }

    const paths = entries.map(numstatPath);
    // The same bytes, the same `-p`: a name is declared once however many sections touch it.
    return [...new Set(paths)];
  });
}

/** The strip the command will be given, one value for both the declaration and the argv. */
function stripOf(input: PatchInput): number {
  return typeof input.strip === 'number' && Number.isInteger(input.strip) && input.strip >= 0 ? input.strip : 1;
}

/**
 * The resolved half of the `.git` refusal: a path whose spelling avoids `.git` but that resolves into
 * it through a link inside the root. A path that does not resolve inside the root is the policy
 * engine's to refuse (this tool is confined there only; see docs/SECURITY.md), so it is passed over.
 */
async function refuseGitDirTargets(tool: string, ctx: ToolContext, paths: readonly string[]): Promise<void> {
  for (const p of paths) {
    const relative = await resolveInside(ctx.projectRoot, p).then((c) => c.relative, () => undefined);
    if (relative !== undefined && namesGitDir(relative)) {
      throw gitDirRefusal(tool, p, `it resolves to ${JSON.stringify(relative)}, which is git's own data (.git)`);
    }
  }
}

export class PatchApplyTool extends BaseTool<PatchInput> {
  readonly id: ToolId = makeToolId('patch.apply');
  readonly name = 'patch.apply';
  readonly description = 'Apply a unified diff to the working tree with git apply. Use dryRun to verify before applying.';
  readonly permissionLevel = 'write' as const;
  readonly inputSchema = closedInput({
    diff:   { type: 'string', description: 'the unified diff to apply, with ---/+++ file headers' },
    strip:  { type: 'number', description: 'leading path components to strip from its file names, as git apply -p (default 1)' },
    dryRun: { type: 'boolean', description: 'check that the diff applies without changing anything (default false)' },
  }, ['diff']);

  /**
   * A pure function of the diff — the same value the policy layer is handed, computed the
   * same way every time — and no longer a second parser. `git apply --numstat -z` names the files
   * git itself will write, so the declaration cannot disagree with the apply by reading a header
   * spelling differently.
   */
  declaredPaths(input: PatchInput): string[] {
    if (typeof input.diff !== 'string') {
      // The gate checks the schema first; a direct caller gets the same answer: no diff, no declaration,
      // and no call.
      throw new ToolDeclarationError(
        'patch.apply can only declare the files a diff touches when it is given a `diff` string, and this '
        + 'call has none, so no path rule can cover it.',
      );
    }
    const paths = declaredFromGit(input.diff, stripOf(input));
    // Before policy, as fs.write does: a diff that touches .git is refused whatever the rules say.
    refuseGitDirPaths(this.name, paths);
    return paths;
  }

  async execute(input: PatchInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const unusable = this.unusable(input, t);
    if (unusable !== undefined) return unusable;
    // Declared here as well as at the gate: a direct caller gets the same refusals, and the paths
    // the apply is confirmed against are the paths this call itself read from git.
    const declared = this.declaredPaths(input);
    await refuseGitDirTargets(this.name, ctx, declared);

    const flags = ['--recount', `-p${stripOf(input)}`];
    const result = withDiffFile(input.diff, ctx.cwd, (file) => {
      // Check first, and apply only what passed: a multi-file diff that fails one file changes
      // nothing. git apply is all-or-nothing without `--reject`, and no `--reject` is passed.
      const check = runGitApply([...flags, '--check'], file, ctx.cwd);
      if (check.status !== 0) return check;
      if (input.dryRun) {
        return { status: 0, stdout: `checked ${declared.length} file(s)`, stderr: '' } satisfies GitResult;
      }
      return runGitApply(flags, file, ctx.cwd);
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr || result.error || '',
      exitCode: typeof result.status === 'number' ? result.status : 1,
      duration: performance.now() - t,
      metadata: { dryRun: input.dryRun ?? false },
    };
  }
}
