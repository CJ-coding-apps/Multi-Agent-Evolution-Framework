import type { CommitHash } from '@maf/types';
import { makeCommitHash } from '@maf/types';
import { runIsolatedGit } from './SnapshotDiff.js';
import { assertOnRunBranch, gitTest } from './WorktreeManager.js';
import type { RunWorktree } from './WorktreeManager.js';

/** The run worktree a RollbackManager is confined to. */
export type RollbackScope = Pick<RunWorktree, 'path' | 'branch'>;

/** A commit hash as git prints one. Checked so a value like `--hard` never reaches git as an option. */
const COMMIT_HASH = /^[0-9a-f]{4,64}$/;

/**
 * Checkpoints and `git reset --hard` for one run.
 *
 * A reset discards work, so D-03 permits it only on the run's own worktree branch. Every reset
 * re-proves that: `cwd` (symlinks resolved) is inside the run's worktree, git there works on that
 * worktree and not on a repository above it, HEAD is the run's branch, and the target commit is
 * reachable from it. Constructed without a worktree — a `--no-worktree` run — it still takes
 * checkpoints, and refuses every reset.
 */
export class RollbackManager {
  private stack: CommitHash[] = [];

  constructor(private readonly cwd: string, private readonly worktree?: RollbackScope) {}

  async checkpoint(): Promise<CommitHash> {
    const hash = await this.currentHead();
    this.stack.push(hash);
    return hash;
  }

  async rollbackToLast(): Promise<CommitHash | undefined> {
    const hash = this.stack.at(-1);
    if (!hash) return undefined;
    await this.resetHard(hash);
    // Popped only once the reset happened, so a refused rollback keeps its checkpoint.
    this.stack.pop();
    return hash;
  }

  async rollbackTo(hash: CommitHash): Promise<void> {
    await this.resetHard(hash);
    // Trim stack to before this hash
    const idx = this.stack.indexOf(hash);
    if (idx !== -1) this.stack.splice(idx + 1);
  }

  peek(): CommitHash | undefined {
    return this.stack.at(-1);
  }

  history(): CommitHash[] {
    return [...this.stack];
  }

  async currentHead(): Promise<CommitHash> {
    const cwd = this.worktree ? await assertOnRunBranch(this.cwd, this.worktree) : this.cwd;
    const { stdout } = await runIsolatedGit(cwd, ['rev-parse', 'HEAD']);
    return makeCommitHash(stdout.trim());
  }

  private async resetHard(hash: CommitHash): Promise<void> {
    if (!this.worktree) {
      throw new Error(
        `refusing to reset ${this.cwd} to ${hash}: this RollbackManager was given no run worktree, and ` +
        `git reset --hard is permitted only on the run's own worktree branch (D-03). A --no-worktree run cannot roll back.`,
      );
    }
    if (!COMMIT_HASH.test(hash)) {
      throw new Error(`expected a commit hash (4 to 64 lowercase hex digits) to roll back to, but got ${JSON.stringify(hash)}.`);
    }
    const cwd = await assertOnRunBranch(this.cwd, this.worktree);
    const branch = this.worktree.branch;
    const reachable =
      await gitTest(cwd, ['rev-parse', '--verify', '--quiet', `${hash}^{commit}`]) &&
      await gitTest(cwd, ['merge-base', '--is-ancestor', hash, `refs/heads/${branch}`]);
    if (!reachable) {
      throw new Error(
        `refusing to reset the run's worktree to ${hash}: it is not reachable from the run's branch ${branch} ` +
        `(or is not a commit at all), and a reset may only move that branch back along its own history.`,
      );
    }
    await runIsolatedGit(cwd, ['reset', '--hard', '--quiet', hash]);
  }
}
