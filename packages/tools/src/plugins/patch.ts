import { spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync, writeSync,
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

/** Which declared files a diff creates and which it deletes, as `--summary` classifies them. */
interface SummaryKinds {
  readonly created: ReadonlySet<string>;
  readonly deleted: ReadonlySet<string>;
}

/**
 * The forms `--summary` names that a path list cannot describe, refused by their own name; and, for
 * the forms it allows, which files are created and which deleted.
 *
 * `--numstat` gives only the new name for a rename, so a protected file could be renamed away while
 * the policy was asked about its destination. Copies, mode changes and symlink or submodule creation
 * change the tree in ways a list of paths does not describe. Creating a regular file — including one
 * with the executable bit (`create mode 100755 run.sh`) — is not one of them: it is a path write, and
 * the file list is the whole story. Creating an executable is allowed on purpose; an agent that
 * writes a script writes a script.
 *
 * `-z` turns off git's path quoting, so a `create`/`delete` line names the file exactly as `--numstat
 * -z` does — the same bytes, the same `-p` — and the two sets key against the declared names. They are
 * what tells a creation that replaces a directory (git empties it, then writes) from a modification
 * aimed at a directory (a silent no-op), and a prefix a diff deletes before it writes beneath it.
 */
function summaryForms(sealed: SealedGit): SummaryKinds {
  const summary = runGitApply(sealed, ['--summary', '-z']);
  if (summary.status !== 0) {
    throw refusal(`git apply --summary could not read it (${gitFailure(summary)}).`);
  }
  const created = new Set<string>();
  const deleted = new Set<string>();
  // git indents each summary line with one leading space; the filename runs to the end of the line,
  // so it is captured without trimming the tail (a trailing space is part of the name, not padding).
  for (const line of summary.stdout.split('\n').filter((l) => l !== '')) {
    if (/^\s*(rename|copy|mode change)\b/.test(line) || /\bmode (120000|160000)\b/.test(line)) {
      throw refusal(
        `git reports ${JSON.stringify(line.trim())}. patch.apply refuses renames, copies, mode changes, `
        + 'symlinks and submodules: the file list git reports for them does not describe everything '
        + 'the apply changes. Use fs.move for a rename, and a diff for content.',
      );
    }
    const kind = /^\s*create mode \S+ (.+)$/.exec(line);
    if (kind !== null) { created.add(safePath(kind[1]!)); continue; }
    const gone = /^\s*delete mode \S+ (.+)$/.exec(line);
    if (gone !== null) deleted.add(safePath(gone[1]!));
  }
  return { created, deleted };
}

/**
 * The diff's line grammar, checked before git is asked.
 *
 * `git apply` reads the sections it understands and silently skips the rest, exiting 0 — an indented
 * `---`/`+++` pair, a line of preamble where a header belongs, a context diff's `***` header — so the
 * patch "applies" and the agent is told its whole diff landed. Every such shape used to need its own
 * pattern, and a pattern is only a list of the shapes someone thought of. This is the other
 * direction: every line must be one git reads, and one that is not refuses the call and names itself.
 *
 * A hunk is read by its counts, as git reads one. That is what keeps a content line that looks like a
 * header from being mistaken for one: `--- a/Cargo.lock` inside a hunk is a removed line whose text
 * begins `-- `, and it is a body line exactly because the hunk still expects one. Between hunks a line
 * must be a section header, a git extended header, a hunk header, or blank; inside a hunk, a body line,
 * with `\ No newline at end of file` allowed after the last of them. An empty line inside a hunk is the
 * blank context git reads it as — a context line with no content — and counts against both sides. A
 * lone carriage return between files is the blank separator a CRLF diff writes, and is accepted there.
 *
 * The grammar must accept what git applies in full, so a `diff <options> <a> <b>` command line (as
 * `diff -ruN` writes) is a header that names nothing — the names come from the `---`/`+++` pair — and
 * every `diff ` header is read, not only `diff --git`.
 *
 * A `GIT binary patch` marker is refused wherever it appears (R4-H2). Its payload is not
 * line-structured, so letting it through would let a binary section hide any lines that follow it from
 * the grammar; a binary patch has no readable hunks and no line counts to describe in any case.
 *
 * Only git's own output is read: a commit-message preamble or a context diff is refused, not
 * interpreted. The tool promises a unified diff.
 */
const SECTION_HEADER =
  /^(?:diff |--- |\+\+\+ |Index: |index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const HUNK_BODY = /^[ +\-\\]/;
const BINARY_MARKER = 'GIT binary patch';

/** The line as the refusal shows it, short enough that a whole file's worth is not one message. */
function shownLine(line: string): string {
  return JSON.stringify(line.length > 60 ? `${line.slice(0, 60)}…` : line);
}

function refuseBrokenGrammar(diff: string): void {
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();          // the final newline is not a line

  let state: 'header' | 'hunk' | 'tail' = 'header';
  let oldLeft = 0;
  let newLeft = 0;
  const broken = (n: number, line: string, why: string): never => {
    throw refusal(`it is not a diff git reads in full: line ${n} is ${shownLine(line)}, ${why}. git `
      + 'applies the parts of a diff it understands and silently skips the rest, exiting 0, so a diff '
      + 'this tool could not read to its end would be reported as applied in full. Every line of the '
      + 'diff must be one git reads.');
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1;

    // A binary marker is refused wherever it appears: its payload is not line-structured, so a
    // binary section left to pass through could hide every line after it from this grammar.
    if (line === BINARY_MARKER) {
      throw refusal(`line ${n} is a ${JSON.stringify(BINARY_MARKER)} marker. A binary patch has no `
        + 'readable hunks and no line counts to describe, and letting its payload through would hide the '
        + 'lines after it from this check, so the marker is refused wherever it appears.');
    }

    if (state === 'hunk') {
      if (line.startsWith('\\')) continue;                    // "\ No newline at end of file"
      if (line === '') {                                      // git reads an empty line as blank context
        oldLeft--; newLeft--;
      } else if (HUNK_BODY.test(line)) {
        const marker = line[0];
        if (marker === ' ' || marker === '-') oldLeft--;
        if (marker === ' ' || marker === '+') newLeft--;
      } else {
        broken(n, line, 'and a hunk expects a body line where it still counts lines');
      }
      if (oldLeft < 0 || newLeft < 0) broken(n, line, 'and that is more lines than its hunk header counts');
      if (oldLeft === 0 && newLeft === 0) state = 'tail';
      continue;
    }

    if (state === 'tail') {
      if (line.startsWith('\\')) continue;                    // the marker may follow the last body line
      state = 'header';                                       // anything else ends the hunk
    }

    if (line === '' || line === '\r') continue;               // a blank line between files (CRLF: a lone CR)
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      state = oldLeft === 0 && newLeft === 0 ? 'tail' : 'hunk';
      continue;
    }
    if (SECTION_HEADER.test(line)) continue;
    broken(n, line, 'and that is neither a section header, a hunk header nor a hunk line');
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
 *
 * The result carries the `--summary` creation/deletion sets alongside the declared paths, because the
 * symlink-and-parent walk needs them: a prefix the diff deletes is not a parent to refuse under, and a
 * declared name that is an existing directory is a silent no-op git exits 0 on.
 */
interface Declaration {
  readonly paths: string[];
  readonly kinds: SummaryKinds;
}

function declaredFromGit(sealed: SealedGit, diff: string): Declaration {
  refuseBrokenGrammar(diff);
  const kinds = summaryForms(sealed);
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
  return { paths: [...new Set([...forward, ...reverse])], kinds };
}

/** The strip the command will be given, one value for both the declaration and the argv. */
function stripOf(input: PatchInput): number {
  return typeof input.strip === 'number' && Number.isInteger(input.strip) && input.strip >= 0 ? input.strip : 1;
}

/**
 * `lstat`, with "there is nothing here" — `ENOENT`, the name does not exist — read as no entry.
 * `ENOTDIR` is a refusal, not an absence: it means a component above the name is a regular file, and
 * that is a patch git cannot apply in full (see `refuseSymlinkTargets`). Any other error is a
 * refusal naming it too: a path that cannot be checked for a symbolic link is not one this tool will
 * write through. A component over the name limit (256 bytes on APFS) gives `ENAMETOOLONG`, which used
 * to escape `execute` as a raw `Error`.
 */
function lstatOrRefuse(target: string, declared: string): Stats | undefined {
  try {
    return lstatSync(target, { throwIfNoEntry: false });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw refusal(
      `it would write ${JSON.stringify(declared)}, and checking that path failed (${detail}). A path `
      + 'that cannot be checked is refused rather than assumed writable.',
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
 * The same walk refuses a parent that exists and is *not* a directory — `README/x` where `README` is
 * a regular file. `--check` passes on it, because the diff parses; the apply then fails partway
 * through, after a multi-file patch has already changed or deleted the files before it (measured: the
 * other file deleted, exit 128). This is refused here — one of the shapes this walk can see that git
 * would otherwise fail partway after `--check`. The shapes it cannot see are restored: every declared
 * path is recorded before the apply, and a failed apply puts them all back, so a failed call changed
 * nothing. The declared path itself may be a regular file: that is an
 * ordinary write to it. The exception is a prefix the *same diff deletes* — `x` (a file) deleted while
 * `x/y` is created: git removes `x` first, then writes beneath it, and the whole patch applies
 * (measured: exit 0, `x` becomes a directory). A deleted prefix is skipped and the walk stops there,
 * because git recreates everything below it fresh.
 *
 * It also refuses a declared name that is itself an existing directory and is neither created nor
 * deleted by the diff — a hunk aimed at a directory. `git apply --check` passes, and the apply exits
 * 0 having written nothing (measured: `warning: unable to rmdir`, exit 0), so the agent is told the
 * hunk landed when the tree is unchanged. A creation whose name is a directory is left to git, which
 * either applies in full (the directory's whole contents are deleted in the same diff) or fails with a
 * non-zero exit (a sibling remains) — not a silent success either way.
 *
 * It runs at declaration time (where `ctx` is given) and again in `execute`: the gate records a
 * `Deny` rather than an Allow that the call then fails under, and the second pass covers a link
 * created between the two.
 */
function refuseSymlinkTargets(root: string, paths: readonly string[], kinds: SummaryKinds): void {
  for (const p of paths) {
    const segments = p.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      const stat = lstatOrRefuse(path.join(root, prefix), p);
      if (stat === undefined) break;                 // nothing here, so nothing below it either
      if (i < segments.length && kinds.deleted.has(prefix)) break;   // git deletes it, then writes beneath
      if (stat.isSymbolicLink()) {
        const through = prefix === p ? '' : ` through ${JSON.stringify(prefix)}`;
        throw refusal(
          `it would write ${JSON.stringify(p)}${through}, which is a symbolic link. git rewrites a `
          + 'link in place, so the write would land wherever the link points rather than at the name '
          + 'the policy was shown. Remove the link, or patch the file it points at by that file\'s own name.',
        );
      }
      if (i === segments.length) {                   // the declared name itself
        if (stat.isDirectory() && !kinds.created.has(p) && !kinds.deleted.has(p)) {
          throw refusal(
            `it would write ${JSON.stringify(p)}, which is an existing directory. A hunk aimed at a `
            + 'directory passes git apply --check and then exits 0 having written nothing, so the apply '
            + 'would be reported as landed while the tree is unchanged. Name the file inside the directory.',
          );
        }
        break;                                       // a regular file here is an ordinary write
      }
      if (!stat.isDirectory()) {
        throw refusal(
          `it would write ${JSON.stringify(p)}, and ${JSON.stringify(prefix)} is a regular file rather `
          + 'than a directory above it. git passes --check on that and then fails partway through the '
          + 'apply, after the files before it have been written, so a patch that cannot apply in full '
          + 'is refused here and nothing is written.',
        );
      }
    }
  }
}

/**
 * One name — a declared path, or a parent of one — as the tree held it before the apply.
 *
 * `absent` is a name that did not exist: a file the diff creates, or a directory the apply would
 * have to create. `bytes` and `mode` are the whole of a regular file's identity for this purpose;
 * a symlink is recorded by its target because the walk above refuses one at a declared name, and a
 * restore that cannot rebuild what it found would not be a restore.
 */
interface PathSnapshot {
  readonly path:  string;
  readonly kind:  'absent' | 'file' | 'directory' | 'symlink';
  readonly bytes?: Buffer;
  readonly mode?:  number;
  readonly target?: string;
}

/**
 * What the tree holds at every declared path and every parent of one, before git writes anything.
 *
 * A declared path alone is not enough. `x` is a file and the diff deletes it and creates `x/y`: the
 * apply turns `x` into a directory, and undoing that means removing `x/y` *and* the directory `x`
 * before `x` can be written back as a file. Recording every prefix gives the restore that order,
 * and the prefixes that did not exist are exactly the directories the apply creates — the ones a
 * failed call has to remove again.
 *
 * A name that cannot be read refuses the call before anything is written: an apply this tool could
 * not undo is not one it makes. A FIFO, socket or device at a declared name is refused the same
 * way, by the `isFile` test at the end.
 */
function snapshotDeclared(root: string, declared: readonly string[]): PathSnapshot[] {
  const entries = new Map<string, PathSnapshot>();
  const record = (relative: string): void => {
    if (entries.has(relative)) return;
    const absolute = path.join(root, relative);
    let stat: Stats | undefined;
    try {
      stat = lstatSync(absolute, { throwIfNoEntry: false });
    } catch (err: unknown) {
      // `ENOTDIR` is a component above the name being a regular file, and `ENOENT` a parent removed
      // between the walk and here. Neither names anything today: a component that is a file cannot
      // contain this name, and the shapes that legitimately reach the apply in that state are the
      // ones where the same diff deletes that file (`x` deleted, `x/y` created) — absent is right,
      // and the restore removes whatever the apply puts there.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR' || code === 'ENOENT') {
        entries.set(relative, { path: relative, kind: 'absent' });
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new ToolDeclarationError(
        `patch.apply refused this call: it would write ${JSON.stringify(relative)}, and recording that `
        + `path before the apply failed (${detail}). A write this tool cannot undo is not one it makes, `
        + 'so nothing was written.',
      );
    }
    if (stat === undefined) { entries.set(relative, { path: relative, kind: 'absent' }); return; }
    if (stat.isSymbolicLink()) {
      entries.set(relative, { path: relative, kind: 'symlink', target: readlinkSync(absolute) });
      return;
    }
    if (stat.isDirectory()) { entries.set(relative, { path: relative, kind: 'directory' }); return; }
    if (!stat.isFile()) {
      throw new ToolDeclarationError(
        `patch.apply refused this call: ${JSON.stringify(relative)} is not a regular file, a directory `
        + 'or a symlink, and this tool cannot record what a write to it would replace, so nothing was '
        + 'written.',
      );
    }
    entries.set(relative, {
      path: relative, kind: 'file', bytes: readFileSync(absolute), mode: stat.mode & 0o7777,
    });
  };
  for (const p of declared) {
    const segments = p.split('/');
    for (let i = 1; i <= segments.length; i++) record(segments.slice(0, i).join('/'));
  }
  return [...entries.values()];
}

/**
 * Puts every snapshotted name back, and removes what the apply created.
 *
 * Deepest first, so a file the apply turned into a directory is emptied from the bottom up; then
 * files and directories are written back shallowest first. A name whose kind is unchanged is left
 * in place in the first pass and rewritten in the second, because its content may have changed.
 *
 * Returns the names it could not restore rather than throwing: a failure here must not replace the
 * apply's own error, and the caller reports both. An empty array means the tree is as it was.
 */
function restoreTree(root: string, entries: readonly PathSnapshot[]): string[] {
  const depth = (p: string): number => p.split('/').length;
  const failures: string[] = [];
  const note = (p: string, err: unknown): void => {
    failures.push(`${JSON.stringify(p)} (${err instanceof Error ? err.message : String(err)})`);
  };

  for (const entry of [...entries].sort((a, b) => depth(b.path) - depth(a.path))) {
    const absolute = path.join(root, entry.path);
    try {
      const now = lstatSync(absolute, { throwIfNoEntry: false });
      if (now === undefined) continue;
      const sameKind =
        (entry.kind === 'file' && now.isFile())
        || (entry.kind === 'directory' && now.isDirectory())
        || (entry.kind === 'symlink' && now.isSymbolicLink());
      if (entry.kind === 'absent' || !sameKind) rmSync(absolute, { recursive: true, force: true });
    } catch (err) { note(entry.path, err); }
  }

  for (const entry of [...entries].sort((a, b) => depth(a.path) - depth(b.path))) {
    if (entry.kind === 'absent') continue;
    const absolute = path.join(root, entry.path);
    try {
      if (entry.kind === 'directory') { mkdirSync(absolute, { recursive: true }); continue; }
      mkdirSync(path.dirname(absolute), { recursive: true });
      if (entry.kind === 'symlink') {
        rmSync(absolute, { force: true });
        symlinkSync(entry.target!, absolute);
        continue;
      }
      writeFileSync(absolute, entry.bytes!);
      chmodSync(absolute, entry.mode!);
    } catch (err) { note(entry.path, err); }
  }
  return failures;
}

/** The apply's own failure, plus what the restore did, as the stderr an agent and a bundle read. */
function withRestoreNote(result: GitResult, unrestored: readonly string[]): GitResult {
  const note = unrestored.length === 0
    ? 'patch.apply: the apply failed part-way; every declared path was restored, so the tree is as it '
      + 'was before the call.'
    : 'patch.apply: the apply failed part-way and the restore could not put back '
      + `${unrestored.join('; ')}. Report this to the operator before trying again.`;
  return { ...result, stderr: [result.stderr.trimEnd(), note].filter((line) => line !== '').join('\n') };
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
 * A call that arrives with no approved set at all is refused too. It did not come from
 * `executeToolGated` — a caller that is not the gate, or a test calling `execute` directly — and a
 * write nothing approved is not an allowed one. `approvedPaths` is what the gate sets on the context
 * it hands `execute`, so its absence is a call to write on a path the gate never opened.
 *
 * Raised as a `ToolDeclarationError` like every other declaration refusal — `executeToolGated`
 * records it as a `Deny` under `builtin:declaration` — but not through `refusal()`: that helper says
 * the policy was never asked, which is false when the two sets differ. It was asked, about a
 * different set.
 */
function refuseApprovedDifference(approved: readonly string[] | undefined, declared: readonly string[]): void {
  // `== null` covers both `undefined` (no field) and a literal `null` (a caller that set the field to
  // nothing): either is "no approved set", and spreading it would be a raw TypeError rather than the
  // refusal the gate records.
  if (approved == null) {
    throw new ToolDeclarationError(
      'patch.apply refused this call: it arrived without the paths the policy approved, so there is '
      + `nothing to compare the ${declared.length} path(s) this apply would write against. A write is `
      + 'made through the gate, on the paths the gate approved; a call that names no approved set is '
      + 'refused, and nothing was written.',
    );
  }
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
    const { paths, kinds } = withSealedDiff(input.diff, stripOf(input), worktree, (sealed) => declaredFromGit(sealed, input.diff));
    // Before policy, as fs.write does: a diff that touches .git is refused whatever the rules say.
    refuseGitDirPaths(this.name, paths);
    if (ctx !== undefined) refuseSymlinkTargets(ctx.projectRoot, paths, kinds);
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
      const { paths: declared, kinds } = declaredFromGit(sealed, input.diff);
      refuseApprovedDifference(ctx.approvedPaths, declared);
      refuseGitDirPaths(this.name, declared);
      await refuseGitDirTargets(this.name, ctx, declared);
      refuseSymlinkTargets(ctx.projectRoot, declared, kinds);

      // Check first, and apply only what passed: all-or-nothing for everything `--check` verifies,
      // since no `--reject` is passed. `--check` does not model the sections before it, so a
      // structural conflict can pass the check and fail mid-apply, after earlier sections wrote —
      // the `x`/`x/y` and `x/y`/`x/y/z` shapes, and a file over a non-empty directory. Every declared
      // path (and every parent of one) is recorded before the apply, and a failed apply restores
      // them, so a call that fails is a call that changed nothing.
      const check = runGitApply(sealed, ['--check']);
      if (check.status !== 0) return { declared, result: check };
      if (input.dryRun) {
        return {
          declared,
          result: { status: 0, stdout: `checked ${declared.length} file(s)`, stderr: '' } satisfies GitResult,
        };
      }
      const snapshots = snapshotDeclared(ctx.projectRoot, declared);
      const applied = runGitApply(sealed, []);
      if (applied.status === 0) return { declared, result: applied };
      return { declared, result: withRestoreNote(applied, restoreTree(ctx.projectRoot, snapshots)) };
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
