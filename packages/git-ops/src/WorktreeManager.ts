import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunId } from '@maf/types';
import { resolveInside } from '@maf/types';
import { MAF_RUNTIME_STATE, runIsolatedGit, snapshotDiff } from './SnapshotDiff.js';

/**
 * One run's own checkout (D-03): `<project>/.maf/worktrees/<runId>` on branch `maf/<runId>`,
 * started from the HEAD the user had when the run began. The run edits this, never the user's.
 */
export interface RunWorktree {
  readonly runId:      RunId;
  /** The worktree's root: `<project>/.maf/worktrees/<runId>`. */
  readonly path:       string;
  /** `maf/<runId>` — the only branch a run commits to, and the only one a rollback may reset. */
  readonly branch:     string;
  /** The commit the branch started from: the user's HEAD when the run began. */
  readonly baseCommit: string;
  /**
   * Where the run works: the worktree's counterpart of the directory maf was pointed at — `path`
   * itself at the repository top, `path/<sub>` when maf was pointed at `<repo>/<sub>`.
   */
  readonly cwd:        string;
}

export type FinishOutcome = 'success' | 'failure';

/**
 * What `finish` hands back. Only `merge` carries a command: `no-change` has nothing to merge, and
 * `refused` names the runtime-state paths the run committed — content the security gate's diff
 * leaves out (D-29), so merging it would take in what no gate saw.
 */
export type FinishResult =
  | { readonly kind: 'merge'; readonly mergeCommand: string; readonly path: string; readonly branch: string }
  | { readonly kind: 'no-change'; readonly path: string; readonly branch: string }
  | { readonly kind: 'refused'; readonly paths: readonly string[]; readonly path: string; readonly branch: string }
  | { readonly kind: 'failure'; readonly path: string; readonly branch: string };

/** A run id names a branch and a directory, so it is held to what is safe as both — never rewritten into it. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Written into `.maf/worktrees/` so the user's `git status` does not change: git treats each
 * worktree in there as an embedded repository and would list it as untracked. `*` covers this
 * file too. It is maf's own runtime directory, so this ignores nothing of the user's.
 */
const WORKTREES_GITIGNORE =
  '# Written by maf: each directory here is one run\'s git worktree (D-03) — runtime state.\n*\n';

/** Who commits what a successful run left uncommitted. `.invalid` so it can never be a real address. */
const RUN_COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'maf', GIT_AUTHOR_EMAIL: 'maf@maf.invalid',
  GIT_COMMITTER_NAME: 'maf', GIT_COMMITTER_EMAIL: 'maf@maf.invalid',
};

export function gitSaid(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await runIsolatedGit(cwd, args, env ? { env } : {});
  return stdout.trim();
}

/** A git predicate: exit 0 is true, exit 1 is false, anything else is an error. */
export async function gitTest(cwd: string, args: string[]): Promise<boolean> {
  try {
    await runIsolatedGit(cwd, args);
    return true;
  } catch (err: unknown) {
    if ((err as { code?: unknown }).code === 1) return false;
    throw err;
  }
}

/**
 * Proves `cwd` is inside the run's worktree *and* that git, run there, works on that worktree;
 * returns `cwd` symlink-resolved, which is what the caller must then run git in.
 *
 * The second half is not implied by the first. The worktree sits inside the user's checkout, so
 * if its `.git` link is gone (or an agent ran `git init` in a subdirectory) the repository git
 * finds from `cwd` is a different one — at worst the user's own, where a `reset --hard` would
 * discard their work.
 */
export async function assertInWorktree(cwd: string, worktreePath: string): Promise<string> {
  let confined;
  try {
    confined = await resolveInside(worktreePath, cwd);
  } catch (err: unknown) {
    throw new Error(`refusing to run git in ${cwd}: it is not inside the run's worktree ${worktreePath} (${gitSaid(err)}).`);
  }
  const top = await git(confined.absolute, ['rev-parse', '--show-toplevel']).then((top) => realpath(top)).catch(() => '(no repository)');
  if (top !== confined.root) {
    throw new Error(
      `refusing to run git in ${cwd}: git there works on the repository at ${top}, not on the run's ` +
      `worktree ${confined.root}. The worktree's .git link is missing or a nested repository is in the way.`,
    );
  }
  return confined.absolute;
}

/** Both halves of the rule a reset or a commit must meet: in the run's worktree, on the run's branch (D-03). */
export async function assertOnRunBranch(cwd: string, run: Pick<RunWorktree, 'path' | 'branch'>): Promise<string> {
  const inside = await assertInWorktree(cwd, run.path);
  const head = await git(inside, ['symbolic-ref', '-q', 'HEAD']).catch(() => '');
  if (head !== `refs/heads/${run.branch}`) {
    throw new Error(
      `refusing to change ${cwd}: expected its HEAD to be the run's branch ${run.branch}, but it is ` +
      `${head ? head.replace(/^refs\/heads\//, '') : 'detached'}. Resets and commits are permitted only ` +
      `on the run's own worktree branch (D-03).`,
    );
  }
  return inside;
}

