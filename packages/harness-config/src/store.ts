import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SlsaMaterial } from '@maf/types';
import type { HarnessRoleSet } from './types.js';
import { computeHarnessSha, mintHarnessConfig } from './canonicalize.js';
import {
  assertHarnessConfig,
  HarnessConfigError,
  HarnessIntegrityError,
} from './types.js';
import type { HarnessConfig, PlannerRecallConfig } from './types.js';

const CURRENT_FILE = 'CURRENT';
const INDEX_FILE   = 'index.json';
const SHA_RE       = /^[0-9a-f]{64}$/;

/** The id of the harness minted from the legacy roles file (`--roles`, default `.maf/roles.yaml`). */
export const LEGACY_DEFAULT_ID = 'legacy-default';

/**
 * HarnessStore — content-addressed harness configs under `.maf/harnesses/`.
 *
 * Layout:
 *   <sha>.yaml      JSON serialization of the HarnessConfig (repo convention:
 *                   .yaml files are JSON-in-yaml, mirroring .maf/roles.yaml)
 *   index.json      { [id]: sha } — id → sha lookup
 *   CURRENT         plain sha of the active harness
 *
 * Identity: the harness a run dispatches has the sha of the content it dispatches.
 * - `legacy-default` is not a snapshot that is minted once: it names whatever the roles file —
 *   each prompt file's text included — mints *now*. `adoptLegacy` re-mints on every call; the
 *   same content gives the same sha and reuses the stored file, changed content gets a new file
 *   and the id moves to it. Earlier snapshots stay on disk under their shas, because attestations
 *   name them.
 * - CURRENT is either the operator's choice (`maf harness set-current`, an `evolve` ship) or it
 *   tracks the roles file. It tracks the roles file when it is absent or names *any*
 *   `legacy-default` harness — including one an 0.2.x run pointed it at — and then `adoptLegacy`
 *   moves it to the fresh mint. So `setCurrent` refuses a `legacy-default` snapshot other than the
 *   newest mint — the next plain run would undo it; an older one runs pinned (`--harness <sha>`).
 * - `resolveHarnessRef` decides which harness a run uses; see there.
 */
export class HarnessStore {
  readonly dir: string;

  constructor(mafDir: string) {
    this.dir = path.join(mafDir, 'harnesses');
  }

  /** Mint (in-memory) a config for a RoleSet; does not persist. */
  mint(roleSet: HarnessRoleSet, id: string, plannerRecall?: PlannerRecallConfig): HarnessConfig {
    return mintHarnessConfig({
      id,
      roleSet,
      processorBundles: [],
      ...(plannerRecall ? { plannerRecall } : {}),
    });
  }

  /**
   * Mint the legacy role set as `legacy-default`, persist it, and point the id at it. Moves
   * CURRENT to it unless CURRENT names a harness the operator chose (see the class comment).
   * `roleSet` should carry each role's prompt text (`harnessRoleSetFromRegistry` in @maf/roles),
   * or the sha does not cover the prompts.
   */
  async adoptLegacy(roleSet: HarnessRoleSet): Promise<HarnessConfig> {
    const minted = this.mint(roleSet, LEGACY_DEFAULT_ID);
    // An unchanged role set mints the sha already on disk. Verify that copy and leave it be: a
    // tampered file is reported rather than quietly rewritten, and a plain run whose roles did not
    // change writes nothing, so it cannot disturb another run reading the store.
    const stored = await this.readVerified(minted.sha);
    if (stored === undefined) await this.save(minted);
    else await this.pointId(minted.id, minted.sha);
    const current = await this.current();
    if (current?.sha !== minted.sha && (!current || current.id === LEGACY_DEFAULT_ID))
      await this.writeCurrent(minted.sha);
    return minted;
  }

  /**
   * The attestation's `configSource` for `harness`: the stored file and its sha. Refuses a
   * harness that is not stored intact, or whose in-memory content no longer hashes to its sha,
   * because the digest would then name something other than what was dispatched.
   */
  async configSource(harness: HarnessConfig): Promise<SlsaMaterial> {
    if (computeHarnessSha(harness) !== harness.sha)
      throw new HarnessIntegrityError(
        `Harness ${JSON.stringify(harness.id)} was changed after it was minted: its content hashes to ` +
        `${computeHarnessSha(harness)}, not its sha ${harness.sha}`,
      );
    if (!(await this.has(harness.sha)))
      throw new HarnessConfigError(
        `Harness ${JSON.stringify(harness.id)} (${harness.sha}) is not in ${this.dir}; an attestation can only name a stored harness`,
      );
    await this.load(harness.sha);
    return { uri: this.pathFor(harness.sha), digest: { sha256: harness.sha } };
  }

  async save(config: HarnessConfig): Promise<void> {
    assertHarnessConfig(config);
    await mkdir(this.dir, { recursive: true });
    await this.writeAtomic(this.pathFor(config.sha), JSON.stringify(config, null, 2));
    await this.pointId(config.id, config.sha);
  }

