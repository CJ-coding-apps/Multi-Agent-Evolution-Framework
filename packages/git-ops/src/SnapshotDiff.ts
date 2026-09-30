import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/** git's well-known empty tree — a valid diff base for a repository with no commits. */
export const GIT_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 8MB. A diff past this is an error, never a truncation — see `snapshotDiff`. */
const MAX_DIFF_BYTES = 8 * 1024 * 1024;

export interface IsolatedGitOptions {
  /** Extra environment for this call (e.g. a fixed committer identity). */
  env?:  NodeJS.ProcessEnv;
  /** Raise only where the expected output is large; the default is node's 1MB. */
  maxBuffer?: number;
}

/**
 * Runs git with the host's configuration switched off.
 *
 * A global `core.hooksPath`, `init.templateDir`, `diff.external` or `core.pager` would
 * otherwise run inside a repository maf is operating on, so what maf measures would depend
 * on whose machine it ran on — and a `diff.external` would execute an arbitrary program
 * during what looks like a read. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` remove the
 * host's config files, and `core.hooksPath` is pinned in case a repository carries its own.
 *
 * Every git call maf makes comes through here, so the policy cannot drift apart between
 * callers — which is how the two diff implementations this replaces came to disagree.
 */
export function runIsolatedGit(
  cwd: string,
  args: string[],
  opts: IsolatedGitOptions = {},
) {
  return execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL:   '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...opts.env,
    },
  });
}

/**
 * Everything the working tree changed since `startCommit`, as a diff, whether or not any
 * of it is tracked, staged, or committed.
 *
 * The reason this exists rather than a plain `git diff`: an agent that creates a file and
 * never stages it, or that commits its own work, is invisible to `git diff <base>`. Both
 * are normal agent behaviour, and in both cases the security gate would be handed an empty
 * diff and would report the change reviewed. The fix is to stage the whole working tree
 * into a throwaway index and diff that:
 *
 *   GIT_INDEX_FILE=<tmp> git read-tree <startCommit>   # start from the base
 *   GIT_INDEX_FILE=<tmp> git add -A                    # stage everything, .gitignore respected
 *   GIT_INDEX_FILE=<tmp> git diff --cached <startCommit>
 *
 * `GIT_INDEX_FILE` is what makes this safe to run against a user's own repository: their
 * real index is never opened, so running maf cannot leave their staged work altered.
 *
 * Two limits are deliberate and documented in docs/SECURITY.md: files matched by
 * `.gitignore` are excluded (that is the point of `git add -A`), and an oversized diff is
 * an error rather than a truncated review — a half-read diff reported as "reviewed" would
 * be the same fail-open this function exists to close, reached a third way.
 */
export async function snapshotDiff(cwd: string, startCommit: string): Promise<string> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'maf-snapshot-'));
  const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    // read-tree --empty is the no-commits case: at that point there is no object to read
    // and the empty tree is the honest base.
    await runIsolatedGit(
      cwd,
      startCommit === GIT_EMPTY_TREE ? ['read-tree', '--empty'] : ['read-tree', startCommit],
      { env },
    );
    await runIsolatedGit(cwd, ['add', '-A'], { env });
    const { stdout } = await runIsolatedGit(cwd, ['diff', '--cached', startCommit], {
      env,
      maxBuffer: MAX_DIFF_BYTES,
    });
    return stdout;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error(
        `cannot compute the working-tree diff against ${startCommit.slice(0, 12)} in ${cwd}: ` +
        `it is larger than ${MAX_DIFF_BYTES} bytes. Reviewing a truncated diff would report the ` +
        `part that was cut as reviewed, so this fails instead; raise MAX_DIFF_BYTES in ` +
        `packages/git-ops/src/SnapshotDiff.ts if a change is genuinely this large.`,
      );
    }
    throw new Error(
      `cannot compute the working-tree diff against ${startCommit.slice(0, 12)} in ${cwd} ` +
      `(git said: ${err instanceof Error ? err.message : String(err)})`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
