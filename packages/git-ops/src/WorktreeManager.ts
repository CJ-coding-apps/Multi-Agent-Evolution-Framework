import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { TaskId, RunId, CommitHash } from '@maf/types';
import { makeCommitHash } from '@maf/types';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

export interface WorktreeInfo {
  path:        string;
  branch:      string;
  taskId:      TaskId;
  runId:       RunId;
  originalSha: CommitHash;
  createdAt:   Date;
}

export class WorktreeManager {
  private worktrees = new Map<TaskId, WorktreeInfo>();

  constructor(private readonly projectRoot: string) {}

  async create(taskId: TaskId, runId: RunId): Promise<WorktreeInfo> {
    const branch = `maf/run-${runId}-task-${taskId}`.replace(/[^a-zA-Z0-9/-]/g, '-');
    const wtPath = await mkdtemp(path.join(os.tmpdir(), `maf-wt-`));
    const originalSha = makeCommitHash(await git(['rev-parse', 'HEAD'], this.projectRoot));

    // Create branch + worktree in one step
    await execFileAsync('git', ['worktree', 'add', '-b', branch, wtPath], { cwd: this.projectRoot });

    const info: WorktreeInfo = { path: wtPath, branch, taskId, runId, originalSha, createdAt: new Date() };
    this.worktrees.set(taskId, info);
    return info;
  }

  async remove(taskId: TaskId): Promise<void> {
    const info = this.worktrees.get(taskId);
    if (!info) return;
    await execFileAsync('git', ['worktree', 'remove', '--force', info.path], { cwd: this.projectRoot }).catch(() => undefined);
    await rm(info.path, { recursive: true, force: true }).catch(() => undefined);
    await git(['branch', '-D', info.branch], this.projectRoot).catch(() => undefined);
    this.worktrees.delete(taskId);
  }

  async pruneStale(olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
    const now = Date.now();
    const stale = [...this.worktrees.values()].filter((w) => now - w.createdAt.getTime() > olderThanMs);
    await Promise.all(stale.map((w) => this.remove(w.taskId)));
    // Also prune git's internal list
    await git(['worktree', 'prune'], this.projectRoot).catch(() => undefined);
  }

  get(taskId: TaskId): WorktreeInfo | undefined {
    return this.worktrees.get(taskId);
  }

  getAll(): WorktreeInfo[] {
    return [...this.worktrees.values()];
  }

  // Harvest the diff from a worktree back into the main tree
  async harvest(taskId: TaskId): Promise<string> {
    const info = this.worktrees.get(taskId);
    if (!info) throw new Error(`No worktree for task ${taskId}`);
    const diff = await git(['diff', `${info.originalSha}..HEAD`, '--', '.'], info.path);
    return diff;
  }
}
