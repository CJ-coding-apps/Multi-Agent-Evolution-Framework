import { spawnSync } from 'node:child_process';
import {
  closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
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
 * Everything one declaration or one apply shares across its git calls: the file holding the bytes,
 * the directory those calls run in, and the empty git directory that keeps configuration out.
 *
 * It exists so that no call can be built differently from another. The declaration and the apply
 * read the same file, run in the same directory, and are given the same `-p`, because they are
 * handed the same value rather than each constructing its own.
 */
interface SealedGit {
  /** The 0600 file holding the diff. Every call in this invocation is handed this absolute path. */
  readonly file: string;
  /** The worktree every call is run against; also the child's working directory. */
  readonly cwd: string;
  /** A git directory with no config, so no filter, hook or fsmonitor is defined anywhere git looks. */
  readonly gitDir: string;
  readonly strip: number;
}

/**
 * A git directory with nothing in it: `HEAD`, no `config`, no objects.
 *
 * Pointing every call at one is what keeps repository configuration out of the apply. A filter
 * driver is defined in configuration (`filter.<name>.clean`), so a git directory with no config
 * defines none, and an agent-written `.gitattributes` can select exactly nothing. Neither can a
 * hook or an fsmonitor run: neither can be named. `git apply` needs no index, and it is told the
 * worktree separately, so an empty directory is a complete answer.
 *
 * The layout is written rather than produced by `git init`, because this module spawns `git` in
 * one place only — a second spawn to build the sandbox would be one more thing that can differ.
 */
function emptyGitDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'maf-gitdir-'));
  mkdirSync(path.join(dir, 'objects'));
  mkdirSync(path.join(dir, 'refs'));
  writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/maf-apply\n', { mode: 0o600 });
  return dir;
}

/** Writes the diff once, 0600, in a private directory, and builds the empty git directory. */
function openSealedDiff(diff: string, strip: number, worktree: string | null): SealedGit {
  const dir = mkdtempSync(path.join(tmpdir(), 'maf-patch-'));
  const file = path.join(dir, 'diff.patch');
  const gitDir = emptyGitDir();
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, diff, undefined, 'utf8');
  } finally {
    closeSync(fd);
  }
  // A declaration names paths and touches nothing, so the diff's own directory is the worktree it
  // is resolved against; an apply names the directory it will write into.
  return { file, cwd: worktree === null ? dir : path.resolve(worktree), gitDir, strip };
}

function closeSealedDiff(sealed: SealedGit): void {
  rmSync(path.dirname(sealed.file), { recursive: true, force: true });
  rmSync(sealed.gitDir, { recursive: true, force: true });
}

function withSealedDiff<T>(
  diff: string,
  strip: number,
  worktree: string | null,
  fn: (sealed: SealedGit) => T,
): T {
  const sealed = openSealedDiff(diff, strip, worktree);
  try {
    return fn(sealed);
  } finally {
    closeSealedDiff(sealed);
  }
}

/** `withSealedDiff` for a callback that has to await: the sandbox outlives the whole call. */
async function withSealedDiffAsync<T>(
  diff: string,
  strip: number,
  worktree: string | null,
  fn: (sealed: SealedGit) => Promise<T>,
): Promise<T> {
  const sealed = openSealedDiff(diff, strip, worktree);
  try {
    return await fn(sealed);
  } finally {
    closeSealedDiff(sealed);
  }
}

/**
 * The environment every git call gets.
 *
 * `toolEnv()` keeps maf's own variables out — `MAF_*`, provider tokens, and the host's
 * `GIT_DIR`/`GIT_*`. The rest is what seals the repository:
 *
 *  - `GIT_DIR` is the empty throwaway directory, so no `filter.*` or any other setting reaches the
 *    apply, whatever the worktree's `.git/config` says;
 *  - `GIT_WORK_TREE` is the worktree, so a patch path is relative to it and not to the directory
 *    the child happens to run in. `--numstat` used to run in `tmpdir()`, and when that directory sat
 *    inside some repository git prefixed every path with the subdirectory — the declaration and the
 *    write then named different files;
 *  - `GIT_CEILING_DIRECTORIES` is the worktree's parent, the rule `runIsolatedGit` uses, so no
 *    discovery can climb out of it;
 *  - the system and global config files are off, so a user's `apply.whitespace` or a filter driver
 *    in `$HOME/.gitconfig` cannot change the bytes written.
 */
function sealedEnv(sealed: SealedGit): NodeJS.ProcessEnv {
  return {
    ...toolEnv(),
    PWD: sealed.cwd,
    GIT_DIR: sealed.gitDir,
    GIT_WORK_TREE: sealed.cwd,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CEILING_DIRECTORIES: path.dirname(sealed.cwd),
  };
}

