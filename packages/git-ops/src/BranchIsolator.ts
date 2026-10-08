import type { RunId, TaskId } from '@maf/types';
import { runIsolatedGit } from './SnapshotDiff.js';
import { assertInWorktree } from './WorktreeManager.js';
import type { RunWorktree } from './WorktreeManager.js';

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await runIsolatedGit(cwd, args);
  return stdout.trim();
}

export interface BranchInfo {
  name:    string;
  runId:   RunId;
  taskId:  TaskId;
  baseSha: string;
}

/**
 * Per-task branches inside one run's worktree.
 *
 * Every branch starts at the worktree's `baseCommit` — the user's HEAD when the run began — not
 * at a branch name like `main`, which may not exist, may have moved since, or may not be what the
 * user was on. Every git call runs in the worktree, never in the user's checkout, and only the
 * run's branches are switched to or deleted. There is no merge: MAF never merges (D-03); a run's
 * result reaches the user as the `git merge` command `WorktreeManager.finish` returns.
 */
export class BranchIsolator {
  private branches = new Map<string, BranchInfo>();

  constructor(private readonly worktree: Pick<RunWorktree, 'runId' | 'path' | 'branch' | 'baseCommit'>) {}

  async createBranch(taskId: TaskId): Promise<BranchInfo> {
    // `maf/<runId>/<task>` cannot coexist with the branch `maf/<runId>` (a ref cannot also be a
    // directory of refs), so the task is a suffix.
    const name = `${this.worktree.branch}-${taskId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40)}`;
    const baseSha = this.worktree.baseCommit;
    await git(['checkout', '--quiet', '-b', name, baseSha], await this.cwd());
    const info: BranchInfo = { name, runId: this.worktree.runId, taskId, baseSha };
    this.branches.set(name, info);
    return info;
  }

  async switchTo(branchName: string): Promise<void> {
    if (branchName !== this.worktree.branch) this.assertOwned(branchName);
    await git(['checkout', '--quiet', branchName], await this.cwd());
  }

  async deleteBranch(branchName: string, force = false): Promise<void> {
    this.assertOwned(branchName);
    const flag = force ? '-D' : '-d';
    // A non-forced delete of an unmerged branch fails quietly and the branch stays this run's.
    const deleted = await git(['branch', flag, branchName], await this.cwd()).then(() => true, () => false);
    if (deleted) this.branches.delete(branchName);
  }

  async currentBranch(): Promise<string> {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], await this.cwd());
  }

  private cwd(): Promise<string> {
    return assertInWorktree(this.worktree.path, this.worktree.path);
  }

  private assertOwned(branchName: string): void {
    if (!this.branches.has(branchName)) {
      throw new Error(
        `refusing to touch branch ${JSON.stringify(branchName)}: it is not this run's (expected one of ` +
        `${JSON.stringify([...this.branches.keys()])} created by this BranchIsolator in ${this.worktree.path}).`,
      );
    }
  }
}
