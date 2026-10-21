import crypto from 'node:crypto';
import path from 'node:path';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { runIsolatedGit } from '@maf/git-ops';
import { assetPath, readAsset } from '../assets.js';
import { ensureMafDir } from '../ensureMafDir.js';

/**
 * `maf init`: writes the shipped `.maf/` — policy, roles, config, prompts and the default harness —
 * into the user's repository, plus the `.gitignore` that keeps runtime state out of their history.
 *
 * The files come from the package's own `assets/`, byte for byte as this repository's `.maf/` holds
 * them; the drift test beside `assets.ts` keeps the two the same. That is a statement about the
 * bytes, not about what a run uses when a file is absent: only the policy falls back to the shipped
 * file (D-49). With no `roles.yaml`, `run` uses its built-in role set, which is not the shipped
 * one (F2).
 */

/** The files `init` copies, relative to `.maf/`. Prompts and harnesses are whatever the package ships. */
export async function initFiles(): Promise<string[]> {
  const promptDir = assetPath('prompts');
  const prompts = (await readdir(promptDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join('prompts', entry.name))
    .sort();
  // The default harness, so a repository that ran `init` carries the same one the package falls
  // back to (F1). Filtered by shape: `.maf/.gitignore` whitelists exactly `default-<sha>.json`.
  const harnessDir = assetPath('harnesses');
  const harnesses = (await readdir(harnessDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /^default-[0-9a-f]{64}\.json$/.test(entry.name))
    .map((entry) => path.join('harnesses', entry.name))
    .sort();
  return ['policy.yaml', 'roles.yaml', 'config.yaml', ...prompts, ...harnesses];
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

  const mafDirPath = path.join(dir, '.maf');
  // F6, N4: `--force` must not be a way to write outside the repository, and a destination it
  // would refuse must be refused before anything is written. `.maf` is checked before `ensureMafDir`
  // because mkdir would follow the link and create its target instead; every destination and each
  // component under `.maf/` is then checked against the path it will occupy once `.maf/` exists, so
  // a symlinked `prompts/` stops the whole run with zero files written rather than four.
  await refuseSymlink(mafDirPath);
  const files = await initFiles();
  for (const relative of ['.gitignore', ...files]) await refuseSymlinksUnder(mafDirPath, relative);
  const hadIgnore = (await lstat(path.join(mafDirPath, '.gitignore')).catch(() => undefined)) !== undefined;
  const mafDir = await ensureMafDir(mafDirPath);
  const result: InitResult = { written: [], skipped: [] };
  const force = options.force === true;

  for (const relative of files) {
    const destination = path.join(mafDir, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    if (!force && (await lstat(destination).catch(() => undefined)) !== undefined) {
      result.skipped.push(relative);
      continue;
    }
    await writeThroughTempFile(destination, await readAsset(relative));
    result.written.push(relative);
  }

  if (hadIgnore) out.write('[maf] init: kept .maf/.gitignore (already exists)\n');
  else out.write('[maf] init: wrote .maf/.gitignore (keeps MAF runtime state out of git)\n');
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

/**
 * F6: a symbolic link is refused wherever `init` would write, whatever `--force` says. The link's
 * target is the user's; `init` overwriting a file outside the repository they named is not a
 * preference they expressed, and `--force` is not consent to it.
 */
async function refuseSymlink(target: string): Promise<void> {
  const entry = await lstat(target).catch(() => undefined);
  if (entry?.isSymbolicLink() === true) {
    throw new Error(
      `maf init: ${target} is a symbolic link; refusing to write through it. ` +
      'Remove the link and run maf init again.',
    );
  }
}

/** Every component of `relative` beneath `root`, checked as {@link refuseSymlink} checks `.maf`. */
async function refuseSymlinksUnder(root: string, relative: string): Promise<void> {
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    await refuseSymlink(current);
  }
}

/**
 * Writes by creating a sibling temp file and renaming it over the destination: the destination is
 * never truncated in place, so a failure part-way leaves the file it replaced intact.
 */
async function writeThroughTempFile(destination: string, text: string): Promise<void> {
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  await writeFile(temp, text, { flag: 'wx' });
  try {
    await rename(temp, destination);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** Throws the README's own reason when `dir` cannot host a run. */
async function requireCommittedRepository(dir: string): Promise<void> {
  let insideWorkTree: string;
  try {
    insideWorkTree = (await runIsolatedGit(dir, ['rev-parse', '--is-inside-work-tree'])).stdout.trim();
  } catch {
    throw new Error(
      `maf init: ${dir} is not inside a git repository. The target directory of \`maf run\` must ` +
      "be in a git repository with at least one commit: a run's worktree starts from HEAD, and a " +
      "writer role's change is reviewed as a diff against the commit its node started from. Run " +
      '`git init`, commit once, then `maf init` again.',
    );
  }
  // F9(b): inside `.git` (or a bare repository) `git rev-parse` succeeds and answers `false`. A
  // worktree there has no working tree to review, and `.maf/` would land in git's own directory.
  if (insideWorkTree !== 'true') {
    const gitDir = await runIsolatedGit(dir, ['rev-parse', '--absolute-git-dir'])
      .then((r) => r.stdout.trim())
      .catch(() => undefined);
    throw new Error(
      `maf init: ${dir} is inside a git directory${gitDir === undefined ? '' : ` (${gitDir})`}, ` +
      'not a work tree. `.maf/` belongs at the root of the repository you work in; run maf init there.',
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
    .description('Write .maf/ (policy, roles, config, prompts, default harness) from the defaults bundled with maf')
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
