import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunId, TaskId } from '@maf/types';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

export interface BranchInfo {
  name:    string;
  runId:   RunId;
  taskId:  TaskId;
  baseSha: string;
}

export class BranchIsolator {
  private branches = new Map<string, BranchInfo>();

  constructor(private readonly cwd: string) {}

  async createBranch(runId: RunId, taskId: TaskId, baseBranch = 'main'): Promise<BranchInfo> {
    const name = `maf/${runId}/${taskId}`.replace(/[^a-zA-Z0-9/-]/g, '-').slice(0, 80);
    const baseSha = await git(['rev-parse', baseBranch], this.cwd).catch(
      () => git(['rev-parse', 'HEAD'], this.cwd)
    );
    await git(['checkout', '-b', name, baseSha], this.cwd);
    const info: BranchInfo = { name, runId, taskId, baseSha };
    this.branches.set(name, info);
    return info;
  }

  async switchTo(branchName: string): Promise<void> {
    await git(['checkout', branchName], this.cwd);
  }

  async mergeBranch(branchName: string, targetBranch = 'main', squash = false): Promise<void> {
    await git(['checkout', targetBranch], this.cwd);
    const mergeArgs = squash
      ? ['merge', '--squash', branchName]
      : ['merge', '--no-ff', branchName, '-m', `Merge ${branchName}`];
    await git(mergeArgs, this.cwd);
  }

  async deleteBranch(branchName: string, force = false): Promise<void> {
    const flag = force ? '-D' : '-d';
    await git(['branch', flag, branchName], this.cwd).catch(() => undefined);
    this.branches.delete(branchName);
  }

  async currentBranch(): Promise<string> {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], this.cwd);
  }
}
