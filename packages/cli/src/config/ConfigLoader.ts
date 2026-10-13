import { lstat, readFile } from 'node:fs/promises';
import type { Dag, DagNode, LcmMode, NodeId, RetryPolicy } from '@maf/types';
import { DEFAULT_RETRY_POLICY } from '@maf/types';
import type { YamlDocument } from '@maf/policy-engine';
import { parseYamlDocument, YamlSyntaxError } from '@maf/policy-engine';

/**
 * What `.maf/config.yaml` may set. Every key is optional: the file is the middle of three layers
 * (command-line flag > this file > built-in default, see {@link resolveConfig}).
 *
 * Each key is for one reader on the `maf run` path: `adapter`, `model` and `worktree` are the
 * flags of those names; `lcm` configures the `LcmEngine` the run constructs; `dag` reaches the
 * scheduler through {@link applyDagSettings}; `timeouts` bound the planner's call to the adapter
 * and the security gate's review. A section nothing reads is not accepted — `circuit` was one:
 * `CircuitBreaker` is not constructed on the run path.
 */
export interface MafConfig {
  adapter?:  string;
  model?:    string;
  worktree?: boolean;
  lcm?: {
    mode?:             LcmMode;
    contextThreshold?: number;
    freshTailCount?:   number;
  };
  dag?: {
    maxConcurrent?: number;
    retry?:         Partial<RetryPolicy>;
  };
  timeouts?: {
    planMs?:           number;
    securityReviewMs?: number;
  };
}

/** The settings a run uses, every one decided. `model` has no default: the adapter's own applies. */
export interface ResolvedMafConfig {
  adapter:  string;
  model?:   string;
  worktree: boolean;
  lcm:      { mode: LcmMode; contextThreshold: number; freshTailCount: number };
  dag:      { maxConcurrent: number; retry: RetryPolicy };
  timeouts: { planMs: number; securityReviewMs: number };
}

/** The values `maf run` hard-coded before it read a config file, so a run without one is unchanged. */
export const DEFAULT_MAF_CONFIG: Readonly<ResolvedMafConfig> = Object.freeze({
  adapter:  'claude',
  worktree: true,
  lcm:      Object.freeze({ mode: 'Upward' as const, contextThreshold: 0.75, freshTailCount: 64 }),
  dag:      Object.freeze({ maxConcurrent: 4, retry: Object.freeze({ ...DEFAULT_RETRY_POLICY }) }),
  timeouts: Object.freeze({ planMs: 120_000, securityReviewMs: 120_000 }),
});

/**
 * Reads `.maf/config.yaml`, and refuses a file it cannot read in full (D-08) — the policy
 * loader's contract. The loader this replaces tried JSON, then YAML, then answered `{}`, and had
 * no caller, so every key in the shipped file was ignored.
 */
