import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAF_RUNTIME_STATE } from '@maf/git-ops';

/**
 * `.maf/.gitignore`: what a run produces under `.maf/`, from the list the security gate leaves out
 * of its diff (`MAF_RUNTIME_STATE`), so that after a run `git status` shows nothing of MAF's but the
 * configuration a user chooses to commit — and `git add -A` does not stage the memory graph, the
 * LCM database, transcripts, bundles and harnesses. A committed `default-<sha>.json` harness stays
 * addable, as in this repository's own `.gitignore`. The file ignores itself: it is MAF's, written
 * again by any run that finds it missing.
 */
export const MAF_DIR_GITIGNORE = [
  '# Written by maf: runtime state a run produces (MAF_RUNTIME_STATE in @maf/git-ops).',
  '# policy.yaml, roles.yaml, config.yaml and prompts/ are not listed: commit them if you want them shared.',
  '/.gitignore',
  ...MAF_RUNTIME_STATE.flatMap((entry) => entry === 'harnesses'
    ? ['/harnesses/*', '!/harnesses/default-*.json']
    : [`/${entry}`]),
  '',
].join('\n');

/**
 * Creates maf's state directory (`<repo>/.maf`) when it is missing, with its `.gitignore`, and
 * returns its absolute path.
 *
 * The stores `run` opens — better-sqlite3's `lcm.db`, Kùzu's `memory.kuzu` — open a file
 * inside this directory and do not create it, so a repository maf had never run in crashed
 * at the first store instead of starting. Creating it is safe to repeat. Working around a
 * file that already holds the name is not, so that is refused rather than guessed at. A
 * `.gitignore` already there is the user's to keep, and is left as it is.
 */
export async function ensureMafDir(dir: string): Promise<string> {
  const resolved = path.resolve(dir);
  try {
    await mkdir(resolved, { recursive: true });
  } catch (err: unknown) {
    // mkdir reports a file in the way as EEXIST or ENOTDIR depending on where it sits;
    // stat tells the two apart, so the message can name what the user has to move.
    const existing = await stat(resolved).catch(() => undefined);
    if (existing !== undefined && !existing.isDirectory()) {
      throw new Error(
        `expected ${resolved} to be maf's state directory, but it exists and is not a directory; ` +
        `move or remove it, then run again.`,
      );
    }
    throw new Error(
      `cannot create maf's state directory ${resolved} ` +
      `(the filesystem said: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const ignore = path.join(resolved, '.gitignore');
  await writeFile(ignore, MAF_DIR_GITIGNORE, { flag: 'wx' }).catch((err: unknown) => {
    if ((err as { code?: unknown }).code === 'EEXIST') return;
    throw new Error(
      `cannot write ${ignore}, which keeps MAF's runtime state out of git ` +
      `(the filesystem said: ${err instanceof Error ? err.message : String(err)})`,
    );
  });
  return resolved;
}
