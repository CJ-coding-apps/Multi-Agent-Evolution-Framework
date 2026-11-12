import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { makeRunId, refusePrototypeKey } from '@maf/types';
import type { AdapterName, CliAdapter, PermissionLevel } from '@maf/types';
import { HarnessStore, shortSha } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { effectiveTier, roleSetFromHarness } from '@maf/roles';
import {
  GoldenRunner, SCRIPTED_ADAPTER_NAME, ScoreRecorder, ScriptedAdapter, describeJudge,
  loadScriptedBundle, loadSplits, makeLlmJudge,
} from '@maf/eval-harness';
import type { GoldenSuiteResult, GoldenTask, LoadedSplits } from '@maf/eval-harness';
import { readFile } from 'node:fs/promises';
import { EvolveBudget, HELD_OUT_MIN_REPEATS, UsageMeter, evolve, meterAdapter } from '@maf/evolver';
import type { EvolveOptions, EvolveReport } from '@maf/evolver';
import { createDefaultRegistry } from '@maf/tools';
import { createDefaultProcessorRegistry, DEFAULT_BUNDLE_REFS } from '@maf/processors';
import { SecurityReviewGate } from '@maf/git-ops';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';
import { buildRunStack, resolveCorpusRoot } from '../wiring.js';
import type { RunStack } from '../wiring.js';
import { DEFAULT_MAF_CONFIG } from '../config/ConfigLoader.js';
import { resolveGoldensHarness } from './goldens.js';

/**
 * Evolve's smoke check: one attempt of the task it names. It ran the whole corpus and judged
 * `tasks[0]`, so a candidate was accepted or refused on whichever task happened to be first.
 */
export async function smokeCheck(runner: { run(only?: readonly string[]): Promise<GoldenSuiteResult> }, taskId: string): Promise<void> {
  const res = await runner.run([taskId]);
  const error = res.tasks.find((t) => t.taskId === taskId)?.attempts[0]?.error;
  if (error) throw new Error(error);
}

interface EvolveCliOpts {
  adapter: string; model?: string; dir: string; corpus: string; harness?: string;
  rounds: string; patience: string; policy: string; approveSensitive: boolean; allowUngoverned?: boolean;
  maxSeconds?: string; maxTokens?: string; maxUsd?: string; usdPerMillionTokens?: string;
  heldOutRepeats?: string;
}

