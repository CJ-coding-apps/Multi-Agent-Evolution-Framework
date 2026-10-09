import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { makeRunId } from '@maf/types';
import { HarnessStore, shortSha } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { GoldenRunner, describeJudge, makeLlmJudge } from '@maf/eval-harness';
import type { GoldenSuiteResult, GoldenTask } from '@maf/eval-harness';
import { readFile } from 'node:fs/promises';
import { evolve } from '@maf/evolver';
import { createDefaultRegistry } from '@maf/tools';
import { createDefaultProcessorRegistry } from '@maf/processors';
import { SecurityReviewGate } from '@maf/git-ops';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';
import { buildRunStack, resolveCorpusRoot } from '../wiring.js';
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
    .description('AEGIS-lite harness evolution over the golden corpus (offline; never in the serving path)')
    .option('-a, --adapter <name>', 'Meta-agent adapter', 'claude')
    .option('-m, --model <model>', 'Meta-agent model')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .option('--corpus <path>', 'Golden corpus root', '.maf/goldens')
    .option('--harness <ref>', 'Starting harness id/sha/file (default: current, else the committed default)')
    .option('--rounds <n>', 'Max evolution rounds', '10')
    .option('--patience <n>', 'Consecutive no-ship rounds before stopping', '3')
    .option('--policy <path>', 'Policy file', '.maf/policy.yaml')
    .option('--approve-sensitive', 'Pre-approve edits to safety-adjacent roles (security/reviewer)', false)
    .option('--allow-ungoverned', "Let writer roles run on the cli tier, outside MAF's policy, redaction, attestation and processor hooks (D-01)")
    .action(async (opts: EvolveCliOpts) => {
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
        cwd, mafDir, policyPath: path.resolve(cwd, opts.policy), adapter, runId,
        harnessSha: base.sha, headless: true, ...(opts.model ? { model: opts.model } : {}),
        ...(opts.allowUngoverned === true ? { allowUngoverned: true } : {}),
      });

      const corpus: GoldenTask[] = JSON.parse(await readFile(path.join(corpusRoot, 'corpus.json'), 'utf8'));

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

      const runGoldensFor = (harness: HarnessConfig) => runnerFor(harness, 2).run();

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
        runSmoke,
        onShip: async (candidate, improvements) => {
          await store.save(candidate);
          await store.setCurrent(candidate.sha);
          console.log(`[maf] SHIP ${candidate.id} (${shortSha(candidate.sha)}) — improves ${improvements.join(', ')}`);
        },
        roleCatalog: base.roleSet.roles.map((r) => ({
          role: r.role, description: r.description ?? '', allowedTools: r.allowedTools,
          ...(r.model ? { model: r.model } : {}),
        })),
        knownToolIds: new Set(createDefaultRegistry().getAll().map((t) => String(t.id))),
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
      stack.close();
    });
}
