import crypto from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { componentId } from '@maf/attestation';
import { SecurityReviewGate } from '@maf/git-ops';
import { makeRunId } from '@maf/types';
import type { CliAdapter, RunId, RunStatus } from '@maf/types';
import { HarnessStore, shortSha } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { MemoryGraph } from '@maf/memory-graph';
import { RoleRegistry, roleSetFromHarness } from '@maf/roles';
import { createDefaultRegistry } from '@maf/tools';
import {
  GoldenRunner, ScoreRecorder, ScriptedAdapter, SCRIPTED_ADAPTER_NAME, assertGoldenCorpus,
  describeJudge, loadScriptedTasks, makeLlmJudge, seesawDecision,
} from '@maf/eval-harness';
import type { GoldenSuiteResult } from '@maf/eval-harness';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';
import { ensureMafDir } from '../ensureMafDir.js';
import { RESOLVER_REFS, buildRunStack, resolveCorpusRoot, resolveRunHarness } from '../wiring.js';
import { committedDefaults, loadHarnessFile, locateStoredHarness } from './harness.js';

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
 * harness file), else CURRENT, else the committed `.maf/harnesses/default-<sha>.json` — which is
 * all a fresh clone that has never run maf has. The committed default also answers to its id and
 * (short) sha, and is read in place, not imported into the store. A stored ref and CURRENT go
 * through `run`'s own resolution (`resolveRunHarness`).
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
  if (plain && (await store.current()) === undefined) {
    const defaults = await committedDefaults(store);
    if (defaults.length !== 1) {
      throw new Error(
        `goldens: no harness to evaluate — no --harness, no CURRENT in ${store.dir}, and ` +
        `${defaults.length === 0 ? 'no' : 'more than one'} committed default-<sha>.json there. ` +
        'Pass --harness, or run maf once to mint one.',
      );
    }
    // Located by its sha, like a typed ref, so `evolve` starting from it and `goldens` measuring it
    // name one harness; a copy `run` imported into the store is the same content.
    const file = defaults[0] as string;
    return locateStoredHarness(store, path.basename(file).slice('default-'.length, -'.json'.length));
  }
  // Everything else is resolved as `run` resolves it, so a CURRENT that tracks the roles file
  // evaluates the roles file now, and a harness whose prompts are not in its sha is refused.
  const { harness } = await resolveRunHarness({
    store, ref: plain ? undefined : ref, rolesPath: path.join(mafDir, 'roles.yaml'), mafDir, baseTools: createDefaultRegistry(),
  });
  return { harness, source: (await store.configSource(harness)).uri };
}

/**
 * `scripted` is resolved here because its script is corpus data (`<corpus>/scripted.json`), which
 * an adapter registry has no way to know; every other name comes from the registry.
 */
export async function resolveGoldensAdapter(name: string, corpusRoot: string): Promise<CliAdapter> {
  if (name !== SCRIPTED_ADAPTER_NAME) return resolveAdapter(name, createAdapterRegistry());
  const corpus: unknown = JSON.parse(await readFile(path.join(corpusRoot, 'corpus.json'), 'utf8'));
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
  policyPath: string;
  runId: RunId;
  /** `--allow-ungoverned`: a writer role may run on the cli tier, outside MAF's gates (D-01). */
  allowUngoverned?: boolean;
}

/**
 * Runs the corpus isolated from every past run (D-14). The dispatch stack — memory graph, LCM,
 * transcripts — lives in a temporary directory, never the project's `.maf/`, and its graph is
 * emptied before each attempt, so neither a past run nor an earlier attempt reaches a prompt.
 * One graph for the suite rather than one per attempt: each Kùzu database reserves 8 TB of
 * address space and `MemoryGraph.close()` does not release it, so a process cannot open more
 * than a handful. The signed bundle, holding every evaluation's tool calls, is copied into the
 * project's attestations before the directory is removed.
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
      cwd: o.cwd, mafDir: evalDir, policyPath: o.policyPath, adapter: o.agent, runId: o.runId,
      harnessSha: o.harness.sha, headless: true, ...model,
      ...(o.allowUngoverned === true ? { allowUngoverned: true } : {}),
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
          return stack.dispatchTask(o.harness, task.role, task.prompt, workDir, timeoutMs, temperature);
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
      }).run();
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
      stack.close();
    }
    const bundlePath = path.join(mafDir, 'attestations', `${o.runId}.bundle.json`);
    await mkdir(path.dirname(bundlePath), { recursive: true });
    await copyFile(path.join(evalDir, 'attestations', `${o.runId}.bundle.json`), bundlePath);
    return { result, bundlePath };
  } finally {
    await rm(evalDir, { recursive: true, force: true });
  }
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
    parsed = JSON.parse(await readFile(file, 'utf8'));
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
    .option('--harness <ref>', 'Harness id/sha/file (default: current, else the committed default)')
    .option('--attempts <k>', 'pass@k attempts per task', '2')
    .option('--policy <path>', 'Policy file', '.maf/policy.yaml')
    .option('--allow-ungoverned', "Let writer roles run on the cli tier, outside MAF's policy, redaction, attestation and processor hooks (D-01)")
    .description('Run the golden corpus under a harness, isolated from past runs (temperature pinned to 0 where the backend supports it)')
    .action(async (opts: GoldenOpts) => {
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
        attempts: Number(opts.attempts) || 2, policyPath: path.resolve(cwd, opts.policy), runId,
        ...(opts.allowUngoverned === true ? { allowUngoverned: true } : {}),
      });

      // The score goes into the project's memory for the evolver's digest; nothing reads it back
      // into an evaluation, which never opens this graph.
      const graph = new MemoryGraph(path.join(mafDir, 'memory.kuzu'));
      try {
        await new ScoreRecorder(graph, runId).record(result);
      } finally {
        graph.close();
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
