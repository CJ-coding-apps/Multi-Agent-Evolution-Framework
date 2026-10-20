import path from 'node:path';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { runIsolatedGit } from '@maf/git-ops';
import { assetPath, readAsset } from '../assets.js';
import { ensureMafDir } from '../ensureMafDir.js';

/**
 * `maf init`: writes the shipped `.maf/` — policy, roles, config and prompts — into the user's
 * repository, plus the `.gitignore` that keeps runtime state out of their history.
 *
 * The files come from the package's own `assets/`, so what `init` writes is byte-identical to what
 * `run` falls back to (D-49) and to this repository's `.maf/`; the drift test beside `assets.ts`
 * keeps all three the same.
 */

/** The files `init` copies, relative to `.maf/`. Prompts are whatever the package ships. */
export async function initFiles(): Promise<string[]> {
  const promptDir = assetPath('prompts');
  const prompts = (await readdir(promptDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join('prompts', entry.name))
    .sort();
  return ['policy.yaml', 'roles.yaml', 'config.yaml', ...prompts];
}

export interface InitOptions {
  /** The repository to initialise; `.maf/` is created here. */
  dir: string;
  /** Overwrite files that already exist instead of skipping them. */
  force?: boolean;
  out?: { write(text: string): unknown };
}

export interface InitResult {
  /** Files this invocation wrote, relative to `.maf/`. */
  written: string[];
  /** Files it left alone because they already existed, relative to `.maf/`. */
  skipped: string[];
}

/**
 * Initialises `dir`, refusing anything that is not a committed git repository.
 *
 * The refusal is a run's own prerequisite, not a preference: a run's worktree starts from HEAD and
 * a writer's change is reviewed as a diff against the commit its node started from, so `.maf/` in a
 * directory with no history would be a setup that cannot run.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const dir = path.resolve(options.dir);
  const out = options.out ?? process.stdout;
  await requireCommittedRepository(dir);

  const mafDir = await ensureMafDir(path.join(dir, '.maf'));
  const result: InitResult = { written: [], skipped: [] };
  const force = options.force === true;

  for (const relative of await initFiles()) {
    const destination = path.join(mafDir, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, await readAsset(relative), { flag: force ? 'w' : 'wx' });
      result.written.push(relative);
    } catch (err: unknown) {
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err;
      result.skipped.push(relative);
    }
  }

  for (const relative of result.written) out.write(`[maf] init: wrote .maf/${relative}\n`);
  for (const relative of result.skipped) {
    out.write(`[maf] init: kept .maf/${relative} (already exists; use --force to overwrite)\n`);
  }
  out.write(
    'Next steps:\n' +
    '  export MAF_SIGNING_KEY="$(openssl rand -hex 32)"\n' +
    '  maf run "…"\n',
  );
  return result;
}

/** Throws the README's own reason when `dir` cannot host a run. */
async function requireCommittedRepository(dir: string): Promise<void> {
  try {
    await runIsolatedGit(dir, ['rev-parse', '--show-prefix']);
  } catch {
    throw new Error(
      `maf init: ${dir} is not inside a git repository. The target directory of \`maf run\` must ` +
      "be in a git repository with at least one commit: a run's worktree starts from HEAD, and a " +
      "writer role's change is reviewed as a diff against the commit its node started from. Run " +
      '`git init`, commit once, then `maf init` again.',
    );
  }
  try {
    await runIsolatedGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  } catch {
    throw new Error(
      `maf init: the repository at ${dir} has no commits yet. The target directory of \`maf run\` ` +
      "must be in a git repository with at least one commit: a run's worktree starts from HEAD. " +
      'Commit once, then `maf init` again (or run with --no-worktree to work in place).',
    );
  }
}

/** What a caller can replace when driving `init`: the stream its report goes to. */
export interface InitDeps {
  out?: { write(text: string): unknown };
}

export function registerInitCommand(program: Command, deps: InitDeps = {}): void {
  program
    .command('init')
    .description('Write .maf/ (policy, roles, config, prompts) from the defaults bundled with maf')
    .option('-d, --dir <path>', 'Repository to initialise', process.cwd())
    .option('--force', 'Overwrite files that already exist')
    .action(async (opts: { dir: string; force?: boolean }) => {
      await runInit({
        dir: opts.dir,
        ...(opts.force === true ? { force: true } : {}),
        ...(deps.out !== undefined ? { out: deps.out } : {}),
      });
    });
}
