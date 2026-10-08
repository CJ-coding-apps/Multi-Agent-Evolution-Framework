import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  HarnessStore, HarnessConfigError, HarnessIntegrityError, assertHarnessConfig, computeHarnessSha, shortSha,
} from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { roleSetFromHarness } from '@maf/roles';
import { createDefaultProcessorRegistry } from '@maf/processors';

const SHA_PREFIX_RE = /^[0-9a-f]{4,63}$/;

/**
 * Reads a harness file and proves it is what it claims: a valid config whose content hashes to
 * its embedded sha (and to the sha in its file name, when the name carries one), whose roles
 * parse, and whose processor bundles all exist. Nothing here trusts the file's own `sha`.
 */
export async function loadHarnessFile(file: string): Promise<HarnessConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new HarnessConfigError(`${file} could not be read as a JSON harness: ${err instanceof Error ? err.message : String(err)}`);
  }
  assertHarnessConfig(parsed);
  const recomputed = computeHarnessSha(parsed);
  if (recomputed !== parsed.sha) {
    throw new HarnessIntegrityError(`${file} claims sha ${parsed.sha}, but its content hashes to ${recomputed}.`);
  }
  const named = /[0-9a-f]{64}/.exec(path.basename(file))?.[0];
  if (named !== undefined && named !== recomputed) {
    throw new HarnessIntegrityError(`${file} is named for sha ${named}, but its content hashes to ${recomputed}.`);
  }
  roleSetFromHarness(parsed.roleSet);
  const known = new Set(createDefaultProcessorRegistry().names());
  const unknown = parsed.processorBundles.map((p) => p.name).filter((n) => !known.has(n));
  if (unknown.length > 0) {
    throw new HarnessConfigError(`${file} names processor bundle(s) this maf does not have: ${unknown.join(', ')}.`);
  }
  return parsed;
}

/** Looks a stored harness up by id, sha, "current", or a sha prefix of 4+ hex digits that names exactly one. */
export async function loadStoredHarness(store: HarnessStore, ref: string): Promise<HarnessConfig> {
  const found = await store.tryLoad(ref);
  if (found) return found;
  if (SHA_PREFIX_RE.test(ref)) {
    const names = await readdir(store.dir).catch(() => [] as string[]);
    const matches = names.flatMap((n) => /^([0-9a-f]{64})\.yaml$/.exec(n)?.[1] ?? []).filter((sha) => sha.startsWith(ref));
    if (matches.length > 1) {
      throw new HarnessConfigError(`Harness ref ${JSON.stringify(ref)} is ambiguous: it starts ${matches.map(shortSha).join(', ')}. Give more of the sha.`);
    }
    if (matches[0] !== undefined) return store.load(matches[0]);
  }
  throw new HarnessConfigError(`No harness found for ref ${JSON.stringify(ref)} in ${store.dir}.`);
}

/**
 * Validates a harness file, copies it into the store and indexes its id. An id already bound to
 * other content is refused: repointing `legacy-default` (or any name a user relies on) at an
 * imported file would change what that name runs without anyone asking for it.
 */
export async function importHarness(store: HarnessStore, file: string): Promise<HarnessConfig> {
  const cfg = await loadHarnessFile(file);
  const bound = await store.tryLoad(cfg.id);
  if (bound && bound.sha !== cfg.sha) {
    throw new HarnessConfigError(`Harness id "${cfg.id}" already names ${shortSha(bound.sha)} in ${store.dir}; refusing to point it at ${shortSha(cfg.sha)}.`);
  }
  await store.save(cfg);
  return cfg;
}

function printConfig(cfg: HarnessConfig, currentSha?: string): void {
  const mark = cfg.sha === currentSha ? ' (CURRENT)' : '';
  const bundles = cfg.processorBundles.length
    ? cfg.processorBundles.map((p) => p.name).join(', ')
    : '(none — CLI-era behavior)';
  console.log(`  ${cfg.id.padEnd(20)} ${shortSha(cfg.sha)}${mark}`);
  console.log(`    roles:      ${cfg.roleSet.roles.map((r) => r.role).join(', ')} (default: ${cfg.roleSet.defaultRole})`);
  console.log(`    processors: ${bundles}`);
  if (cfg.plannerRecall) console.log(`    recall:     failures≤${cfg.plannerRecall.pastFailuresLimit ?? '—'} lcmTokens≤${cfg.plannerRecall.lcmGrepBudgetTokens ?? '—'}`);
}

export function registerHarnessCommand(program: Command): void {
  const cmd = program
    .command('harness')
    .description('Manage content-addressed harness configurations');

  cmd
    .command('list')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .description('List stored harness configurations')
    .action(async (opts: { dir: string }) => {
      const mafDir = path.join(path.resolve(opts.dir), '.maf');
      const store = new HarnessStore(mafDir);
      const all = await store.list();
      if (all.length === 0) {
        console.log('[maf] no harnesses — run once to mint legacy-default, or use maf harness import');
        return;
      }
      const current = await store.current();
      console.log(`[maf] ${all.length} harness(es) in ${store.dir}:`);
      for (const cfg of all) printConfig(cfg, current?.sha);
    });

  cmd
    .command('show <ref>')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .description('Show a harness by id, sha (a unique prefix will do), or "current"')
    .action(async (ref: string, opts: { dir: string }) => {
      const mafDir = path.join(path.resolve(opts.dir), '.maf');
      const store = new HarnessStore(mafDir);
      const cfg = await loadStoredHarness(store, ref);
      console.log(JSON.stringify(cfg, null, 2));
    });

  cmd
    .command('set-current <ref>')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .description('Point CURRENT at a stored harness')
    .action(async (ref: string, opts: { dir: string }) => {
      const mafDir = path.join(path.resolve(opts.dir), '.maf');
      const store = new HarnessStore(mafDir);
      const cfg = await loadStoredHarness(store, ref);
      await store.setCurrent(cfg.sha);
      console.log(`[maf] CURRENT → ${cfg.id} (${shortSha(cfg.sha)})`);
    });

  cmd
    .command('import <file>')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .description('Validate a harness file, copy it into the store and index its id (CURRENT is not changed)')
    .action(async (file: string, opts: { dir: string }) => {
      const mafDir = path.join(path.resolve(opts.dir), '.maf');
      const store = new HarnessStore(mafDir);
      const cfg = await importHarness(store, path.resolve(file));
      console.log(`[maf] imported ${cfg.id} (${shortSha(cfg.sha)}) into ${store.dir}; maf harness set-current ${shortSha(cfg.sha)} to use it by default`);
    });
}
