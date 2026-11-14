import crypto from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { componentId } from '@maf/attestation';
import { SecurityReviewGate } from '@maf/git-ops';
import { makeRunId, refusePrototypeKey } from '@maf/types';
import type { CliAdapter, RunId, RunStatus } from '@maf/types';
import { HarnessStore, shortSha } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { MemoryGraph } from '@maf/memory-graph';
import { RoleRegistry, roleSetFromHarness } from '@maf/roles';
import { createDefaultRegistry } from '@maf/tools';
import {
  CALIBRATION_FILE, CALIBRATION_RULE, CALIBRATION_RUNS, GoldenRunner, PROBE_DEFAULT_TASKS, PROBE_FILE,
  ScoreRecorder, ScriptedAdapter, SCRIPTED_ADAPTER_NAME, SPLITS_FILE, applyCalibration,
  assertGoldenCorpus, describeJudge, loadScriptedTasks, loadSplits, makeLlmJudge, projectProbe,
  seesawDecision, selectCalibrated, selectProbeTasks,
} from '@maf/eval-harness';
import type {
  CalibrationCount, CalibrationProbeProjection, CalibrationRecord, CalibrationSelection,
  CalibrationUsage, GoldenSuiteResult, GoldenTask, LoadedSplits,
} from '@maf/eval-harness';
import { UsageMeter, meterAdapter } from '@maf/evolver';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';
import { ensureMafDir } from '../ensureMafDir.js';
import { RESOLVER_REFS, buildRunStack, harnessDriftNotice, resolveCorpusRoot, resolveRunHarness } from '../wiring.js';
import { DEFAULT_MAF_CONFIG } from '../config/ConfigLoader.js';
import type { PolicyChoice } from '../wiring.js';
import { loadHarnessFile, locateStoredHarness } from './harness.js';

/**
 * The golden suite's execution verdict: did every attempt run to its verifiers?
 *
 * It is deliberately NOT the score. A harness that ran 10 tasks and solved 9 is a
 * successful measurement of a 9/10 harness, and recording it as "Failed" would tell the
 * evolver nothing about which of the two facts happened — nearly every real run would be
 * a recorded failure, so the outcome would carry no information at all. "Did it run" and
 * "what did it score" are separate questions; the score is the `goldens` payload, which
 * carries `solvedTaskIds` and `total`.
 */
export function goldenRunStatus(result: GoldenSuiteResult): RunStatus {
  return result.tasks.some((t) => t.attempts.some((a) => a.error !== undefined))
    ? 'Failed'
    : 'Succeeded';
}

/**
 * The harness a golden run evaluates and `evolve` starts from: `--harness` (a stored ref, or a
 * harness file), else CURRENT, else `legacy-default` minted from the roles file now — the same
 * resolution a plain run makes (`resolveRunHarness`). The committed `.maf/harnesses/default-<sha>.json`
 * still answers to its id and (short) sha through `--harness`, and is read in place, not imported.
 *
 * LOW-R2-2 (WP-3.15 round 3): with nothing pinned, `goldens` and `evolve` used to evaluate the
 * committed default even after `.maf/roles.yaml` had been edited — a user's edit silently ignored,
 * the HIGH-1 trap one command over. They now dispatch the roles file, exactly as a plain run does.
 * The default is still what makes `maf goldens run --adapter scripted` work on a clone that has run
 * `maf init` (it writes the file), and the built-in set covers a repository with no file at all.
 */
export async function resolveGoldensHarness(mafDir: string, ref?: string): Promise<{ harness: HarnessConfig; source: string }> {
  const store = new HarnessStore(mafDir);
  if (ref !== undefined && (ref.endsWith('.json') || ref.includes('/') || ref.includes(path.sep))) {
    return { harness: await loadHarnessFile(path.resolve(ref)), source: path.resolve(ref) };
  }
  const plain = ref === undefined || ref === 'current' || ref === 'CURRENT';
  if (!plain && !RESOLVER_REFS.has(ref)) {
    const found = await locateStoredHarness(store, ref);
    if (found.source !== path.join(store.dir, `${found.harness.sha}.yaml`)) return found; // a committed default, read in place
  }
  // Every remaining case — a stored ref, CURRENT, and a plain run with no CURRENT at all — is
  // resolved as `run` resolves it: the roles file now, and a harness whose prompts are not in its
  // sha is refused.
  const baseTools = createDefaultRegistry();
  const rolesPath = path.join(mafDir, 'roles.yaml');
  const { harness, source } = await resolveRunHarness({
    store, ref: plain ? undefined : ref, rolesPath, mafDir, baseTools,
  });
  // HIGH-1(d): a golden run dispatches the same way `run` does, so it prints the same disagreement
  // between an operator-pinned CURRENT and the roles file that CURRENT replaced.
  const drift = await harnessDriftNotice({ store, harness, source, rolesPath, mafDir, baseTools });
  if (drift !== undefined) console.error(drift);
  return { harness, source: (await store.configSource(harness)).uri };
}

/**
 * `scripted` is resolved here because its script is corpus data (`<corpus>/scripted.json`), which
 * an adapter registry has no way to know; every other name comes from the registry.
 */