/**
 * The one place a git invocation is built. Every call — `--numstat`, `-R --numstat`, `--summary`,
 * `--check` and the apply itself — is given the same environment, the same `-c` overrides, the same
 * `-p` and the same diff file. Nothing else in this module spawns git.
 *
 * The three `-c` overrides are set in addition to the empty git directory, not instead of it: they
 * pin the same settings `runIsolatedGit` pins, so a future caller that passes a real `GIT_DIR` still
 * gets no hook and no fsmonitor.
 */
function runGitApply(sealed: SealedGit, args: readonly string[]): GitResult {
  const r = spawnSync('git', [
    '-c', `core.hooksPath=${devNull}`,
    '-c', 'core.fsmonitor=false',
    '-c', `core.attributesFile=${devNull}`,
    'apply', `-p${sealed.strip}`, ...args, sealed.file,
  ], { cwd: sealed.cwd, env: sealedEnv(sealed), encoding: 'utf8', maxBuffer: MAX_OUTPUT });
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
    `patch.apply refuses this diff: ${detail} The call is refused rather than run, and nothing is `
    + 'written, because a write the policy did not approve is not an allowed one.',
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

/** The names `git apply --numstat -z` reports for this diff, forward or with `-R`. */
function numstatPaths(sealed: SealedGit, reverse: boolean): string[] {
  const flag = reverse ? '-R ' : '';
  const r = runGitApply(sealed, [...(reverse ? ['-R'] : []), '--numstat', '-z']);
  if (r.status !== 0) {
    throw refusal(
      `git apply ${flag}--numstat could not read it (${gitFailure(r)}). patch.apply applies with `
      + 'git, so a diff git cannot parse is one it cannot declare or write.',
    );
  }
  const entries = r.stdout.split('\0').filter((entry) => entry !== '');
  if (entries.length === 0) {
    throw refusal(
      'git apply --numstat reported no files, so no path rule can cover what the call would do. '
      + 'Use a unified diff whose headers name the files.',
    );
  }
  return entries.map(numstatPath);
}

/**
 * The forms `--summary` names that a path list cannot describe, refused by their own name.
 *
 * `--numstat` gives only the new name for a rename, so a protected file could be renamed away while
 * the policy was asked about its destination. Copies, mode changes and symlink or submodule creation
 * change the tree in ways a list of paths does not describe. Creating a regular file — including one
 * with the executable bit (`create mode 100755 run.sh`) — is not one of them: it is a path write, and
 * the file list is the whole story. Creating an executable is allowed on purpose; an agent that
 * writes a script writes a script.
 */
function refuseSummaryForms(sealed: SealedGit): void {
  const summary = runGitApply(sealed, ['--summary']);
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
}

/**
 * A section header git does not read is a section git does not apply — and `git apply` exits 0
 * having skipped it, so the agent is told its whole diff applied.
 *
 * Only what can *be* a section start is refused: an indented `--- ` line immediately followed by a
 * `+++ ` line at the same indent, or an indented `diff --git ` line. The first pattern used to refuse
 * any indented `--- `/`+++ `/`diff --git ` line anywhere, and a hunk body is a space followed by the
 * file's own text — so a YAML file whose unchanged lines are ` --- # Source: chart/a.yaml` (what
 * `helm template` emits) could not be patched at all. A context pair that quotes a diff's own
 * `---`/`+++` lines is still refused, because those bytes are identical to an indented section.
 *
 * The pattern only ever refuses; it never names a file. It is deliberately matched anywhere in the
 * diff, because where a section starts is exactly what the parser was wrong about before.
 */
const INDENTED_SECTION = /^([ \tX]+)--- [^\n]*\n\1\+\+\+ |^[ \tX]+diff --git /m;

function refuseIndentedSection(diff: string): void {
  const match = INDENTED_SECTION.exec(diff);
  if (match !== null) {
    throw refusal(
      `it has an indented section header (${JSON.stringify(match[0].trim())}). git applies the `
      + 'unindented part of a diff and silently ignores an indented one, so the call would apply some '
      + 'of what the diff names and report success. Every section must start at the beginning of a line.',
    );
  }
}

/**
 * The files a diff touches, from `git apply` itself, in both directions.
 *
 * This is still the one-parser design: the tool does not read headers. `--numstat -z` names the
 * files git will write for the same bytes and the same `-p`, so the checked set and the written set
 * cannot differ by spelling. What the forward list alone does not describe is a section whose old
 * and new names differ: `diff --git a/.env b/notes.txt` with no rename header deletes `.env` and
 * writes `notes.txt`, and `--numstat` names only the destination. `-R --numstat` names the old side,
 * and a non-rename patch names the same files both ways; creation and deletion give the same name
 * both ways too, because only the counts swap. So a name that appears on only one side is a rename
 * or a copy that did not say so, and it is refused.
 *
 * Nothing here writes: `--numstat` and `--summary` parse the patch and do not touch the tree.
 */
function declaredFromGit(sealed: SealedGit, diff: string): string[] {
  refuseIndentedSection(diff);
  refuseSummaryForms(sealed);
  const forward = numstatPaths(sealed, false);
  const reverse = numstatPaths(sealed, true);
  // Compared as sets, not by position: `-R` reports the sections of a multi-file patch in its own
  // order, so an ordinary two-file diff legitimately gives the same names in a different sequence
  // (measured: forward `README, Cargo.lock`, reversed `Cargo.lock, README`). What must hold is that
  // every name on one side is also on the other. (Two swapped renames would pass, and that is safe:
  // both names are then declared and written, so the policy is asked about all of them.)
  const forwardSet = new Set(forward);
  const reverseSet = new Set(reverse);
  const onlyNew = forward.filter((name) => !reverseSet.has(name));
  const onlyOld = reverse.filter((name) => !forwardSet.has(name));
  if (onlyNew.length > 0 || onlyOld.length > 0) {
    throw refusal(
      `git names ${JSON.stringify(onlyOld[0] ?? '(nothing)')} on the old side and `
      + `${JSON.stringify(onlyNew[0] ?? '(nothing)')} on the new. A section whose two names differ is `
      + 'a rename or a copy, even without a rename header, and git reports only the new side: a '
      + 'protected file could be moved away while the policy was asked about its destination. Use '
      + 'fs.move for a rename, and a diff for content.',
    );
  }
  // The union, so the declaration is every name either direction reported, whatever a rename
  // header might have said. For an ordinary diff the two lists are the same list.
  return [...new Set([...forward, ...reverse])];
}

/** The strip the command will be given, one value for both the declaration and the argv. */
function stripOf(input: PatchInput): number {
  return typeof input.strip === 'number' && Number.isInteger(input.strip) && input.strip >= 0 ? input.strip : 1;
}

/**
 * `lstat`, with the two "there is nothing here" errors read as no entry: `ENOENT` (the name does not
 * exist) and `ENOTDIR` (a prefix is a regular file, so nothing can exist below it — git fails on that
 * with its own message). Any other error is a refusal naming it: a path that cannot be checked for a
 * symbolic link is not one this tool will write through. A component over the name limit (256 bytes
 * on APFS) gives `ENAMETOOLONG`, which used to escape `execute` as a raw `Error`.
 */
function lstatOrRefuse(target: string, declared: string): Stats | undefined {
  try {
    return lstatSync(target, { throwIfNoEntry: false });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    const detail = err instanceof Error ? err.message : String(err);
    throw refusal(
      `it would write ${JSON.stringify(declared)}, and checking that path failed (${detail}). A path `
      + 'that cannot be checked for a symbolic link is refused rather than assumed safe.',
    );
  }
}

/**
 * A plain unified diff with no mode lines rewrites an existing symlink *in place*: the new content
 * becomes its target. `--summary` reports nothing for that, and the declared name is the link, which
 * the policy resolves as the file it points at today — so `link -> README` could be repointed at
 * `.env` while the policy was asked about `README`. patch.apply does not write to or through a link:
 * any declared name that is one now, or that reaches the name through one, is refused here.
 *
 * Every prefix is checked, not just the last component: `d -> src` makes `d/x.js` a write through a
 * link, and git's "affected file is beyond a symbolic link" refused it only after the policy had
 * allowed it. `cfg -> .maf` and `out -> <outside the root>` are the same shape.
 *
 * It runs at declaration time (where `ctx` is given) and again in `execute`: the gate records a
 * `Deny` rather than an Allow that the call then fails under, and the second pass covers a link
 * created between the two.
 */
function refuseSymlinkTargets(root: string, paths: readonly string[]): void {
  for (const p of paths) {
    const segments = p.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      const stat = lstatOrRefuse(path.join(root, prefix), p);
      if (stat === undefined) break;                 // nothing here, so nothing below it either
      if (stat.isSymbolicLink()) {
        const through = prefix === p ? '' : ` through ${JSON.stringify(prefix)}`;
        throw refusal(
          `it would write ${JSON.stringify(p)}${through}, which is a symbolic link. git rewrites a `
          + 'link in place, so the write would land wherever the link points rather than at the name '
          + 'the policy was shown. Remove the link, or patch the file it points at by that file\'s own name.',
        );
      }
      if (!stat.isDirectory()) break;                // a regular file has nothing below it
    }
  }
}