  /**
   * Point CURRENT at a stored harness. A `legacy-default` snapshot other than the newest mint is
   * refused: CURRENT naming a legacy-default harness tracks the roles file, so the next plain run
   * would re-mint and move CURRENT off it — the operator's choice would be silently undone.
   */
  async setCurrent(sha: string): Promise<void> {
    if (!SHA_RE.test(sha)) throw new HarnessConfigError('setCurrent requires a 64-hex sha');
    const cfg = await this.load(sha);
    if (cfg.id === LEGACY_DEFAULT_ID) {
      const newest = (await this.readIndex())[LEGACY_DEFAULT_ID];
      if (newest !== sha)
        throw new HarnessConfigError(
          `Harness ${sha} is an older legacy-default snapshot` +
          `${newest ? `; the newest mint of the roles file is ${shortSha(newest)}` : ''}. CURRENT naming a ` +
          'legacy-default harness tracks the roles file, so the next plain run would re-mint it and move ' +
          `CURRENT off this snapshot. To run this snapshot, pin it for the run with --harness ${sha} instead.`,
        );
    }
    await this.writeCurrent(sha);
  }

  /**
   * Load by 64-hex sha, by id via the index, or 'CURRENT' / 'current'.
   * Integrity: recomputes the sha over the loaded payload and compares to both
   * the embedded `sha` field and the on-disk filename — tamper anywhere fails.
   */
  async load(ref: string): Promise<HarnessConfig> {
    const found = await this.tryLoad(ref);
    if (!found) throw new HarnessConfigError(`No harness found for ref ${JSON.stringify(ref)}`);
    return found;
  }

  async tryLoad(ref: string): Promise<HarnessConfig | undefined> {
    if (ref === CURRENT_FILE || ref === 'current') return this.loadCurrent();
    // A sha is a name, not a pointer: no file under it means no such harness, not a broken store.
    if (SHA_RE.test(ref)) return this.readVerified(ref);
    const sha = (await this.readIndex())[ref];
    if (!sha) return undefined;
    const found = await this.readVerified(sha);
    if (!found)
      throw new HarnessIntegrityError(
        `Harness index maps ${JSON.stringify(ref)} to ${sha}, but ${this.pathFor(sha)} is missing`,
      );
    return found;
  }

  /**
   * CURRENT, failing closed when it names a harness that is missing or fails its integrity check —
   * with an error that says it is CURRENT at fault and how to repair it, because plain runs read it.
   */
  private async loadCurrent(): Promise<HarnessConfig | undefined> {
    const sha = await readFile(path.join(this.dir, CURRENT_FILE), 'utf8')
      .then((t) => t.trim())
      .catch(() => undefined);
    if (!sha || !SHA_RE.test(sha)) return undefined;
    const remedy =
      'Plain runs read CURRENT, so they are refused until it names an intact harness: ' +
      '`maf harness set-current legacy-default` (or another id or sha), or restore the file.';
    let found: HarnessConfig | undefined;
    try {
      found = await this.readVerified(sha);
    } catch (err: unknown) {
      throw new HarnessIntegrityError(
        `CURRENT names harness ${sha}, which fails its integrity check ` +
        `(${err instanceof Error ? err.message : String(err)}). ${remedy}`,
      );
    }
    if (!found)
      throw new HarnessIntegrityError(`CURRENT names harness ${sha}, but ${this.pathFor(sha)} is missing. ${remedy}`);
    return found;
  }

