import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitHash } from '@maf/types';
import { makeCommitHash } from '@maf/types';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

export class RollbackManager {
  private stack: CommitHash[] = [];

  constructor(private readonly cwd: string) {}

  async checkpoint(): Promise<CommitHash> {
    const hash = makeCommitHash(await git(['rev-parse', 'HEAD'], this.cwd));
    this.stack.push(hash);
    return hash;
  }

  async rollbackToLast(): Promise<CommitHash | undefined> {
    const hash = this.stack.pop();
    if (!hash) return undefined;
    await git(['reset', '--hard', hash], this.cwd);
    return hash;
  }

  async rollbackTo(hash: CommitHash): Promise<void> {
    await git(['reset', '--hard', hash], this.cwd);
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
    return makeCommitHash(await git(['rev-parse', 'HEAD'], this.cwd));
  }
}