export async function resolveGoldensAdapter(name: string, corpusRoot: string): Promise<CliAdapter> {
  if (name !== SCRIPTED_ADAPTER_NAME) return resolveAdapter(name, createAdapterRegistry());
  // WP-3.9 G5: the same corpus file `goldens run` reads, through the same reviver. This was the
  // reader that did not check — `GoldenRunner` and `maf evolve` both routed theirs.
  const corpus: unknown = JSON.parse(
    await readFile(path.join(corpusRoot, 'corpus.json'), 'utf8'), refusePrototypeKey,
  );
  assertGoldenCorpus(corpus);
  return new ScriptedAdapter(await loadScriptedTasks(corpusRoot, corpus));
}

/**
 * The evaluation's own state directory reads role prompts relative to itself, so each prompt
 * file the harness names is copied in from the project — the same text, none of the history.
 */
async function stagePromptFiles(harness: HarnessConfig, projectMafDir: string, evalDir: string): Promise<void> {
  for (const role of harness.roleSet.roles) {
    if (role.systemPrompt || !role.promptFile || path.isAbsolute(role.promptFile)) continue;
    const dest = path.resolve(evalDir, role.promptFile);
    if (!dest.startsWith(evalDir + path.sep)) {
      throw new Error(`goldens: role "${role.role}" reads its prompt from ${role.promptFile}, which is outside .maf.`);
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(projectMafDir, role.promptFile), dest);
  }
}

export interface GoldenSuiteOptions {
  /** The project: its `.maf/` supplies prompt files and receives the bundle — never memory. */
  cwd: string;
  corpusRoot: string;
  harness: HarnessConfig;
  /** Where the harness was read from, for the bundle's config source. */
  harnessSource: string;
  agent: CliAdapter;
  model?: string;
  judge: { adapter: CliAdapter; model?: string };
  attempts: number;
  /** The `--policy` flag as received; resolved by the one D-49 rule every command uses (F7). */
  policy: PolicyChoice;
  runId: RunId;
  /** `--allow-ungoverned`: a writer role may run on the cli tier, outside MAF's gates (D-01). */
  allowUngoverned?: boolean;
  /**
   * Run only these corpus tasks (calibration measures the pool, not the corpus). Each must be in
   * the corpus; omitting it runs everything.
   */
  only?: readonly string[];
}

/**
 * Runs the corpus isolated from every past run (D-14). The dispatch stack — memory graph, LCM,
 * transcripts — lives in a temporary directory, never the project's `.maf/`, and its graph is
 * emptied before each attempt, so neither a past run nor an earlier attempt reaches a prompt.
 * One graph for the suite rather than one per attempt: each open Kùzu database reserves 8 TB of
 * address space (returned only by `close()`, WP-2.15), so a process can hold only a handful at
 * once, and emptying one costs less than opening and checkpointing another. The stack is closed
 * before the directory is removed, so its database is checkpointed into a directory that still
 * exists. The signed bundle, holding every evaluation's tool calls, is copied into the project's
 * attestations before the directory is removed.
 */