/** A positive number from a flag, refused by name rather than silently ignored (D-57). */
function positiveNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${flag} must be a positive number, got "${raw}"`);
  return n;
}

/** What a test may replace. The real registry and streams are the defaults. */
export interface EvolveDeps {
  /** The registry `--adapter` resolves against; `createAdapterRegistry()` when unset. */
  adapters?: Map<AdapterName, CliAdapter>;
  /**
   * Where a paid-for golden result becomes evidence. Defaults to the `ScoreRecorder` over the run's
   * graph; a test injects one that fails on a chosen result to drive the `record-failed` path
   * (R2-L4) without making the graph unwritable.
   */
  recordGoldens?: (result: GoldenSuiteResult) => Promise<void>;
}

export function registerEvolveCommand(program: Command, deps: EvolveDeps = {}): void {
  const evolveCommand = program
    .command('evolve')
    .description('AEGIS-lite harness evolution over the golden corpus (experimental; drives a live adapter, claude by default; never in the serving path)')
    .option('-a, --adapter <name>', 'Meta-agent adapter', 'claude')
    .option('-m, --model <model>', 'Meta-agent model')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .option('--corpus <path>', 'Golden corpus root', '.maf/goldens')
    .option('--harness <ref>', 'Starting harness id/sha/file (default: current, else the roles file)')
    .option('--rounds <n>', 'Max evolution rounds', '10')
    .option('--patience <n>', 'Consecutive no-ship rounds before stopping', '3')
    .option('--policy <path>', 'Policy file', '.maf/policy.yaml')
    .option(
      '--approve-sensitive',
      'Spend to evaluate edits to safety-adjacent roles (security/reviewer) in full (critic, smoke, '
      + 'goldens) instead of archiving them unevaluated; the verdict is still needs-approval and the '
      + 'candidate is stored, not made current, and applied only by a human with '
      + '`maf evolve approve <id>` (or `maf harness set-current <sha>`); '
      + 'does not approve a tool widening',
      false,
    )
    .option('--allow-ungoverned', "Let writer roles run on the cli tier, outside MAF's policy, redaction, attestation and processor hooks (D-01)")
    .option('--max-seconds <n>', 'Wall-clock budget for the whole evolution run (D-57)')
    .option('--max-tokens <n>', 'Token budget for the whole evolution run; spend is estimated from characters (D-57)')
    .option('--max-usd <n>', 'Dollar budget; requires --usd-per-million-tokens so spend can be priced (D-57)')
    .option('--usd-per-million-tokens <n>', 'Price used to turn the token estimate into dollars (D-57)')
    .option('--held-out-repeats <n>', 'Times each harness is scored on the held-out split (default 3, minimum 3; D-57)')
    // A positional here is a typo, not an intent: commander would otherwise start a whole evolution
    // run and spend money on it (M1). `approve` is a real subcommand now — see below — not an excess
    // argument.
    .allowExcessArguments(false)
    .action(async (opts: EvolveCliOpts, cmd: Command) => {
      const cwd = path.resolve(opts.dir);
      const mafDir = path.join(cwd, '.maf');
      const corpusRoot = await resolveCorpusRoot(cwd, opts.corpus);
      const runId = makeRunId(crypto.randomUUID());

      // D-57: the loop is bounded in wall-clock, tokens and dollars, and the report states what it
      // spent. A budget flag that cannot be honoured is refused before anything is paid for.
      let maxWallClockMs: number | undefined;
      let maxTokens: number | undefined;
      let maxUsd: number | undefined;
      let usdPerMillionTokens: number | undefined;
      let heldOutRepeats: number | undefined;
      try {
        const seconds = positiveNumber(opts.maxSeconds, '--max-seconds');
        maxWallClockMs = seconds === undefined ? undefined : Math.round(seconds * 1000);
        maxTokens = positiveNumber(opts.maxTokens, '--max-tokens');
        maxUsd = positiveNumber(opts.maxUsd, '--max-usd');
        usdPerMillionTokens = positiveNumber(opts.usdPerMillionTokens, '--usd-per-million-tokens');
        if (maxUsd !== undefined && usdPerMillionTokens === undefined)
          throw new Error('--max-usd needs --usd-per-million-tokens: without a price the dollar spend cannot be computed');
        // R2-H3: the held-out verdict is a repeated measurement. Refuse an unusable count here, before
        // the first round, rather than paying for a run that cannot state a verdict.
        if (opts.heldOutRepeats !== undefined) {
          const n = Number(opts.heldOutRepeats);
          if (!Number.isInteger(n) || n < HELD_OUT_MIN_REPEATS)
            throw new Error(`--held-out-repeats must be an integer of at least ${HELD_OUT_MIN_REPEATS} (got "${opts.heldOutRepeats}")`);
          heldOutRepeats = n;
        }
      } catch (err) {
        console.error(`[maf] evolve: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
        return;
      }
      const budget = new EvolveBudget({
        ...(maxWallClockMs !== undefined ? { maxWallClockMs } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(maxUsd !== undefined ? { maxUsd } : {}),
      });

      const store = new HarnessStore(mafDir);
      // The harness `goldens run` would measure, so a fresh clone evolves from the one it evaluates.
      const { harness: base } = await resolveGoldensHarness(mafDir, opts.harness);
      console.log(`[maf] evolve ${runId} | base: ${base.id} (${shortSha(base.sha)}) | rounds=${opts.rounds} patience=${opts.patience}`);

      // WP-3.9 G5: a corpus file, through the shared reviver like `goldens run` reads it. Read
      // before the adapter resolves: the scripted backend's answers live beside the corpus.
      const corpus: GoldenTask[] = JSON.parse(
        await readFile(path.join(corpusRoot, 'corpus.json'), 'utf8'), refusePrototypeKey,
      );

      // D-57: the corpora are two. The evolver only ever sees `train`; the survivor is scored on
      // `held-out` at the end, and that score is reported as a delta against the baseline's.
      // A split that is not a partition, or that names a task this corpus does not have, is
      // refused here before anything is opened or paid for.
      let splits: LoadedSplits;
      try {
        splits = await loadSplits(corpusRoot, corpus);
      } catch (err) {
        console.error(`[maf] evolve: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
        return;
      }

      // The scripted stand-in is built from this corpus's scripts (D-14). The registry's bare
      // `scripted` adapter has no scripts, so `evolve --adapter scripted` could not answer its own
      // first task. Only that bare one is replaced: a caller-injected adapter (a test's map, or a
      // mocked `resolveAdapter`) is already scripted, and resolving first is what proves it.
      let adapter: CliAdapter = await resolveAdapter(opts.adapter, deps.adapters ?? createAdapterRegistry());
      if (opts.adapter === SCRIPTED_ADAPTER_NAME && deps.adapters === undefined && adapter instanceof ScriptedAdapter) {
        const bundle = await loadScriptedBundle(corpusRoot, corpus);
        adapter = new ScriptedAdapter(bundle.tasks, bundle.evolution);
      }

      // R2-H4: every model call this run makes — role turns and tool-loop turns, the planner, the
      // critic, the judge, the security gate and LCM summaries — goes through the adapter, so the
      // meter wraps it once and the budget is fed per call. A backend that reports usage is
      // believed; where it reports nothing the charge is a bytes-based estimate.
      const usage = new UsageMeter(usdPerMillionTokens);
      const meteredAdapter = meterAdapter(adapter, usage, (call) => {
        budget.addTokens(call.tokens, call.source);
        if (call.usd !== undefined) budget.addUsd(call.usd, call.usdSource ?? 'estimated');
      });

      const stackConfig: Parameters<typeof buildRunStack>[0] = {
        cwd, mafDir, adapter: meteredAdapter, runId,
        // D-49, F7: the same resolution `run` and `goldens` take.
        policy: { value: opts.policy, typed: cmd.getOptionValueSource('policy') === 'cli' },
        harnessSha: base.sha, headless: true, ...(opts.model ? { model: opts.model } : {}),
        ...(opts.allowUngoverned === true ? { allowUngoverned: true } : {}),
        // WP-3.2 F12: the stack takes resolved settings. `evolve` reads no `maf.config`, so the
        // shipped defaults are its resolution — one object, not a second set of constants here.
        lcm: DEFAULT_MAF_CONFIG.lcm,
      };
      const stack = await buildRunStack(stackConfig);

      // R2-H2: the held-out score must leave no trace the next digest can read. Its stack is a
      // second one whose graph is a throwaway directory — the dispatcher, policy engine and
      // process hooks write their GoldenResult/PolicyEvent/Failure nodes there, never into
      // `.maf/memory.kuzu`. Roles, prompts, policy and transcripts still come from `mafDir`.
      let heldOutStack: RunStack | undefined;
      let heldOutGraphDir: string | undefined;
      const stackForHeldOut = async (): Promise<RunStack> => {
        if (heldOutStack !== undefined) return heldOutStack;
        heldOutGraphDir = await mkdtemp(path.join(tmpdir(), 'maf-heldout-'));
        heldOutStack = await buildRunStack({ ...stackConfig, graphDir: heldOutGraphDir });
        return heldOutStack;
      };

      const metaGenerate = async (systemPrompt: string, userPrompt: string): Promise<string> => {
        // The metering adapter charges the call; a second charge here would count it twice.
        const result = await meteredAdapter.invoke({
          prompt: userPrompt, systemPrompt,
          workingDir: cwd, timeoutMs: 300_000,
          maxOutputBytes: 256 * 1024,
          ...(opts.model ? { model: opts.model } : {}),
        });
        return result.output;
      };

      // securityScore (parity with `goldens run`): score the worst severity of a diff.
      const securityScore = async (diff: string): Promise<'none' | 'low' | 'medium' | 'high' | 'critical'> => {
        if (!diff.trim()) return 'none';
        const gate = new SecurityReviewGate({
          adapter: meteredAdapter, projectRoot: cwd, securityPrompt: stack.securityPrompt,
          ...(opts.model ? { model: opts.model } : {}),
        });
        const res = await gate.reviewDiff(diff);
        const rank: Record<string, number> = { none: 0, info: 1, low: 1, medium: 2, high: 3, critical: 4 };
        let worst = 0;
        for (const f of res.findings) worst = Math.max(worst, rank[f.severity] ?? 1);
        return (['none', 'low', 'medium', 'high', 'critical'] as const)[worst] ?? 'critical';
      };

      const agent = { adapter: adapter.name, ...(opts.model ? { model: opts.model } : {}) };
      const runnerFor = (
        harness: HarnessConfig, attempts: number, split?: { name: 'train' | 'held-out'; sha: string },
        runStack: RunStack = stack,
      ) =>
        new GoldenRunner({
          corpusRoot, harnessSha: harness.sha, harnessId: harness.id,
          attempts, temperature: 0,
          ...(split !== undefined ? { split } : {}),
          dispatch: async (task, workDir, { timeoutMs, temperature }) => {
            // L5: the corpus task id travels with the dispatch, so a refusal's `PolicyEvent` names
            // the task whose score it belongs to.
            // D-57 (R2-H4): the dispatch is charged by the metering adapter every model call it
            // makes, tool-loop turns and injected context included — not once per task here.
            return runStack.dispatchTask(harness, task.role, task.prompt, workDir, timeoutMs, temperature, task.id);
          },
          ...agent,
          llmJudge: {
            verdict: makeLlmJudge({ adapter: meteredAdapter, ...(opts.model ? { model: opts.model } : {}) }, cwd),
            disclosure: describeJudge(agent, agent),
          },
          securityScore,
        });

      // WP-3.7 amendment item 1: the loop's own runs are evidence. `goldens run` already writes
      // each score through this recorder; `evolve` paid for the same runs and threw the evidence
      // away, so every round's digest was empty. One recorder for the run, on the graph the loop
      // digests.
      const scoreRecorder = new ScoreRecorder(stack.graph, runId);

      // D-57: everything the evolver measures is the train split. The held-out split is measured
      // only by `runHeldOut`, only at the end, and never recorded as evidence.
      const runGoldensFor = (harness: HarnessConfig): Promise<GoldenSuiteResult> =>
        runnerFor(harness, 2, { name: 'train', sha: splits.sha }).run(splits.train);

      // R2-H2: on the isolated stack, so a refusal or a gate failure during a held-out attempt
      // writes to the throwaway graph, not to the one the next digest reads.
      const runHeldOut = async (harness: HarnessConfig): Promise<GoldenSuiteResult> =>
        runnerFor(harness, 2, { name: 'held-out', sha: splits.sha }, await stackForHeldOut())
          .run(splits.heldOut);

      const runSmoke = (harness: HarnessConfig, taskId: string) => {
        // A smoke run is a measurement too. The planner's target tasks come from evidence in the
        // train split, but a hallucinated id must not spend a held-out task either.
        if (!splits.train.includes(taskId))
          throw new Error(`smoke task "${taskId}" is not in the train split; the evolver may not measure a held-out task`);
        return smokeCheck(runnerFor(harness, 1), taskId);
      };

      // Static registry membership = the allowlist (§10.2; registry-driven, not hardcoded here)
      const processorNames = new Set(createDefaultProcessorRegistry().names());

      const evolveOptions: EvolveOptions = {
        baseHarness: base,
        runId,
        maxRounds: Number(opts.rounds) || 10,
        patience: Number(opts.patience) || 3,
        metaGenerate,
        graph: stack.graph,
        runGoldens: runGoldensFor,
        // D-57: the evolver plans from the train split only, and the survivor is scored against
        // the held-out split — twice each — with the delta and noise floor in the report.
        splitName: 'train',
        runHeldOut,
        heldOutSplitsSha: splits.sha,
        ...(heldOutRepeats !== undefined ? { heldOutRepeats } : {}),
        budget,
        usage,
        recordGoldens: deps.recordGoldens ?? ((result) => scoreRecorder.record(result)),
        // Amendment item 2: the rounds were silent, and six live rounds of `no_op` looked like a
        // planner preference. Each round now says what it did and why, including "no evidence".
        onRound: (r) => console.log(`[maf] round ${r.round}: ${r.outcome} — ${r.note}`),
        runSmoke,
        onShip: async (candidate, improvements) => {
          await store.save(candidate);
          await store.setCurrent(candidate.sha);
          console.log(`[maf] SHIP ${candidate.id} (${shortSha(candidate.sha)}) — improves ${improvements.join(', ')}`);
        },
        // M1: a candidate a human has to apply is saved but not made current. The evaluation is in
        // the round record; CURRENT moves only when the human runs `maf harness set-current`.
        storeCandidate: async (candidate) => {
          await store.save(candidate);
          console.log(`[maf] STORED ${candidate.id} (${shortSha(candidate.sha)}) — not current; apply it with \`maf evolve approve ${candidate.id}\` or \`maf harness set-current ${candidate.sha}\``);
        },
        // §7: which tier each role actually runs on under this adapter, so the gate can refuse an
        // edit that could not reach it (`maxToolIterations` on a cli-tier role changes nothing).
        // The candidate cannot change a role's tier, so the base's answer holds for it too.
        roleTiers: new Map(roleSetFromHarness(base.roleSet).roles.map((r) => [r.role, effectiveTier(r, adapter)])),
        adapterName: adapter.name,
        roleCatalog: base.roleSet.roles.map((r) => ({
          role: r.role, description: r.description ?? '', allowedTools: r.allowedTools,
          ...(r.model ? { model: r.model } : {}),
        })),
        knownToolIds: new Set(createDefaultRegistry().getAll().map((t) => String(t.id))),
        // What each known tool may do, so the gate can tell a widening that hands a role the tree
        // (`fs.write`, `test.run`) from one that hands it another way to read.
        toolPermissions: new Map<string, PermissionLevel>(
          createDefaultRegistry().getAll().map((t): [string, PermissionLevel] => [String(t.id), t.permissionLevel]),
        ),
        knownProcessorNames: processorNames,
        // R2-H1: the default bundle lives in `@maf/processors`; the CLI already depends on it, so
        // it hands the refs to the evolver rather than the evolver taking a dependency for them.
        defaultBundleRefs: DEFAULT_BUNDLE_REFS,
        judgeOnlyTaskIds: new Set(corpus
          .filter((t) => t.verifiers.every((v) => v.kind === 'llm-judge'))
          .map((t) => t.id)),
        ...(opts.approveSensitive ? { approveSensitive: true } : {}),
        // R2-H2: the digest is fenced to the train split — by row (`split`/`splits_sha`), by task
        // id, and by scrubbing every corpus id outside it from free text.
        evidenceScope: {
          trainTaskIds: new Set(splits.train),
          splitsSha: splits.sha,
          corpusTaskIds: new Set(corpus.map((t) => t.id)),
        },
      };

      // L2: the stack is released however the loop ends — a throw from the loop used to leave the
      // graph's files open. A record failure does not throw out of `evolve`: it comes back as a
      // partial report, so the rounds already paid for are still written below.
      let report: EvolveReport;
      try {
        report = await evolve(evolveOptions);
      } finally {
        await stack.close();
        // R2-H2: the held-out stack and its throwaway graph go with the run.
        if (heldOutStack !== undefined) await heldOutStack.close();
        if (heldOutGraphDir !== undefined) await rm(heldOutGraphDir, { recursive: true, force: true });
      }

      const reportPath = path.join(mafDir, 'evolve', `${runId}.json`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
      console.log(`[maf] evolve done: ships=${report.ships} stop=${report.stopReason} → ${reportPath}`);
      // D-57: what it spent and what the held-out split said, in the terminal as well as the report.
      if (report.budget !== undefined) console.log(`[maf] ${report.budget.statement}`);
      // R2-H4: every model call the run made, and whether each figure was reported or estimated.
      if (report.usage !== undefined) console.log(`[maf] ${report.usage.statement}`);
      if (report.heldOut !== undefined) console.log(`[maf] ${report.heldOut.statement}`);
      if (report.error !== undefined) {
        // The run did not evolve to a stopping condition; the report above is what it paid for.
        console.error(`[maf] evolve stopped: ${report.error}`);
        process.exitCode = 1;
      }
    });

  // §7: "sensitive candidates are stored and `maf evolve approve <id>` ships one." The loop stores
  // a needs-approval candidate and deliberately leaves CURRENT alone (M1); this is the human half.
  // It makes the same single write `maf harness set-current <sha>` makes, so a candidate applied
  // either way lands identically. Nothing is spent: no adapter is built and no run starts.
  // The working directory is `evolve`'s own `-d`, read through `optsWithGlobals`. Commander parses an
  // option typed after a subcommand name against the *parent's* options, so a `-d` declared here as
  // well never receives the value: its default is what `opts().dir` shows. One declaration, one value.
  evolveCommand
    .command('approve <candidate>')
    .description('Apply a stored candidate harness (id or sha) by making it CURRENT. Spends nothing and starts no run')
    .action(async (candidate: string, _opts: unknown, cmd: Command) => {
      const dir = (cmd.optsWithGlobals() as { dir?: string }).dir ?? process.cwd();
      const store = new HarnessStore(path.join(path.resolve(dir), '.maf'));
      try {
        const found = await store.tryLoad(candidate);
        if (found === undefined) {
          console.error(
            `[maf] evolve approve: no stored harness named ${candidate}. Candidates are stored by ` +
            '`maf evolve` under .maf/harnesses; list them with `maf harness list`.',
          );
          process.exitCode = 2;
          return;
        }
        await store.setCurrent(found.sha);
        console.log(`[maf] APPROVED ${found.id} (${shortSha(found.sha)}) — now current for this project`);
      } catch (err) {
        // A refused snapshot (an older legacy-default that the next plain run would re-mint over),
        // a tampered file or a corrupt CURRENT: say so and fail, never half-apply.
        console.error(`[maf] evolve approve: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
