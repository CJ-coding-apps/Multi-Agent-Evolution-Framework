import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { makeRunId, refusePrototypeKey } from '@maf/types';
import type { PermissionLevel } from '@maf/types';
import { HarnessStore, shortSha } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { GoldenRunner, ScoreRecorder, describeJudge, makeLlmJudge } from '@maf/eval-harness';
import type { GoldenSuiteResult, GoldenTask } from '@maf/eval-harness';
import { readFile } from 'node:fs/promises';
import { evolve } from '@maf/evolver';
import { createDefaultRegistry } from '@maf/tools';
import { createDefaultProcessorRegistry } from '@maf/processors';
import { SecurityReviewGate } from '@maf/git-ops';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';
import { buildRunStack, resolveCorpusRoot } from '../wiring.js';
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
}

export function registerEvolveCommand(program: Command): void {
  program
    .command('evolve')
    .description('AEGIS-lite harness evolution over the golden corpus (experimental; drives a live adapter, claude by default; never in the serving path)')
    .option('-a, --adapter <name>', 'Meta-agent adapter', 'claude')
    .option('-m, --model <model>', 'Meta-agent model')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .option('--corpus <path>', 'Golden corpus root', '.maf/goldens')
    .option('--harness <ref>', 'Starting harness id/sha/file (default: current, else the committed default)')
    .option('--rounds <n>', 'Max evolution rounds', '10')
    .option('--patience <n>', 'Consecutive no-ship rounds before stopping', '3')
    .option('--policy <path>', 'Policy file', '.maf/policy.yaml')
    .option(
      '--approve-sensitive',
      'Spend to evaluate edits to safety-adjacent roles (security/reviewer) in full (critic, smoke, '
      + 'goldens) instead of archiving them unevaluated; the verdict is still needs-approval and the '
      + 'candidate is stored, not made current, and applied only by a human with '
      + '`maf harness set-current <candidateSha>` (WP-3.7 will add `maf evolve approve` as a shortcut); '
      + 'does not approve a tool widening',
      false,
    )
    .option('--allow-ungoverned', "Let writer roles run on the cli tier, outside MAF's policy, redaction, attestation and processor hooks (D-01)")
    // `maf evolve approve <id>` was never this command's: commander would treat `approve` and `<id>`
    // as surplus arguments and start a whole evolution run, spending money on a typo (M1).
    .allowExcessArguments(false)
    .action(async (opts: EvolveCliOpts, cmd: Command) => {
      const cwd = path.resolve(opts.dir);
      const mafDir = path.join(cwd, '.maf');
      const corpusRoot = await resolveCorpusRoot(cwd, opts.corpus);
      const runId = makeRunId(crypto.randomUUID());

      const store = new HarnessStore(mafDir);
      // The harness `goldens run` would measure, so a fresh clone evolves from the one it evaluates.
      const { harness: base } = await resolveGoldensHarness(mafDir, opts.harness);
      console.log(`[maf] evolve ${runId} | base: ${base.id} (${shortSha(base.sha)}) | rounds=${opts.rounds} patience=${opts.patience}`);

      const adapter = await resolveAdapter(opts.adapter, createAdapterRegistry());
      const stack = await buildRunStack({
        cwd, mafDir, adapter, runId,
        // D-49, F7: the same resolution `run` and `goldens` take.
        policy: { value: opts.policy, typed: cmd.getOptionValueSource('policy') === 'cli' },
        harnessSha: base.sha, headless: true, ...(opts.model ? { model: opts.model } : {}),
        ...(opts.allowUngoverned === true ? { allowUngoverned: true } : {}),
        // WP-3.2 F12: the stack takes resolved settings. `evolve` reads no `maf.config`, so the
        // shipped defaults are its resolution — one object, not a second set of constants here.
        lcm: DEFAULT_MAF_CONFIG.lcm,
      });

      // WP-3.9 G5: a corpus file, through the shared reviver like `goldens run` reads it.
      const corpus: GoldenTask[] = JSON.parse(
        await readFile(path.join(corpusRoot, 'corpus.json'), 'utf8'), refusePrototypeKey,
      );

      const metaGenerate = async (systemPrompt: string, userPrompt: string): Promise<string> => {
        const result = await adapter.invoke({
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
          adapter, projectRoot: cwd, securityPrompt: stack.securityPrompt,
          ...(opts.model ? { model: opts.model } : {}),
        });
        const res = await gate.reviewDiff(diff);
        const rank: Record<string, number> = { none: 0, info: 1, low: 1, medium: 2, high: 3, critical: 4 };
        let worst = 0;
        for (const f of res.findings) worst = Math.max(worst, rank[f.severity] ?? 1);
        return (['none', 'low', 'medium', 'high', 'critical'] as const)[worst] ?? 'critical';
      };

      const agent = { adapter: adapter.name, ...(opts.model ? { model: opts.model } : {}) };
      const runnerFor = (harness: HarnessConfig, attempts: number) =>
        new GoldenRunner({
          corpusRoot, harnessSha: harness.sha, harnessId: harness.id,
          attempts, temperature: 0,
          dispatch: (task, workDir, { timeoutMs, temperature }) =>
            stack.dispatchTask(harness, task.role, task.prompt, workDir, timeoutMs, temperature),
          ...agent,
          llmJudge: {
            verdict: makeLlmJudge({ adapter, ...(opts.model ? { model: opts.model } : {}) }, cwd),
            disclosure: describeJudge(agent, agent),
          },
          securityScore,
        });

      // WP-3.7 amendment item 1: the loop's own runs are evidence. `goldens run` already writes
      // each score through this recorder; `evolve` paid for the same runs and threw the evidence
      // away, so every round's digest was empty. One recorder for the run, on the graph the loop
      // digests.
      const scoreRecorder = new ScoreRecorder(stack.graph, runId);

      const runGoldensFor = (harness: HarnessConfig): Promise<GoldenSuiteResult> => runnerFor(harness, 2).run();

      const runSmoke = (harness: HarnessConfig, taskId: string) => smokeCheck(runnerFor(harness, 1), taskId);

      // Static registry membership = the allowlist (§10.2; registry-driven, not hardcoded here)
      const processorNames = new Set(createDefaultProcessorRegistry().names());

      const report = await evolve({
        baseHarness: base,
        runId,
        maxRounds: Number(opts.rounds) || 10,
        patience: Number(opts.patience) || 3,
        metaGenerate,
        graph: stack.graph,
        runGoldens: runGoldensFor,
        recordGoldens: (result) => scoreRecorder.record(result),
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
          console.log(`[maf] STORED ${candidate.id} (${shortSha(candidate.sha)}) — not current; apply it with \`maf harness set-current ${candidate.sha}\``);
        },
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
        judgeOnlyTaskIds: new Set(corpus
          .filter((t) => t.verifiers.every((v) => v.kind === 'llm-judge'))
          .map((t) => t.id)),
        ...(opts.approveSensitive ? { approveSensitive: true } : {}),
      });

      const reportPath = path.join(mafDir, 'evolve', `${runId}.json`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
      console.log(`[maf] evolve done: ships=${report.ships} stop=${report.stopReason} → ${reportPath}`);
      await stack.close();
    });
}