export class ConfigLoader {
  /**
   * The validated settings in `configPath`. A missing file logs one warning line and yields `{}`:
   * no settings, so every key takes its default. A file that exists but cannot be read, is not
   * YAML, or fails validation — including any key the schema does not know — throws.
   */
  static async load(configPath: string): Promise<MafConfig> {
    const where = JSON.stringify(configPath);
    let text: string;
    try {
      text = await readFile(configPath, 'utf8');
    } catch (err: unknown) {
      if (isNotFound(err) && !(await lstat(configPath).then(() => true, () => false))) {
        console.warn(`[maf] config: no config file at ${where}; using the built-in defaults.`);
        return {};
      }
      throw new Error(
        `Config file ${where} exists but could not be read, and a config file that exists is ` +
        `never skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let doc: YamlDocument;
    try {
      doc = parseYamlDocument(text, configPath);
    } catch (err: unknown) {
      if (!(err instanceof YamlSyntaxError)) throw err;
      throw new Error(
        `Config file ${where} is not valid YAML at line ${err.line}, column ${err.column}, so the ` +
        `run cannot start: ${err.reason}`,
      );
    }
    const problems: Problem[] = [];
    const config = readConfig(doc.value, problems);
    if (problems.length > 0) {
      const lines = problems
        .map((p) => ({ line: doc.lineOf(p.at), message: p.message }))
        .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
        .map(({ line, message }) => (line === undefined ? message : `line ${line}: ${message}`));
      throw new Error(`Config file ${where} failed validation, so the run cannot start:\n  - ${lines.join('\n  - ')}`);
    }
    return config;
  }
}

/** The three layers, highest precedence first. `flags` holds only what the user typed. */
export interface ConfigLayers {
  flags:    MafConfig;
  file:     MafConfig;
  defaults: ResolvedMafConfig;
}

/**
 * Each setting from the highest layer that sets it: flag, then file, then default — per key, so
 * a flag setting one retry field leaves the file's other retry fields in force. Both layers are
 * validated (a flag value is as able to be wrong as a file's); nothing is written to any layer,
 * and the result shares no object with them.
 */
export function resolveConfig({ flags, file, defaults }: ConfigLayers): ResolvedMafConfig {
  for (const [label, layer] of [['the command line', flags], ['the config file values', file]] as const) {
    const problems: Problem[] = [];
    readConfig(layer, problems);
    if (problems.length > 0) {
      throw new Error(`Settings from ${label} failed validation:\n  - ${problems.map((p) => p.message).join('\n  - ')}`);
    }
  }
  const fr = flags.dag?.retry;
  const lr = file.dag?.retry;
  const model = flags.model ?? file.model ?? defaults.model;
  return {
    adapter:  flags.adapter ?? file.adapter ?? defaults.adapter,
    ...(model !== undefined ? { model } : {}),
    worktree: flags.worktree ?? file.worktree ?? defaults.worktree,
    lcm: {
      mode:             flags.lcm?.mode             ?? file.lcm?.mode             ?? defaults.lcm.mode,
      contextThreshold: flags.lcm?.contextThreshold ?? file.lcm?.contextThreshold ?? defaults.lcm.contextThreshold,
      freshTailCount:   flags.lcm?.freshTailCount   ?? file.lcm?.freshTailCount   ?? defaults.lcm.freshTailCount,
    },
    dag: {
      maxConcurrent: flags.dag?.maxConcurrent ?? file.dag?.maxConcurrent ?? defaults.dag.maxConcurrent,
      retry: {
        maxAttempts:   fr?.maxAttempts   ?? lr?.maxAttempts   ?? defaults.dag.retry.maxAttempts,
        backoffMs:     fr?.backoffMs     ?? lr?.backoffMs     ?? defaults.dag.retry.backoffMs,
        backoffFactor: fr?.backoffFactor ?? lr?.backoffFactor ?? defaults.dag.retry.backoffFactor,
        jitterMs:      fr?.jitterMs      ?? lr?.jitterMs      ?? defaults.dag.retry.jitterMs,
      },
    },
    timeouts: {
      planMs:           flags.timeouts?.planMs           ?? file.timeouts?.planMs           ?? defaults.timeouts.planMs,
      securityReviewMs: flags.timeouts?.securityReviewMs ?? file.timeouts?.securityReviewMs ?? defaults.timeouts.securityReviewMs,
    },
  };
}

/**
 * `dag` with the run's `dag` settings in force: the scheduler's concurrency and every node's
 * retry policy (the planner sets no per-node policy of its own). Returns a copy: the planner hands
 * every node the shared `DEFAULT_RETRY_POLICY` object, so writing into a node's policy would change
 * the default for every later plan in the process.
 */
export function applyDagSettings(dag: Dag, settings: ResolvedMafConfig['dag']): Dag {
  const nodes = new Map<NodeId, DagNode>();
  for (const [id, node] of dag.nodes) nodes.set(id, { ...node, retryPolicy: { ...settings.retry } });
  return {
    ...dag,
    nodes,
    config: { ...dag.config, maxConcurrent: settings.maxConcurrent, retryPolicy: { ...settings.retry } },
  };
}

// ── Schema ─────────────────────────────────────────────────────────────────────────────────
// Keyed by the types' own field names, so a field added to `MafConfig` does not compile until
// the schema knows it, rather than being refused at run time as unknown.

type Section<K extends keyof MafConfig> = Record<keyof NonNullable<MafConfig[K]>, true>;
const TOP_FIELDS:      Record<keyof MafConfig, true> = { adapter: true, model: true, worktree: true, lcm: true, dag: true, timeouts: true };
const LCM_FIELDS:      Section<'lcm'>      = { mode: true, contextThreshold: true, freshTailCount: true };
const DAG_FIELDS:      Section<'dag'>      = { maxConcurrent: true, retry: true };
const RETRY_FIELDS:    Record<keyof RetryPolicy, true> = { maxAttempts: true, backoffMs: true, backoffFactor: true, jitterMs: true };
const TIMEOUTS_FIELDS: Section<'timeouts'> = { planMs: true, securityReviewMs: true };
// Node's timers fire after 1 ms for any delay above this, so a larger timeout or backoff would mean "at once".
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Problem { at: string[]; message: string }
type Mapping = Record<string, unknown>;
/** A value check: the value as `T`, or `undefined` when it is not one. */
type Check<T> = (v: unknown) => T | undefined;

const text: Check<string> = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const bool: Check<boolean> = (v) => (typeof v === 'boolean' ? v : undefined);
const lcmMode: Check<LcmMode> = (v) => (v === 'Upward' || v === 'Dolt' ? v : undefined);
const fraction: Check<number> = (v) => (typeof v === 'number' && v > 0 && v <= 1 ? v : undefined);
const count: Check<number> = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const positive: Check<number> = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : undefined);
const millis: Check<number> = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIMER_MS ? v : undefined);
const factor: Check<number> = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? v : undefined);
const timeout: Check<number> = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_TIMER_MS ? v : undefined);

/** `raw` as a `MafConfig`, built afresh from the fields that pass; every failure goes to `problems`. */
function readConfig(raw: unknown, problems: Problem[]): MafConfig {
  const config: MafConfig = {};
  if (raw === null || raw === undefined) {
    problems.push({ at: [], message: 'The config file is empty or holds only comments: expected a mapping of ' +
      'settings (write "{}" to take every default on purpose).' });
    return config;
  }
  const top = section(raw, [], TOP_FIELDS, problems);
  if (top === undefined) return config;
  read(config, 'adapter', top, [], text, 'a non-empty adapter name', problems);
  read(config, 'model', top, [], text, 'a non-empty model name', problems);
  read(config, 'worktree', top, [], bool, 'true or false', problems);

  const lcm = section(own(top, 'lcm'), ['lcm'], LCM_FIELDS, problems);
  if (lcm !== undefined) {
    config.lcm = {};
    read(config.lcm, 'mode', lcm, ['lcm'], lcmMode, '"Upward" or "Dolt"', problems);
    read(config.lcm, 'contextThreshold', lcm, ['lcm'], fraction, 'a number greater than 0 and at most 1', problems);
    read(config.lcm, 'freshTailCount', lcm, ['lcm'], count, 'a whole number, 0 or more', problems);
  }
  const dag = section(own(top, 'dag'), ['dag'], DAG_FIELDS, problems);
  if (dag !== undefined) {
    config.dag = {};
    read(config.dag, 'maxConcurrent', dag, ['dag'], positive, 'a positive integer', problems);
    const retry = section(own(dag, 'retry'), ['dag', 'retry'], RETRY_FIELDS, problems);
    if (retry !== undefined) {
      const at = ['dag', 'retry'];
      const ms = `a number of milliseconds from 0 to ${MAX_TIMER_MS}`;
      config.dag.retry = {};
      read(config.dag.retry, 'maxAttempts', retry, at, positive, 'a positive integer (1 means no retry)', problems);
      read(config.dag.retry, 'backoffMs', retry, at, millis, ms, problems);
      read(config.dag.retry, 'backoffFactor', retry, at, factor, 'a number, 1 or more', problems);
      read(config.dag.retry, 'jitterMs', retry, at, millis, ms, problems);
    }
  }
  const timeouts = section(own(top, 'timeouts'), ['timeouts'], TIMEOUTS_FIELDS, problems);
  if (timeouts !== undefined) {
    const ms = `a whole number of milliseconds from 1 to ${MAX_TIMER_MS}`;
    config.timeouts = {};
    read(config.timeouts, 'planMs', timeouts, ['timeouts'], timeout, ms, problems);
    read(config.timeouts, 'securityReviewMs', timeouts, ['timeouts'], timeout, ms, problems);
  }
  return config;
}

/** `parent[key]` if it is the parent's own: `__proto__` and `constructor` are on every object. */
function own(parent: Mapping, key: string): unknown {
  return Object.hasOwn(parent, key) ? parent[key] : undefined;
}

/** `raw` as a mapping with every key it holds known, or `undefined` (reported) when it is not one. */
function section(raw: unknown, at: string[], known: Readonly<Record<string, true>>, problems: Problem[]): Mapping | undefined {
  if (raw === undefined) return undefined;
  if (!isMapping(raw)) {
    problems.push({ at, message: `${at.length === 0 ? 'The config' : at.join('.')} must be a mapping of settings; found ${found(raw)}.` });
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (Object.hasOwn(known, key)) continue;
    const name = [...at, key].join('.');
    problems.push({
      at: [...at, key],
      message: `unknown key ${JSON.stringify(name)}: expected only ${Object.keys(known).join(', ')}${at.length === 0 ? '' : ` under ${at.join('.')}`}.`,
    });
  }
  return raw;
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sets `into[key]` from `from[key]` when that passes `check`; reports it when it does not. */
function read<T extends object, K extends keyof T & string>(
  into: T, key: K, from: Mapping, at: string[], check: Check<NonNullable<T[K]>>, expected: string, problems: Problem[],
): void {
  const raw = own(from, key);
  if (raw === undefined) return;
  const value = check(raw);
  if (value !== undefined) into[key] = value;
  else problems.push({ at: [...at, key], message: `${[...at, key].join('.')} must be ${expected}; found ${found(raw)}.` });
}

function found(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? 'an empty list' : 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string') return value.trim() === '' ? 'an empty string' : JSON.stringify(value);
  return String(value);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
