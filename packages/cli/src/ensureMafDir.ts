import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Creates maf's state directory (`<repo>/.maf`) when it is missing, and returns its
 * absolute path.
 *
 * The stores `run` opens — better-sqlite3's `lcm.db`, Kùzu's `memory.kuzu` — open a file
 * inside this directory and do not create it, so a repository maf had never run in crashed
 * at the first store instead of starting. Creating it is safe to repeat. Working around a
 * file that already holds the name is not, so that is refused rather than guessed at.
 */
export async function ensureMafDir(dir: string): Promise<string> {
  const resolved = path.resolve(dir);
  try {
    await mkdir(resolved, { recursive: true });
    return resolved;
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
}
