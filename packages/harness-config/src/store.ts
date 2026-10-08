import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
 *   moves it to the fresh mint. To run an older legacy snapshot, pin it by sha (`--harness <sha>`).
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
    // An unchanged role set mints the sha already on disk. Verify that copy first, so a tampered
    // file is reported rather than quietly rewritten; `save` then writes the same bytes.
    if (await this.has(minted.sha)) await this.load(minted.sha);
    await this.save(minted);
    const current = await this.current();
    if (!current || current.id === LEGACY_DEFAULT_ID) await this.setCurrent(minted.sha);
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
    const file = this.pathFor(config.sha);
    const text = JSON.stringify(config, null, 2);
    await writeFile(file, text, 'utf8');

    const index = await this.readIndex();
    for (const [id, sha] of Object.entries(index)) {
      if (id !== config.id && sha === config.sha) delete index[id];
    }
    if (index[config.id] && index[config.id] !== config.sha) {
      // Id moved to new content: fine — sha file is distinct, id now points at it.
    }
    index[config.id] = config.sha;
    await this.writeIndex(index);
  }

  async setCurrent(sha: string): Promise<void> {
    if (!SHA_RE.test(sha)) throw new HarnessConfigError('setCurrent requires a 64-hex sha');
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, CURRENT_FILE), sha, 'utf8');
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
    let sha: string | undefined;
    if (ref === CURRENT_FILE || ref === 'current') {
      sha = await readFile(path.join(this.dir, CURRENT_FILE), 'utf8')
        .then((t) => t.trim())
        .catch(() => undefined);
      if (!sha || !SHA_RE.test(sha)) return undefined;
    } else if (SHA_RE.test(ref)) {
      sha = ref;
    } else {
      const index = await this.readIndex();
      sha = index[ref];
      if (!sha) return undefined;
    }

    let text: string;
    try {
      text = await readFile(this.pathFor(sha), 'utf8');
    } catch {
      throw new HarnessIntegrityError(`Harness index points at ${sha} but the config file is missing`);
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

  private async writeIndex(index: Record<string, string>): Promise<void> {
    await writeFile(path.join(this.dir, INDEX_FILE), JSON.stringify(index, null, 2), 'utf8');
  }
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
  const { harness } = resolved;
  assertPromptsCarried(harness.roleSet, `Harness ${JSON.stringify(harness.id)} (${shortSha(harness.sha)})`,
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
