import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

/**
 * HarnessStore — content-addressed harness configs under `.maf/harnesses/`.
 *
 * Layout:
 *   <sha>.yaml      JSON serialization of the HarnessConfig (repo convention:
 *                   .yaml files are JSON-in-yaml, mirroring .maf/roles.yaml)
 *   index.json      { [id]: sha } — id → sha lookup
 *   CURRENT         plain sha of the active harness
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

  /** Wrap an existing RoleSet as a persisted "legacy-default" harness (idempotent). */
  async adoptLegacy(roleSet: HarnessRoleSet): Promise<HarnessConfig> {
    const existing = await this.tryLoad('legacy-default');
    const minted = this.mint(roleSet, 'legacy-default');
    if (existing) return existing;           // first mint wins — ids are stable
    await this.save(minted);
    if (!(await this.tryLoad(CURRENT_FILE))) await this.setCurrent(minted.sha);
    return minted;
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