/**
 * The paths the policy approved must be the paths the apply writes, by check.
 *
 * `declaredPaths` produces the gate's set, and `execute` produces its own in the sealed context it
 * is about to write from. They are the same bytes and the same `-p` in an equivalent sealed context,
 * so they agree today — this makes that a check rather than an assumption. A name on one side and
 * not the other, in either direction, refuses the call before `--check` and before anything is
 * written: an approval is of a set of paths, and a call that would write a different set was never
 * approved. Compared as sorted lists, so a difference in order is not a difference, and a repeated
 * name is.
 *
 * Raised as a `ToolDeclarationError` like every other declaration refusal — `executeToolGated`
 * records it as a `Deny` under `builtin:declaration` — but not through `refusal()`: that helper says
 * the policy was never asked, which is false here. It was asked, about a different set.
 */
function refuseApprovedDifference(approved: readonly string[] | undefined, declared: readonly string[]): void {
  if (approved === undefined) return;
  const left = [...approved].sort();
  const right = [...declared].sort();
  if (left.length === right.length && left.every((p, i) => p === right[i])) return;
  throw new ToolDeclarationError(
    `patch.apply refused this call: the policy approved ${JSON.stringify(left)}, and in the context `
    + `this call would write in, the same diff declares ${JSON.stringify(right)}. The paths the policy `
    + 'approves must be the paths the apply writes, so a call whose two declarations differ is refused, '
    + 'and nothing was written.',
  );
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
   * A pure function of the diff and the tree under it — the same value the policy layer is handed,
   * computed the same way every time — and no longer a second parser. `git apply --numstat -z` names
   * the files git itself will write, in both directions, so the declaration cannot disagree with the
   * apply by reading a header spelling differently.
   *
   * With `ctx` it runs in a sealed context at the worktree root, which is where `execute` runs; without
   * one (a direct caller) it names paths only and uses a private directory, which git cannot observe
   * through an empty `GIT_DIR`. The gate passes `ctx`, so the policy's declaration is computed where
   * the apply will be, and a declared name that is a symlink now is refused as a verdict rather than
   * earning an Allow that `execute` then declines.
   */
  declaredPaths(input: PatchInput, ctx?: ToolContext): string[] {
    if (typeof input.diff !== 'string') {
      // The gate checks the schema first; a direct caller gets the same answer: no diff, no declaration,
      // and no call.
      throw new ToolDeclarationError(
        'patch.apply can only declare the files a diff touches when it is given a `diff` string, and this '
        + 'call has none, so no path rule can cover it.',
      );
    }
    const worktree = ctx === undefined ? null : ctx.projectRoot;
    const paths = withSealedDiff(input.diff, stripOf(input), worktree, (sealed) => declaredFromGit(sealed, input.diff));
    // Before policy, as fs.write does: a diff that touches .git is refused whatever the rules say.
    refuseGitDirPaths(this.name, paths);
    if (ctx !== undefined) refuseSymlinkTargets(ctx.projectRoot, paths);
    return paths;
  }

  async execute(input: PatchInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const unusable = this.unusable(input, t);
    if (unusable !== undefined) return unusable;

    // Declared here as well as at the gate: a direct caller gets the same refusals, the paths the
    // apply runs against are the paths this call itself read from git, and — via `ctx.approvedPaths` —
    // they must be the paths the policy approved. The declaration and the write share one sealed
    // context — the same diff file, the same directory, the same environment — so the git that names
    // the files is the git that writes them.
    const outcome = await withSealedDiffAsync(input.diff, stripOf(input), ctx.projectRoot, async (sealed) => {
      const declared = declaredFromGit(sealed, input.diff);
      refuseApprovedDifference(ctx.approvedPaths, declared);
      refuseGitDirPaths(this.name, declared);
      await refuseGitDirTargets(this.name, ctx, declared);
      refuseSymlinkTargets(ctx.projectRoot, declared);

      // Check first, and apply only what passed: a multi-file diff that fails one file changes
      // nothing. git apply is all-or-nothing without `--reject`, and no `--reject` is passed.
      const check = runGitApply(sealed, ['--check']);
      if (check.status !== 0) return { declared, result: check };
      if (input.dryRun) {
        return {
          declared,
          result: { status: 0, stdout: `checked ${declared.length} file(s)`, stderr: '' } satisfies GitResult,
        };
      }
      return { declared, result: runGitApply(sealed, []) };
    });

    const result = outcome.result;
    return {
      stdout: result.stdout,
      stderr: result.stderr || result.error || '',
      exitCode: typeof result.status === 'number' ? result.status : 1,
      duration: performance.now() - t,
      metadata: { dryRun: input.dryRun ?? false },
    };
  }
}