export async function runGoldenSuite(o: GoldenSuiteOptions): Promise<{ result: GoldenSuiteResult; bundlePath: string }> {
  const mafDir = path.join(o.cwd, '.maf');
  const model = o.model ? { model: o.model } : {};
  const roles = RoleRegistry.fromSet(roleSetFromHarness(o.harness.roleSet), mafDir);
  const security = roles.resolve('security');
  const securityPrompt = security.ok ? await roles.loadPrompt(security.value.config) : undefined;

  const evalDir = await mkdtemp(path.join(tmpdir(), 'maf-goldens-'));
  try {
    await stagePromptFiles(o.harness, mafDir, evalDir);
    const stack = await buildRunStack({
      cwd: o.cwd, mafDir: evalDir, policy: o.policy, adapter: o.agent, runId: o.runId,
      harnessSha: o.harness.sha, headless: true, ...model,
      ...(o.allowUngoverned === true ? { allowUngoverned: true } : {}),
      // WP-3.2 F12: resolved settings, not another set of literals. `goldens` reads no config file.
      lcm: DEFAULT_MAF_CONFIG.lcm,
    });
    let result: GoldenSuiteResult;
    try {
      if (securityPrompt !== undefined) stack.securityPrompt = securityPrompt;
      const agent = { adapter: o.agent.name, ...model };
      const judge = { adapter: o.judge.adapter.name, ...(o.judge.model ? { model: o.judge.model } : {}) };
      result = await new GoldenRunner({
        corpusRoot: o.corpusRoot, harnessSha: o.harness.sha, harnessId: o.harness.id,
        attempts: o.attempts, temperature: 0, ...agent,
        dispatch: async (task, workDir, { timeoutMs, temperature }) => {
          await stack.graph.run({ cypher: 'MATCH (n:MemoryNode) DETACH DELETE n', params: {} });
          // L5: the corpus task id travels with the dispatch, so a refusal's `PolicyEvent` names
          // the task whose score it belongs to.
          return stack.dispatchTask(o.harness, task.role, task.prompt, workDir, timeoutMs, temperature, task.id);
        },
        llmJudge: { verdict: makeLlmJudge(o.judge, o.cwd), disclosure: describeJudge(agent, judge) },
        securityScore: async (diff) => {
          if (!diff.trim()) return 'none';
          const gate = new SecurityReviewGate({
            adapter: o.agent, projectRoot: o.cwd, securityPrompt: stack.securityPrompt, ...model,
          });
          const res = await gate.reviewDiff(diff);
          const rank: Record<string, number> = { none: 0, info: 1, low: 1, medium: 2, high: 3, critical: 4 };
          let worstRank = 0;
          for (const f of res.findings) worstRank = Math.max(worstRank, rank[f.severity] ?? 1);
          return (['none', 'low', 'medium', 'high', 'critical'] as const)[worstRank] ?? 'critical';
        },
      }).run(o.only);
      // F6 — the policy the suite ran under, recorded before the bundle so its counts are final.
      stack.recordPolicyInForce();
      await stack.attestor.bundle(
        { id: componentId(`@maf/adapter-${o.agent.name}`), modelVersion: o.model ?? 'default' },
        {
          configSource: { uri: o.harnessSource, digest: { sha256: o.harness.sha } },
          parameters: { harnessId: o.harness.id, eval: 'goldens' },
          environment: {},
        },
        [],
        // The golden suite is not a DAG, so the verdict is its own — see goldenRunStatus.
        // The score travels in the payload below, not in the outcome above it.
        { status: goldenRunStatus(result), unscheduled: [] },
        {
          harnessSha: o.harness.sha, harnessId: o.harness.id,
          solvedTaskIds: result.solvedTaskIds, total: result.tasks.length, ranAt: result.ranAt,
        },
      );
    } finally {
      // Awaited: the evaluation directory is removed below, and `close()` now resolves only after
      // the database it holds is released (WP-3.8 follow-up).
      await stack.close();
    }
    const bundlePath = path.join(mafDir, 'attestations', `${o.runId}.bundle.json`);
    await mkdir(path.dirname(bundlePath), { recursive: true });
    await copyFile(path.join(evalDir, 'attestations', `${o.runId}.bundle.json`), bundlePath);
    return { result, bundlePath };
  } finally {
    // M1: cleanup must never replace the error that brought us here. A live Kùzu handle — or a file
    // appearing while the tree is walked — can make this fail, and the user needs the policy or
    // validation error that caused the cleanup, not a filesystem one. The temp directory is the
    // operating system's to reclaim.
    await rm(evalDir, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(`[maf] warning: could not remove ${evalDir}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

/** The corpus as the runner reads it: through the shared reviver, and validated. */
async function loadCorpus(corpusRoot: string): Promise<GoldenTask[]> {
  const corpus: unknown = JSON.parse(
    await readFile(path.join(corpusRoot, 'corpus.json'), 'utf8'), refusePrototypeKey,
  );
  assertGoldenCorpus(corpus);
  return corpus;
}

/**
 * The tasks `--tasks` names. `pool` (the default) is the third list in `splits.json`; an explicit
 * list may name only pool tasks, because calibration exists to decide what the yardstick becomes.
 * A train task is already measured on every candidate, and a held-out task is already spent on the
 * gate — re-measuring either under the base harness answers nothing the split does not already.
 */
export function calibrationTaskIds(spec: string, splits: LoadedSplits): string[] {
  const pool = splits.pool ?? [];
  const trimmed = spec.trim();
  if (trimmed === '' || trimmed === 'pool') {
    if (pool.length === 0) {
      throw new Error(
        'goldens calibrate: the split has no pool. Add candidate held-out tasks to "pool" in ' +
        `${path.basename(SPLITS_FILE)} and run calibration again.`,
      );
    }
    return [...pool];
  }
  const ids = [...new Set(trimmed.split(',').map((id) => id.trim()).filter((id) => id !== ''))];
  const notPooled = ids.filter((id) => !pool.includes(id));
  if (notPooled.length > 0) {
    throw new Error(
      `goldens calibrate: ${notPooled.join(', ')} ${notPooled.length === 1 ? 'is' : 'are'} not in the pool ` +
      `(${pool.length} task${pool.length === 1 ? '' : 's'}: ${pool.join(', ') || 'none'}). Only pool tasks ` +
      'can be calibrated into the held-out set.',
    );
  }
  return ids;
}

export interface CalibrationOptions {
  corpusRoot: string;
  /** The split this run is decided against; `sha` is recorded with the counts. */
  splits: LoadedSplits;
  /** The pool task ids to measure; every one must be in `splits.pool`. */
  taskIds: readonly string[];
  /** Who produced the measurement, as recorded in `calibration.json`. */
  harness: { id: string; sha: string };
  adapter: { name: string };
  model?: string;
  /**
   * Runs the base harness on these tasks. The command wires it to `runGoldenSuite` with `only`,
   * so the calibration sessions get a gate run's isolation (H2): their memory, LCM and transcripts
   * live in a temporary directory and the graph is emptied before every attempt. Tests inject a
   * deterministic result instead of paying for one.
   */
  execute: (only: readonly string[]) => Promise<GoldenSuiteResult>;
  /**
   * R5-P4: read after `execute` returns — the meter the command wrapped the adapter with, so the
   * record carries what the measurement cost and a first evolution run can project from it instead
   * of from a constant. A test that injects a result passes nothing and records no usage.
   */
  usage?: () => CalibrationUsage | undefined;
}

export interface CalibrationOutcome {
  /** Where the measurement was written. */
  path: string;
  record: CalibrationRecord;
  /** Where the split was rewritten, when the run qualified. */
  splitsPath?: string;
  selection: CalibrationSelection;
}

/**
 * Measures the BASE harness on each pool task, `CALIBRATION_RUNS` independent times, and (R3-G2)
 * decides the held-out set from the counts. Both files are written into the corpus root, which is
 * what a maintainer commits: the measurement and the yardstick it produced, side by side.
 *
 * A calibration score is never a gate baseline: it is not written to `.maf/goldens/results`, it is
 * not recorded in the evolver's score graph, and the gate re-measures the base itself.
 */
/** The counts and crashed attempts a measured result carries, which both calibration and its probe record. */
function measurement(result: GoldenSuiteResult): {
  counts: CalibrationCount[];
  errors: { taskId: string; attempt: number; error: string }[];
} {
  return {
    counts: result.tasks.map((t) => ({
      taskId: t.taskId,
      passes: t.attempts.filter((a) => a.passed).length,
      attempts: t.attempts.length,
    })),
    errors: result.tasks.flatMap((t) => t.attempts
      .filter((a) => a.error !== undefined)
      .map((a) => ({ taskId: t.taskId, attempt: a.attempt, error: a.error as string }))),
  };
}

export async function runCalibration(o: CalibrationOptions): Promise<CalibrationOutcome> {
  const result = await o.execute(o.taskIds);

  const { counts, errors } = measurement(result);
  // R5-P4: what the measurement cost, from the meter the caller wrapped the adapter with. Absent
  // when no meter was supplied (a test's injected result), in which case the record says nothing
  // about usage rather than inventing a figure.
  const usage = o.usage?.();
  const measured = selectCalibrated(counts);
  // A crashed attempt is not a measurement: the base may not have run at all. Selecting on it would
  // turn an infrastructure failure into "the base cannot solve this", which is the opposite of what
  // the pool is for — so the run reports and stops rather than qualifying on partial evidence.
  const selection: CalibrationSelection = errors.length > 0
    ? {
      ...measured, qualified: false,
      reason: `${errors.length} attempt${errors.length === 1 ? '' : 's'} ended in an error ` +
        `(${[...new Set(errors.map((e) => e.taskId))].join(', ')}); a crashed attempt is not a measurement, ` +
        'so nothing was selected.',
    }
    : measured;

  const record: CalibrationRecord = {
    version: 1, harnessId: o.harness.id, harnessSha: o.harness.sha, adapter: o.adapter.name,
    ...(o.model !== undefined ? { model: o.model } : {}),
    runs: CALIBRATION_RUNS, ranAt: result.ranAt,
    ...(result.corpusSha !== undefined ? { corpusSha: result.corpusSha } : {}),
    splitsSha: o.splits.sha, rule: CALIBRATION_RULE, tasks: counts, errors, selection,
    ...(usage !== undefined ? { usage } : {}),
  };
  const calibrationPath = path.join(o.corpusRoot, CALIBRATION_FILE);
  const calibrationText = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(calibrationPath, calibrationText, 'utf8');
  if (!selection.qualified) return { path: calibrationPath, record, selection };

  // R4-A4: the rewritten split names the file just written, by the sha of its exact bytes, so a
  // later `loadSplits` can prove the held-out set came from this measurement and not another.
  const calibrationSha = crypto.createHash('sha256').update(calibrationText, 'utf8').digest('hex');
  const splits = applyCalibration(o.splits, selection, calibrationSha);
  const splitsPath = path.join(o.corpusRoot, SPLITS_FILE);
  await writeFile(splitsPath, `${JSON.stringify(splits, null, 2)}\n`, 'utf8');
  return { path: calibrationPath, record, selection, splitsPath };
}

// ─── R5-P5: the probe — a cheap sample that prices a full calibration ───────────────────────────

export interface CalibrationProbeOptions extends CalibrationOptions {
  /** How many tasks the whole pool holds, so a sample can be scaled to it. */
  poolSize: number;
}

/**
 * The probe's record: the same measurement a calibration keeps, plus the projection, and none of
 * the selection. `kind` distinguishes it from `calibration.json` so a probe left in a checkout can
 * never be mistaken for the measurement a split derives its held-out set from.
 */
export interface CalibrationProbeRecord {
  version: 1;
  kind: 'probe';
  harnessId: string;
  harnessSha: string;
  adapter: string;
  model?: string;
  runs: number;
  ranAt: string;
  corpusSha?: string;
  splitsSha: string;
  rule: string;
  /** The seeded sample this probe measured, in id order. */
  sampledTaskIds: string[];
  tasks: CalibrationCount[];
  errors: { taskId: string; attempt: number; error: string }[];
  projection: CalibrationProbeProjection;
  usage?: CalibrationUsage;
}

export interface CalibrationProbeOutcome {
  path: string;
  record: CalibrationProbeRecord;
  projection: CalibrationProbeProjection;
}

/**
 * R5-P5: measures the base harness on a seeded sample of the pool and writes what that sample
 * implies for the whole pool. It writes **only** `calibration-probe.json`: a sample is not a
 * measurement of every pool task, so it must not become the calibration a split's held-out set is
 * derived from, and `splits.json` is not touched under any outcome. The full run stays the
 * authority; this exists so CJ can refuse a hopeless pool before paying for one.
 */
export async function runCalibrationProbe(o: CalibrationProbeOptions): Promise<CalibrationProbeOutcome> {
  const result = await o.execute(o.taskIds);
  const { counts, errors } = measurement(result);
  const usage = o.usage?.();
  const projection = projectProbe(counts, o.poolSize);
  const record: CalibrationProbeRecord = {
    version: 1, kind: 'probe',
    harnessId: o.harness.id, harnessSha: o.harness.sha, adapter: o.adapter.name,
    ...(o.model !== undefined ? { model: o.model } : {}),
    runs: CALIBRATION_RUNS, ranAt: result.ranAt,
    ...(result.corpusSha !== undefined ? { corpusSha: result.corpusSha } : {}),
    splitsSha: o.splits.sha, rule: CALIBRATION_RULE,
    sampledTaskIds: [...o.taskIds].sort(),
    tasks: counts, errors, projection,
    ...(usage !== undefined ? { usage } : {}),
  };
  const probePath = path.join(o.corpusRoot, PROBE_FILE);
  await writeFile(probePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { path: probePath, record, projection };
}

/** Why two results cannot be seesaw-compared, or undefined when they can (D-38). */
export function incomparable(a: GoldenSuiteResult, b: GoldenSuiteResult): string | undefined {
  if (!a.corpusSha || !b.corpusSha) {
    return 'a result without a corpus sha (written before 0.3.0) cannot show it measured the same corpus; re-run it.';
  }
  if (a.corpusSha !== b.corpusSha) {
    return `the results were measured on different corpora (${shortSha(a.corpusSha)} vs ${shortSha(b.corpusSha)}), so a difference in score says nothing about the harness.`;
  }
  const show = (v: string | number | undefined, absent: string) => (v === undefined ? absent : String(v));
  // D-57: a train result and a held-out result measure different tasks, so one does not beat the
  // other. A result with no split predates the split (or ran the whole corpus) and is its own kind.
  if ((a.split ?? '') !== (b.split ?? '')) {
    return `the results measured different splits (${show(a.split, 'the full corpus')} vs ${show(b.split, 'the full corpus')}), so a difference in score says nothing about the harness.`;
  }
  if (a.split !== undefined && a.splitsSha !== b.splitsSha) {
    return `the results were measured against different split definitions (${show(a.splitsSha, 'unrecorded')} vs ${show(b.splitsSha, 'unrecorded')}), so a difference in score says nothing about the harness.`;
  }
  const differs = [
    a.adapter !== b.adapter ? `adapter ${show(a.adapter, 'unrecorded')} vs ${show(b.adapter, 'unrecorded')}` : '',
    a.model !== b.model ? `model ${show(a.model, 'the adapter default')} vs ${show(b.model, 'the adapter default')}` : '',
    a.attempts !== b.attempts ? `attempts ${show(a.attempts, 'unrecorded')} vs ${show(b.attempts, 'unrecorded')}` : '',
  ].filter((d) => d !== '');
  if (differs.length > 0) {
    return `the results were measured differently (${differs.join('; ')}), so a difference in score may come from that and not from the harness.`;
  }
  return undefined;
}

/** Checks the fields compare reads, so a truncated or foreign file is refused instead of scored as solving nothing. */
function assertGoldenResult(value: unknown, file: string): asserts value is GoldenSuiteResult {
  const o = value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const missing = ['tasks', 'solvedTaskIds'].filter((k) => !Array.isArray(o?.[k]));
  if (typeof o?.['harnessSha'] !== 'string') missing.unshift('harnessSha');
  if (missing.length > 0) {
    throw new Error(`goldens compare: ${file} is not a golden result: it has no valid ${missing.join(', ')}.`);
  }
}

/**
 * A result file by path, or by harness sha under `.maf/goldens/results` — a unique prefix of
 * `<harnessSha>.<adapter>` will do, so a bare sha names the result when only one adapter ran it.
 */
async function loadGoldenResult(resultsDir: string, ref: string): Promise<GoldenSuiteResult> {
  let file = path.resolve(ref);
  if (!(ref.endsWith('.json') || ref.includes('/') || ref.includes(path.sep))) {
    const names = (await readdir(resultsDir).catch(() => [] as string[])).filter((n) => n.startsWith(ref) && n.endsWith('.json'));
    if (names.length !== 1) {
      throw new Error(
        `goldens compare: ${names.length === 0 ? 'no' : 'more than one'} result in ${resultsDir} starts with ${JSON.stringify(ref)}` +
        `${names.length > 1 ? ` (${names.join(', ')}); give <sha>.<adapter>` : ''}.`,
      );
    }
    file = path.join(resultsDir, names[0] as string);
  }
  let parsed: unknown;
  try {
    // WP-3.9 G5: a result file is JSON read from disk, so a prototype key refuses it here too.
    parsed = JSON.parse(await readFile(file, 'utf8'), refusePrototypeKey);
  } catch (err) {
    throw new Error(`goldens compare: ${file} could not be read as a JSON result: ${err instanceof Error ? err.message : String(err)}`);
  }
  assertGoldenResult(parsed, file);
  return parsed;
}

interface GoldenOpts {
  adapter: string; model?: string; judgeAdapter?: string; judgeModel?: string;
  dir: string; corpus: string; harness?: string; attempts: string; policy: string; allowUngoverned?: boolean;
}

interface CalibrationOpts {
  adapter: string; model?: string; judgeAdapter?: string; judgeModel?: string;
  dir: string; corpus: string; harness?: string; runs: string; tasks: string;
  /** R5-P5: a count, `true` when typed without one, absent for a full calibration. */
  probe?: string | true;
  policy: string; allowUngoverned?: boolean;
}

export function registerGoldensCommand(program: Command): void {
  const cmd = program.command('goldens').description('Golden-suite evaluation for harness versions');

  cmd
    .command('run')
    .option('-a, --adapter <name>', 'CLI adapter, or "scripted" for the corpus\'s deterministic offline model', 'claude')
    .option('-m, --model <model>', 'Model name')
    .option('--judge-adapter <name>', 'Adapter for llm-judge verifiers (default: the agent\'s own; the result says so)')
    .option('--judge-model <model>', 'Model for llm-judge verifiers')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .option('--corpus <path>', 'Golden corpus root', '.maf/goldens')
    .option('--harness <ref>', 'Harness id/sha/file (default: current, else the roles file)')
    .option('--attempts <k>', 'pass@k attempts per task', '2')
    .option('--policy <path>', 'Policy file', '.maf/policy.yaml')
    .option('--allow-ungoverned', "Let writer roles run on the cli tier, outside MAF's policy, redaction, attestation and processor hooks (D-01)")
    .description('Run the golden corpus under a harness, isolated from past runs (temperature pinned to 0 where the backend supports it)')
    .action(async (opts: GoldenOpts, cmd: Command) => {
      const cwd = path.resolve(opts.dir);
      const mafDir = await ensureMafDir(path.join(cwd, '.maf'));
      const corpusRoot = await resolveCorpusRoot(cwd, opts.corpus);
      const runId = makeRunId(crypto.randomUUID());

      const { harness, source } = await resolveGoldensHarness(mafDir, opts.harness);
      console.log(`[maf] goldens run ${runId} | harness: ${harness.id} (${shortSha(harness.sha)}) from ${source}`);

      const agent = await resolveGoldensAdapter(opts.adapter, corpusRoot);
      const judgeAdapter = opts.judgeAdapter && opts.judgeAdapter !== opts.adapter
        ? await resolveGoldensAdapter(opts.judgeAdapter, corpusRoot)
        : agent;
      const judgeModel = opts.judgeModel ?? (judgeAdapter === agent ? opts.model : undefined);
      const { result, bundlePath } = await runGoldenSuite({
        cwd, corpusRoot, harness, harnessSource: source, agent, ...(opts.model ? { model: opts.model } : {}),
        judge: { adapter: judgeAdapter, ...(judgeModel ? { model: judgeModel } : {}) },
        attempts: Number(opts.attempts) || 2, runId,
        // D-49, F7: a typed path means that file or a stop; only an absent flag falls back.
        policy: { value: opts.policy, typed: cmd.getOptionValueSource('policy') === 'cli' },
        ...(opts.allowUngoverned === true ? { allowUngoverned: true } : {}),
      });

      // The score goes into the project's memory for the evolver's digest; nothing reads it back
      // into an evaluation, which never opens this graph.
      const graph = new MemoryGraph(path.join(mafDir, 'memory.kuzu'));
      try {
        await new ScoreRecorder(graph, runId).record(result);
      } finally {
        await graph.close();
      }

      const resultsDir = path.join(mafDir, 'goldens', 'results');
      await mkdir(resultsDir, { recursive: true });
      // Named for the adapter too, so a scripted run never overwrites a real model's result (D-38).
      const resultPath = path.join(resultsDir, `${harness.sha}.${agent.name}.json`);
      await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8');

      if (result.judge && !result.judge.distinct) console.log(`[maf] judge: ${result.judge.note ?? ''}`);
      console.log(`[maf] goldens: solved ${result.solvedTaskIds.length}/${result.tasks.length} (corpus ${shortSha(result.corpusSha ?? '')}) → ${resultPath}`);
      console.log(`[maf] bundle: ${bundlePath}`);
    });

  cmd
    .command('calibrate')
    .option('-a, --adapter <name>', 'CLI adapter, or "scripted" for the corpus\'s deterministic offline model', 'claude')
    .option('-m, --model <model>', 'Model name')
    .option('--judge-adapter <name>', 'Adapter for llm-judge verifiers (default: the agent\'s own)')
    .option('--judge-model <model>', 'Model for llm-judge verifiers')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .option('--corpus <path>', 'Golden corpus root', '.maf/goldens')
    .option('--harness <ref>', 'Base harness to calibrate against (default: current, else the roles file)')
    .option('--runs <n>', `base runs per task (pinned to ${CALIBRATION_RUNS}: the selection rule is pre-registered for that many)`, String(CALIBRATION_RUNS))
    .option('--tasks <ids>', 'Pool task ids to measure, comma-separated (default: the whole pool)', 'pool')
    .option('--probe [n]', `Measure only a seeded sample of n pool tasks (default ${PROBE_DEFAULT_TASKS}) and project the whole pool; writes ${PROBE_FILE} and never touches ${SPLITS_FILE} or ${CALIBRATION_FILE} (exits 1 below the full-calibration threshold)`, undefined)
    .option('--policy <path>', 'Policy file', '.maf/policy.yaml')
    .option('--allow-ungoverned', "Let writer roles run on the cli tier, outside MAF's policy, redaction, attestation and processor hooks (D-01)")
    .description('Measure the base harness on the held-out task pool, then select the tasks that have headroom into heldOut (writes calibration.json and splits.json; exits 1 when fewer than 10 qualify)')
    .action(async (opts: CalibrationOpts, cmd: Command) => {
      const cwd = path.resolve(opts.dir);
      const mafDir = await ensureMafDir(path.join(cwd, '.maf'));
      const corpusRoot = await resolveCorpusRoot(cwd, opts.corpus);
      const corpus = await loadCorpus(corpusRoot);
      const splits = await loadSplits(corpusRoot, corpus);

      // The rule is pre-registered, not a parameter: a different number of runs is a different rule,
      // and it must not be introduced by a flag on the paid command.
      const runs = Number(opts.runs);
      if (runs !== CALIBRATION_RUNS) {
        console.error(
          `[maf] goldens calibrate: --runs ${JSON.stringify(opts.runs)} is not ${CALIBRATION_RUNS}. ` +
          `The selection rule is pre-registered for ${CALIBRATION_RUNS} base runs per task; nothing was run.`,
        );
        process.exitCode = 2;
        return;
      }
      // R5-P5: `--probe` measures a seeded sample instead of the pool and decides nothing. It draws
      // its own tasks, so naming `--tasks` as well is a contradiction, refused before anything runs.
      let probeTasks: string[] | undefined;
      if (opts.probe !== undefined) {
        if (cmd.getOptionValueSource('tasks') === 'cli') {
          console.error(
            '[maf] goldens calibrate: --probe draws its own seeded sample of the pool, so it cannot be ' +
            'combined with --tasks; nothing was run.',
          );
          process.exitCode = 2;
          return;
        }
        const requested = opts.probe === true ? String(PROBE_DEFAULT_TASKS) : opts.probe;
        try {
          probeTasks = selectProbeTasks(splits.pool ?? [], Number(requested));
        } catch (err) {
          console.error(`[maf] goldens calibrate: ${err instanceof Error ? err.message : String(err)}; nothing was run.`);
          process.exitCode = 2;
          return;
        }
      }
      const taskIds = probeTasks ?? calibrationTaskIds(opts.tasks, splits);

      const { harness, source } = await resolveGoldensHarness(mafDir, opts.harness);
      console.log(
        `[maf] goldens calibrate${probeTasks !== undefined ? ' --probe' : ''} | harness: ${harness.id} (${shortSha(harness.sha)}) from ${source} | ` +
        `${taskIds.length} pool task${taskIds.length === 1 ? '' : 's'} × ${CALIBRATION_RUNS} runs | rule: ${CALIBRATION_RULE}`,
      );

      const agent = await resolveGoldensAdapter(opts.adapter, corpusRoot);
      const judgeAdapter = opts.judgeAdapter && opts.judgeAdapter !== opts.adapter
        ? await resolveGoldensAdapter(opts.judgeAdapter, corpusRoot)
        : agent;
      const judgeModel = opts.judgeModel ?? (judgeAdapter === agent ? opts.model : undefined);
      // R5-P4: meter the measurement through the same seam an evolution run uses, so the record's
      // per-task figure is the one a later projection will spend against.
      const usage = new UsageMeter();
      const meteredAgent = meterAdapter(agent, usage);
      const usageOf = (): CalibrationUsage => {
        const snapshot = usage.snapshot();
        return {
          calls: snapshot.calls, tokens: snapshot.tokens, tasks: taskIds.length,
          attemptsPerTask: CALIBRATION_RUNS,
          ...(snapshot.usd !== undefined ? { usd: snapshot.usd } : {}),
        };
      };
      // The paid path: the base harness, isolated exactly as a gate run is (H2).
      const execute = async (only: readonly string[]): Promise<GoldenSuiteResult> => (await runGoldenSuite({
        cwd, corpusRoot, harness, harnessSource: source, agent: meteredAgent, only,
        ...(opts.model ? { model: opts.model } : {}),
        judge: { adapter: judgeAdapter, ...(judgeModel ? { model: judgeModel } : {}) },
        attempts: CALIBRATION_RUNS, runId: makeRunId(crypto.randomUUID()),
        policy: { value: opts.policy, typed: cmd.getOptionValueSource('policy') === 'cli' },
        ...(opts.allowUngoverned === true ? { allowUngoverned: true } : {}),
      })).result;

      if (probeTasks !== undefined) {
        const probe = await runCalibrationProbe({
          corpusRoot, splits, taskIds,
          harness: { id: harness.id, sha: harness.sha },
          adapter: { name: agent.name }, ...(opts.model ? { model: opts.model } : {}),
          poolSize: (splits.pool ?? []).length, usage: usageOf, execute,
        });
        for (const e of probe.record.errors)
          console.error(`[maf] calibration probe: ${e.taskId} attempt ${e.attempt + 1} failed: ${e.error}`);
        console.log(`[maf] calibration probe: wrote ${probe.path}`);
        if (probe.record.usage !== undefined && probe.record.usage.tasks > 0)
          console.log(
            `[maf] calibration probe: measured ${probe.record.usage.tokens} tokens over ` +
            `${probe.record.usage.calls} model calls — ${Math.round(probe.record.usage.tokens / probe.record.usage.tasks)} per task`,
          );
        console.log(`[maf] calibration probe: ${probe.projection.statement}`);
        if (probe.record.errors.length > 0) {
          console.error(
            '[maf] calibration probe: a crashed attempt is not a measurement, so the projection above is void. ' +
            `${SPLITS_FILE} and ${CALIBRATION_FILE} are unchanged.`,
          );
          process.exitCode = 1;
          return;
        }
        if (!probe.projection.clears) {
          console.error(
            `[maf] calibration probe: projected ${probe.projection.projectedQualifying} qualifying, below the ` +
            `${probe.projection.threshold}-task threshold — do not pay for a full calibration yet; redesign the pool ` +
            `and probe again. ${SPLITS_FILE} and ${CALIBRATION_FILE} are unchanged.`,
          );
          process.exitCode = 1;
          return;
        }
        console.log(
          `[maf] calibration probe: projects ${probe.projection.projectedQualifying} qualifying, at or above the ` +
          `${probe.projection.threshold}-task threshold — worth a full calibration. ` +
          `${SPLITS_FILE} and ${CALIBRATION_FILE} are unchanged.`,
        );
        return;
      }

      const outcome = await runCalibration({
        corpusRoot, splits, taskIds, harness: { id: harness.id, sha: harness.sha },
        adapter: { name: agent.name }, ...(opts.model ? { model: opts.model } : {}),
        usage: usageOf, execute,
      });

      const { record, selection } = outcome;
      const zeros = record.tasks.filter((t) => t.passes === 0).length;
      const partial = record.tasks.length - zeros - selection.droppedAlwaysSolved.length;
      console.log(
        `[maf] calibration: ${record.tasks.length} pool task${record.tasks.length === 1 ? '' : 's'} — ` +
        `${zeros} never solved in ${CALIBRATION_RUNS}, ${selection.droppedAlwaysSolved.length} solved every run ` +
        `(no headroom), ${partial} partial; the cap allows ${selection.zerosAllowed} never-solved and ` +
        `${selection.zerosKept} ${selection.zerosKept === 1 ? 'was' : 'were'} kept`,
      );
      for (const e of record.errors) console.error(`[maf] calibration: ${e.taskId} attempt ${e.attempt + 1} failed: ${e.error}`);
      console.log(`[maf] calibration: wrote ${outcome.path}`);
      if (record.usage !== undefined && record.usage.tasks > 0)
        console.log(
          `[maf] calibration: measured ${record.usage.tokens} tokens over ${record.usage.calls} model calls — ` +
          `${Math.round(record.usage.tokens / record.usage.tasks)} per task at ${record.usage.attemptsPerTask} runs each`,
        );
      if (outcome.splitsPath === undefined) {
        console.error(
          `[maf] calibration: nothing was selected — ${selection.reason} ` +
          `${splits.heldOut.length} held-out task${splits.heldOut.length === 1 ? '' : 's'} stay as they are; ` +
          `${SPLITS_FILE} is unchanged. Redesign the pool and calibrate again.`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `[maf] calibration: selected ${selection.selected.length}: held-out ${splits.heldOut.length} → ` +
        `${splits.heldOut.length + selection.selected.length} in ${outcome.splitsPath}`,
      );
      if (selection.droppedAlwaysFailed.length > 0)
        console.log(`[maf] calibration: left in the pool (never solved, beyond the cap): ${selection.droppedAlwaysFailed.join(', ')}`);
    });

  cmd
    .command('compare <a> <b>')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .description('Seesaw-compare two golden results (A=current baseline, B=candidate), each a result file or a harness sha (or <sha>.<adapter>) under .maf/goldens/results. Exits 1 on regression; 2 when a result is missing or malformed, or the two were measured on different corpora, adapters, models or attempt counts.')
    .action(async (a: string, b: string, opts: { dir: string }) => {
      const resultsDir = path.join(path.resolve(opts.dir), '.maf', 'goldens', 'results');
      let baseline: GoldenSuiteResult;
      let candidate: GoldenSuiteResult;
      try {
        baseline = await loadGoldenResult(resultsDir, a);
        candidate = await loadGoldenResult(resultsDir, b);
      } catch (err) {
        // Not REJECT's 1: nothing was compared, so nothing regressed.
        console.error(`[maf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
        return;
      }
      const refusal = incomparable(baseline, candidate);
      if (refusal) {
        console.error(`[maf] cannot compare: ${refusal}`);
        process.exitCode = 2;
        return;
      }
      const label = shortSha(candidate.harnessSha);
      const decision = seesawDecision(baseline, candidate);
      switch (decision.kind) {
        case 'ship':
          console.log(`[maf] SHIP ${label}: improves ${decision.improvements.join(', ')}`);
          process.exitCode = 0;
          break;
        case 'no-change':
          console.log(`[maf] NO-CHANGE ${label} (does not ship)`);
          process.exitCode = 0;
          break;
        case 'reject':
          console.error(`[maf] REJECT ${label}: regresses ${decision.regressions.join(', ')}`);
          process.exitCode = 1;
          break;
      }
    });
}