/**
 * Creates, finishes and removes the worktree a run works in (D-03). MAF never modifies the user's
 * branch: the run commits to `maf/<runId>`, success hands the user a `git merge` command, failure
 * leaves the worktree for inspection, and nothing is deleted unless `remove` is called.
 */
export class WorktreeManager {
  private readonly runs = new Map<RunId, RunWorktree>();

  /** @param projectRoot the directory maf was pointed at — the one holding `.maf/`. */
  constructor(private readonly projectRoot: string) {}

  async createForRun(runId: RunId): Promise<RunWorktree> {
    const { wtPath, branch } = this.names(runId);
    const fail = (why: string) => new Error(`cannot create a worktree for run ${runId}: ${why}`);
    // `--show-prefix` is where the project sits in its repository; the run works at the same place in its worktree.
    const prefix = await git(this.projectRoot, ['rev-parse', '--show-prefix']).catch((err: unknown) => {
      throw fail(`${this.projectRoot} is not inside a git repository (git said: ${gitSaid(err)}). ` +
        `Run "git init" and commit, or run with --no-worktree to work in place.`);
    });
    if (!(await gitTest(this.projectRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))) {
      throw fail(`the repository at ${this.projectRoot} has no commits yet, and a run's branch starts ` +
        `from the current HEAD. Commit once, or run with --no-worktree to work in place.`);
    }
    if (await gitTest(this.projectRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
      throw fail(`the branch ${branch} already exists. A run never reuses a branch, because it would ` +
        `build on another run's work; delete it (git branch -D ${branch}) or use a new run id.`);
    }
    if (await lstat(wtPath).then(() => true, () => false)) {
      throw fail(`${wtPath} already exists; remove it or use a new run id.`);
    }
    const baseCommit = await git(this.projectRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const dir = path.dirname(wtPath);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.gitignore'), WORKTREES_GITIGNORE, { flag: 'wx' }).catch((err: unknown) => {
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err;
    });
    try {
      await runIsolatedGit(this.projectRoot, ['worktree', 'add', '--quiet', '-b', branch, wtPath, baseCommit]);
    } catch (err: unknown) {
      throw fail(`git worktree add failed (git said: ${gitSaid(err)}).`);
    }
    const cwd = path.resolve(wtPath, prefix);
    // A worktree holds only committed content: an untracked or ignored directory has no counterpart
    // there, and every later step of the run would fail in a directory that does not exist.
    if (!(await lstat(cwd).then((st) => st.isDirectory(), () => false))) {
      const undo = await runIsolatedGit(this.projectRoot, ['worktree', 'remove', '--force', wtPath])
        .then(() => runIsolatedGit(this.projectRoot, ['branch', '-D', branch]))
        .then(() => '', (err: unknown) => ` Removing the worktree and branch again also failed (git said: ${gitSaid(err)}).`);
      throw fail(`${this.projectRoot} has no committed files; commit it or run with --no-worktree.${undo}`);
    }
    const run: RunWorktree = { runId, path: wtPath, branch, baseCommit, cwd };
    this.runs.set(runId, run);
    return run;
  }

