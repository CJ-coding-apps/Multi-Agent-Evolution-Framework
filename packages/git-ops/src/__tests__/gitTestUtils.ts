import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Create a throwaway git repo on branch `main` with one initial commit. */
export async function makeRepo(prefix = 'maf-git-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.email', 'test@maf.local'], dir);
  await git(['config', 'user.name', 'MAF Test'], dir);
  await writeFile(path.join(dir, 'README.md'), '# test repo\n', 'utf8');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'initial commit'], dir);
  return dir;
}

export async function commitFile(
  repo: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(path.join(repo, file), content, 'utf8');
  await git(['add', file], repo);
  await git(['commit', '-m', message], repo);
  return git(['rev-parse', 'HEAD'], repo);
}
