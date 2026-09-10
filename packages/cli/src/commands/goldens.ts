import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { SecurityReviewGate } from '@maf/git-ops';
import { makeRunId } from '@maf/types';
import { HarnessStore, shortSha } from '@maf/harness-config';
import {
  GoldenRunner, ScoreRecorder, seesawDecision,
} from '@maf/eval-harness';
import type { GoldenSuiteResult, TaskDispatcher } from '@maf/eval-harness';
import { createAdapterRegistry, resolveAdapter } from '../AdapterRegistry.js';
import { buildRunStack, resolveCorpusRoot } from '../wiring.js';

interface GoldenOpts {
  adapter: string; model?: string; dir: string; corpus: string; harness?: string;
  attempts: string; policy: string;
}

export function registerGoldensCommand(program: Command): void {
  const cmd = program.command('goldens').description('Golden-suite evaluation for harness versions');

  cmd
    .command('run')
    .option('-a, --adapter <name>', 'CLI adapter', 'claude')
    .option('-m, --model <model>', 'Model name')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .option('--corpus <path>', 'Golden corpus root', '.maf/goldens')
    .option('--harness <ref>', 'Harness id/sha (default: current)')
    .option('--attempts <k>', 'pass@k attempts per task', '2')
    .option('--policy <path>', 'Policy file', '.maf/policy.yaml')
    .description('Run the golden corpus under a harness (temperature pinned to 0 where the backend supports it)')
    .action(async (opts: GoldenOpts) => {
      const cwd = path.resolve(opts.dir);
      const mafDir = path.join(cwd, '.maf');
      const corpusRoot = await resolveCorpusRoot(cwd, opts.corpus);
      const runId = makeRunId(crypto.randomUUID());

      const store = new HarnessStore(mafDir);
      const harness = await store.load(opts.harness ?? 'current');
      console.log(`[maf] goldens run ${runId} | harness: ${harness.id} (${shortSha(harness.sha)})`);

      const adapter = await resolveAdapter(opts.adapter, createAdapterRegistry());
      const stack = await buildRunStack({
        cwd, mafDir, policyPath: path.resolve(cwd, opts.policy), adapter, runId,
        harnessSha: harness.sha, ...(opts.model ? { model: opts.model } : {}),
      });
      // Role-driven security prompt if the harness defines a security role
      {
        const probe = stack.rolesFor(harness);
        if (probe.hasRole('security')) stack.securityPrompt = await probe.loadPrompt(probe.getRole('security'));
      }

      const dispatch: TaskDispatcher = async (task, workDir, { timeoutMs, temperature }) =>
        stack.dispatchTask(harness, task.role, task.prompt, workDir, timeoutMs, temperature);

      const runner = new GoldenRunner({
        corpusRoot,
        harnessSha: harness.sha,
        harnessId: harness.id,
        attempts: Number(opts.attempts) || 2,
        temperature: 0,
        dispatch,
        llmJudge: (rubric, subject) => stack.judge(rubric, subject),
        securityScore: async (diff) => {
          if (!diff.trim()) return 'none';
          const gate = new SecurityReviewGate({
            adapter, projectRoot: cwd, securityPrompt: stack.securityPrompt,
            ...(opts.model ? { model: opts.model } : {}),
          });
          const res = await gate.reviewDiff(diff);
          const rank: Record<string, number> = { none: 0, info: 1, low: 1, medium: 2, high: 3, critical: 4 };
          let worstRank = 0;
          for (const f of res.findings) worstRank = Math.max(worstRank, rank[f.severity] ?? 1);
          return (['none', 'low', 'medium', 'high', 'critical'] as const)[worstRank] ?? 'critical';
        },
      });

      const result = await runner.run();
      await new ScoreRecorder(stack.graph, runId).record(result);

      const resultsDir = path.join(mafDir, 'goldens', 'results');
      await mkdir(resultsDir, { recursive: true });
      const resultPath = path.join(resultsDir, `${harness.sha}.json`);
      await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8');

      await stack.attestor.bundle(
        { id: `@maf/adapter-${opts.adapter}@0.1.0`, modelVersion: opts.model ?? 'default' },
        {
          configSource: { uri: path.join(mafDir, 'harnesses', `${harness.sha}.yaml`), digest: { sha256: harness.sha } },
          parameters: { harnessId: harness.id, eval: 'goldens' },
          environment: {},
        },
        [],
        {
          harnessSha: harness.sha, harnessId: harness.id,
          solvedTaskIds: result.solvedTaskIds, total: result.tasks.length, ranAt: result.ranAt,
        },
      );

      console.log(`[maf] goldens: solved ${result.solvedTaskIds.length}/${result.tasks.length} → ${resultPath}`);
      stack.close();
    });

  cmd
    .command('compare <shaA> <shaB>')
    .option('-d, --dir <path>', 'Working directory', process.cwd())
    .description('Seesaw-compare two harness golden results (A=current baseline, B=candidate). Exits 1 on regression.')
    .action(async (shaA: string, shaB: string, opts: { dir: string }) => {
      const resultsDir = path.join(path.resolve(opts.dir), '.maf', 'goldens', 'results');
      const load = async (sha: string): Promise<GoldenSuiteResult> =>
        JSON.parse(await readFile(path.join(resultsDir, `${sha}.json`), 'utf8')) as GoldenSuiteResult;
      const baseline = await load(shaA);
      const candidate = await load(shaB);
      const decision = seesawDecision(baseline, candidate);
      switch (decision.kind) {
        case 'ship':
          console.log(`[maf] SHIP ${shortSha(shaB)}: improves ${decision.improvements.join(', ')}`);
          process.exitCode = 0;
          break;
        case 'no-change':
          console.log(`[maf] NO-CHANGE ${shortSha(shaB)} (does not ship)`);
          process.exitCode = 0;
          break;
        case 'reject':
          console.error(`[maf] REJECT ${shortSha(shaB)}: regresses ${decision.regressions.join(', ')}`);
          process.exitCode = 1;
          break;
      }
    });
}