  /**
   * Ends a run without merging (D-03). Success commits what the run left uncommitted to its branch
   * — otherwise the merge command would carry none of it — and returns that command, unless the
   * branch is still at its base (`no-change`) or brings in runtime state (`refused`). Failure
   * changes nothing and returns the worktree's path for inspection. Neither removes anything.
   */
  async finish(runId: RunId, outcome: FinishOutcome): Promise<FinishResult> {
    const { wtPath, branch } = this.names(runId);
    if (outcome === 'failure') return { kind: 'failure', path: wtPath, branch };

    const baseCommit = this.runs.get(runId)?.baseCommit;
    if (!baseCommit) {
      throw new Error(`cannot finish run ${runId}: expected a worktree this manager created with createForRun, ` +
        `but it holds none for that run, so the commit the run started from is unknown.`);
    }
    const cwd = await assertOnRunBranch(wtPath, { path: wtPath, branch });
    const prefix = await git(this.projectRoot, ['rev-parse', '--show-prefix']);
    const runtimeState = MAF_RUNTIME_STATE.map((s) => `${prefix}.maf/${s}`);
    // The security gate's pathspec (D-29), so this commit adds nothing that the gate's diff leaves
    // out. It does not make the branch reviewed: what the run committed itself, or wrote after the
    // last gate, reaches it without passing through this filter — hence the check below.
    const pathspec = ['--', ':(top)', ...runtimeState.map((p) => `:(top,exclude)${p}`)];
    const env = { ...RUN_COMMIT_ENV, GIT_LITERAL_PATHSPECS: '0' };
    try {
      await runIsolatedGit(cwd, ['add', '-A', ...pathspec], { env });
      if (!(await gitTest(cwd, ['diff', '--cached', '--quiet']))) {
        await runIsolatedGit(cwd, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', `maf run ${runId}`], { env });
      }
    } catch (err: unknown) {
      throw new Error(`cannot commit the work run ${runId} left uncommitted in ${cwd} to ${branch} ` +
        `(git said: ${gitSaid(err)}). Nothing was merged; the worktree is kept as it was.`);
    }

    try {
      if (await git(cwd, ['rev-list', '--count', `${baseCommit}..HEAD`]) === '0') {
        return { kind: 'no-change', path: wtPath, branch };
      }
      const { stdout } = await runIsolatedGit(cwd, ['diff', '--name-only', '--no-renames', '-z', baseCommit, 'HEAD', '--',
        ...runtimeState.map((p) => `:(top)${p}`)], { env: { GIT_LITERAL_PATHSPECS: '0' } });
      const paths = stdout.split('\0').filter(Boolean);
      if (paths.length > 0) return { kind: 'refused', paths, path: wtPath, branch };
    } catch (err: unknown) {
      throw new Error(`cannot compare ${branch} with the commit run ${runId} started from (${baseCommit.slice(0, 12)}) ` +
        `in ${cwd} (git said: ${gitSaid(err)}). Nothing was merged; the worktree is kept as it was.`);
    }
    return { kind: 'merge', mergeCommand: `git merge ${branch}`, path: wtPath, branch };
  }

  /**
   * Deletes the run's worktree, uncommitted work included, its branch and the `maf/<runId>-<task>`
   * branches `BranchIsolator` made for it. Only ever on request.
   */
  async remove(runId: RunId): Promise<void> {
    const { wtPath, branch } = this.names(runId);
    try {
      if (await lstat(wtPath).then(() => true, () => false)) {
        await runIsolatedGit(this.projectRoot, ['worktree', 'remove', '--force', wtPath]);
      }
      // Clears git's record of a worktree whose directory was deleted by hand.
      await runIsolatedGit(this.projectRoot, ['worktree', 'prune']);
      // `maf/<runId>-*` is also the shape of another run's branch (run `a-b` for run `a`); one checked
      // out in a worktree belongs to a live run, and git would refuse to delete it anyway.
      const checkedOut = new Set((await git(this.projectRoot, ['worktree', 'list', '--porcelain']))
        .split('\n').filter((l) => l.startsWith('branch ')).map((l) => l.slice('branch '.length)));
      const doomed = (await git(this.projectRoot, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}-*`]))
        .split('\n').filter((ref) => ref && !checkedOut.has(ref)).map((ref) => ref.slice('refs/heads/'.length));
      if (await gitTest(this.projectRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) doomed.unshift(branch);
      if (doomed.length > 0) await runIsolatedGit(this.projectRoot, ['branch', '-D', ...doomed]);
    } catch (err: unknown) {
      throw new Error(`cannot remove the worktree of run ${runId} at ${wtPath} (git said: ${gitSaid(err)}).`);
    }
    this.runs.delete(runId);
  }


  private names(runId: RunId): { wtPath: string; branch: string } {
    if (!RUN_ID.test(runId)) {
      throw new Error(
        `expected a run id of up to 128 letters, digits, '-' and '_' (it names the branch maf/<runId> ` +
        `and the directory .maf/worktrees/<runId>), but got ${JSON.stringify(runId)}.`,
      );
    }
    return { wtPath: path.join(path.resolve(this.projectRoot), '.maf', 'worktrees', runId), branch: `maf/${runId}` };
  }
}

export interface WorkingDirOptions {
  /** The directory maf was pointed at (`--dir`). */
  readonly dir:      string;
  /** False when isolation is off: `--no-worktree`, or `worktree: false` in `.maf/config.yaml`. */
  readonly worktree: boolean;
  /**
   * What turned isolation off, as the user would recognise it (`--no-worktree`, `worktree: false in
   * .maf/config.yaml`). The warning names it, so it never names a flag the user did not type.
   */
  readonly offBy?:   string | undefined;
  /** The run's worktree from `createForRun`: present exactly when `worktree` is true. */
  readonly run?:     RunWorktree | undefined;
}

export interface WorkingDir {
  readonly cwd:      string;
  readonly isolated: boolean;
  readonly warning?: string;
}

/**
 * Where a run works, and whether that is isolated from the user's checkout (D-03). Pure: it only
 * decides; `createForRun` does the git work. An inconsistent input is an error rather than a guess,
 * because guessing "in place" would hand the agent the user's working tree.
 */
export function resolveWorkingDir(opts: WorkingDirOptions): WorkingDir {
  if (!opts.worktree) {
    if (opts.run) {
      throw new Error(`expected no run worktree with --no-worktree, but one was created at ${opts.run.path}.`);
    }
    const cwd = path.resolve(opts.dir);
    return {
      cwd,
      isolated: false,
      warning: `worktree isolation is off${opts.offBy ? ` (${opts.offBy})` : ''}: this run edits ${cwd} in place, ` +
        `on whatever branch is checked out there. Its changes mix with yours and MAF cannot undo them (D-03).`,
    };
  }
  if (!opts.run) {
    throw new Error(
      `expected the run's worktree (WorktreeManager.createForRun) when worktree isolation is on, but none ` +
      `was given; pass --no-worktree to run in place instead.`,
    );
  }
  return { cwd: opts.run.cwd, isolated: true };
}
