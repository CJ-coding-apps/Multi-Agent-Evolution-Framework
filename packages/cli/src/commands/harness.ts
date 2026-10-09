import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  HarnessStore, HarnessConfigError, HarnessIntegrityError, assertHarnessConfig, computeHarnessSha, shortSha,
} from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { roleSetFromHarness } from '@maf/roles';
import { createDefaultProcessorRegistry } from '@maf/processors';

const SHA_PREFIX_RE = /^[0-9a-f]{4,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DEFAULT_HARNESS_RE = /^default-([0-9a-f]{64})\.json$/;

/**
 * Ids the store itself gives meaning to: `legacy-default` is what a plain run adopts roles.yaml
 * as (first mint wins), and `current` is how CURRENT is looked up, so a harness indexed under it
 * could never be loaded by its id. Compared case-insensitively.
 */
const RESERVED_IDS = new Set(['legacy-default', 'current']);

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

/** The committed `default-<sha>.json` files beside the store: all a fresh clone has before any run mints one. */
export async function committedDefaults(store: HarnessStore): Promise<string[]> {
  const names = await readdir(store.dir).catch(() => [] as string[]);
  return names.filter((n) => DEFAULT_HARNESS_RE.test(n)).map((n) => path.join(store.dir, n));
}

/** The id a committed default declares, read without trusting it; the match is verified by loadHarnessFile. */
async function declaredId(file: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['id'] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds a harness by id, sha, "current", or a sha prefix of 4+ hex digits that names exactly one,
 * and says where it was read from. The store is searched first; the committed defaults answer to
 * their id and sha too, read in place, so a fresh clone can name the harness its banner prints.
 */
export async function locateStoredHarness(store: HarnessStore, ref: string): Promise<{ harness: HarnessConfig; source: string }> {
  const storedFile = (sha: string) => path.join(store.dir, `${sha}.yaml`);
  // A full sha with no file is a miss; the store would report it as an index pointing at a missing file.
  const isStored = SHA_RE.test(ref) ? await access(storedFile(ref)).then(() => true, () => false) : true;
  const found = isStored ? await store.tryLoad(ref) : undefined;
  if (found) return { harness: found, source: storedFile(found.sha) };

  const defaults = await committedDefaults(store);
  if (SHA_PREFIX_RE.test(ref)) {
    const names = await readdir(store.dir).catch(() => [] as string[]);
    const stored = names.flatMap((n) => /^([0-9a-f]{64})\.yaml$/.exec(n)?.[1] ?? []);
    const committed = defaults.map((f) => DEFAULT_HARNESS_RE.exec(path.basename(f))?.[1] ?? '');
    const matches = [...new Set([...stored, ...committed])].filter((sha) => sha.startsWith(ref));
    if (matches.length > 1) {
      throw new HarnessConfigError(`Harness ref ${JSON.stringify(ref)} is ambiguous: it starts ${matches.map(shortSha).join(', ')}. Give more of the sha.`);
    }
    const sha = matches[0];
    if (sha !== undefined && stored.includes(sha)) return { harness: await store.load(sha), source: storedFile(sha) };
    const file = defaults.find((f) => sha !== undefined && path.basename(f) === `default-${sha}.json`);
    if (file !== undefined) return { harness: await loadHarnessFile(file), source: file };
    if (SHA_RE.test(ref)) throw new HarnessConfigError(`No harness ${ref} in the store at ${store.dir}, and no committed default-<sha>.json has that sha.`);
  }
  const byId: string[] = [];
  for (const f of defaults) if ((await declaredId(f)) === ref) byId.push(f);
  if (byId.length > 1) {
    throw new HarnessConfigError(`Harness id ${JSON.stringify(ref)} is ambiguous: ${byId.map((f) => path.basename(f)).join(', ')} all declare it. Give the sha instead.`);
  }
  if (byId[0] !== undefined) return { harness: await loadHarnessFile(byId[0]), source: byId[0] };
  throw new HarnessConfigError(`No harness found for ref ${JSON.stringify(ref)} in ${store.dir}.`);
}

/** Looks a harness up by id, sha, "current", or a sha prefix of 4+ hex digits that names exactly one. */
export async function loadStoredHarness(store: HarnessStore, ref: string): Promise<HarnessConfig> {
  return (await locateStoredHarness(store, ref)).harness;
}

/**
 * Validates a harness file, copies it into the store and indexes its id. A reserved id is refused,
 * and so is an id already bound to other content: repointing a name a user relies on at an
 * imported file would change what that name runs without anyone asking for it.
 */
export async function importHarness(store: HarnessStore, file: string): Promise<HarnessConfig> {
  // Before validation, so the refusal gives this reason whatever case the id is written in.
  const id = await declaredId(file);
  if (typeof id === 'string' && RESERVED_IDS.has(id.toLowerCase())) {
    throw new HarnessConfigError(
      `${file} has the id "${id}", which maf reserves: legacy-default is the harness a plain run adopts from roles.yaml, ` +
      'and current/CURRENT name the CURRENT pointer. Give the harness another id and mint it again before importing it.',
    );
  }
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
      const { harness: cfg, source } = await locateStoredHarness(store, ref);
      // CURRENT can name only what the store holds; a committed default is imported on the way.
      if (source !== path.join(store.dir, `${cfg.sha}.yaml`)) await importHarness(store, source);
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