  /** The harness stored under `sha`, integrity-checked; undefined when there is no file. */
  private async readVerified(sha: string): Promise<HarnessConfig | undefined> {
    let text: string;
    try {
      text = await readFile(this.pathFor(sha), 'utf8');
    } catch (err: unknown) {
      if (isNotFound(err)) return undefined;
      throw new HarnessIntegrityError(
        `Harness file ${sha}.yaml could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HarnessIntegrityError(`Harness file ${sha}.yaml is not parseable`);
    }
    assertHarnessConfig(parsed);

    const recomputed = computeHarnessSha(parsed);
    if (recomputed !== parsed.sha)
      throw new HarnessIntegrityError(
        `Harness tamper: embedded sha ${parsed.sha} != recomputed ${recomputed}`,
      );
    if (recomputed !== sha)
      throw new HarnessIntegrityError(
        `Harness tamper: filename/sha ${sha} != recomputed ${recomputed}`,
      );
    return parsed;
  }

  async list(): Promise<HarnessConfig[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: HarnessConfig[] = [];
    for (const name of names) {
      const m = /^([0-9a-f]{64})\.yaml$/.exec(name);
      if (!m) continue;
      try {
        const cfg = await this.load(m[1] as string);
        out.push(cfg);
      } catch {
        // corrupt entries are skipped in listing; load() still throws on direct access
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async current(): Promise<HarnessConfig | undefined> {
    return this.tryLoad(CURRENT_FILE);
  }

  private pathFor(sha: string): string {
    return path.join(this.dir, `${sha}.yaml`);
  }

  private async has(sha: string): Promise<boolean> {
    return access(this.pathFor(sha)).then(() => true, () => false);
  }

  private async readIndex(): Promise<Record<string, string>> {
    try {
      const text = await readFile(path.join(this.dir, INDEX_FILE), 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && SHA_RE.test(v)) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Point `id` at `sha` in the index (and no other id at it), writing only if that changes it. */
  private async pointId(id: string, sha: string): Promise<void> {
    const index = await this.readIndex();
    const others = Object.entries(index).filter(([k, v]) => k !== id && v === sha);
    if (index[id] === sha && others.length === 0) return;
    for (const [k] of others) delete index[k];
    // An id that named other content now names this sha; the earlier file stays under its own sha.
    index[id] = sha;
    await this.writeAtomic(path.join(this.dir, INDEX_FILE), JSON.stringify(index, null, 2));
  }

  private async writeCurrent(sha: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.writeAtomic(path.join(this.dir, CURRENT_FILE), sha);
  }

  /**
   * Write beside the target, then rename over it. A rename within one directory is atomic, so a
   * concurrent run reads the old file or the new one — never a truncated one it would report as
   * tampered.
   */
  private async writeAtomic(file: string, text: string): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, file);
    } catch (err: unknown) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

export { computeHarnessSha, mintHarnessConfig };
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

export interface HarnessRefOptions {
  /** `--harness <ref>`: an id, a 64-hex sha, `current`, or `legacy-default`. Absent: a plain run. */
  harness?: string | undefined;
  /**
   * The role set the legacy roles file describes now, each role's prompt text included
   * (`harnessRoleSetFromRegistry` in @maf/roles). Called only when that is the harness that runs.
   */
  legacyRoleSet: () => Promise<HarnessRoleSet>;
}

export interface ResolvedHarness {
  harness: HarnessConfig;
  /** `flag`: `--harness` named it. `current`: the operator's CURRENT. `legacy`: minted from the roles file. */
  source:  'flag' | 'current' | 'legacy';
}

/**
 * The harness a run dispatches: `--harness` if given, else CURRENT if the operator set it, else
 * `legacy-default` minted fresh from the roles file. `--harness current` is a plain run, and
 * `--harness legacy-default` is the roles file now — never the last snapshot taken of it.
 *
 * The caller dispatches from `harness.roleSet` (not from a separately parsed roles file) and
 * attests `store.configSource(harness)`, so the stamped sha is the content that ran. A harness
 * that names a prompt file without carrying its text is refused: its sha would not cover the
 * prompt that runs.
 */
export async function resolveHarnessRef(
  opts: HarnessRefOptions,
  store: HarnessStore,
): Promise<ResolvedHarness> {
  const ref = opts.harness === CURRENT_FILE || opts.harness === 'current' ? undefined : opts.harness;
  let resolved: ResolvedHarness | undefined;
  if (ref !== undefined && ref !== LEGACY_DEFAULT_ID) {
    resolved = { harness: await store.load(ref), source: 'flag' };
  } else if (ref === undefined) {
    const current = await store.current();
    if (current && current.id !== LEGACY_DEFAULT_ID) resolved = { harness: current, source: 'current' };
  }
  if (!resolved) {
    const roleSet = await opts.legacyRoleSet();
    assertPromptsCarried(roleSet, 'The legacy role set',
      'Build it with harnessRoleSetFromRegistry (@maf/roles), which inlines the text.');
    resolved = { harness: await store.adoptLegacy(roleSet), source: 'legacy' };
  }
  const { harness, source } = resolved;
  const named = `${JSON.stringify(harness.id)} (${shortSha(harness.sha)})`;
  if (source === 'current')
    // Re-minting does not help here: a plain run keeps reading CURRENT. Only moving CURRENT does.
    assertPromptsCarried(harness.roleSet, `CURRENT's harness ${named}`,
      'It predates 0.3.0, which carries each prompt\'s text in the harness, so every plain run is refused ' +
      'while CURRENT names it. Run `maf harness set-current legacy-default` to hand plain runs back to the ' +
      'roles file, or point CURRENT at another harness.');
  else
    assertPromptsCarried(harness.roleSet, `Harness ${named}`,
      'Re-mint it from the roles file (a plain run, or --harness legacy-default), which inlines the text.');
  return resolved;
}

/**
 * A role that names a prompt file must carry the file's text as `systemPrompt`, which is what
 * dispatch reads first; otherwise the prompt is read from disk at dispatch, outside the sha.
 */
function assertPromptsCarried(roleSet: HarnessRoleSet, what: string, remedy: string): void {
  for (const r of roleSet.roles) {
    if (r.promptFile !== undefined && r.systemPrompt === undefined)
      throw new HarnessConfigError(
        `${what} names prompt file ${JSON.stringify(r.promptFile)} for role ${JSON.stringify(r.role)} but ` +
        `does not carry its text, so its sha does not identify the prompt that would run. ${remedy}`,
      );
  }
}
