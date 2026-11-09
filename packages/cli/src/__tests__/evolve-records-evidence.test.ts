import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import type {
  AdapterInvokeOptions, AdapterInvokeResult, AdapterName, CliAdapter, TurnAdapter,
} from '@maf/types';
import { HarnessStore } from '@maf/harness-config';
import { MemoryGraph } from '@maf/memory-graph';
import { PLANNER_SYSTEM_PROMPT } from '@maf/evolver';
import { ScriptedAdapter } from '@maf/eval-harness';
import type { ScriptedTask } from '@maf/eval-harness';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { registerEvolveCommand } from '../commands/evolve.js';
import { runInit } from '../commands/init.js';
import { collector, needsLcm } from './runFixture.js';

// ORACLE (WP-3.7a MED-4). The original defect was in this CLI wiring: `evolve.ts` built the loop
// without `recordGoldens`, so every run it paid for was thrown away. Five planted bugs survived the
// whole suite — M13 (that call removed), M14 (the round print removed), M3 (the candidate not
// recorded), M5 (the candidate recorded under the base's sha) and M12 (`loadCommandPolicy` without
// the recorder). Unit tests of the loop and the engine cannot see any of them. This drives the real
// `evolve` command through commander with a scripted adapter and reads what it printed, what the
// planner was shown, and what the graph holds afterwards.

const REPO = path.resolve(__dirname, '../../../..');
const SEED = path.join(REPO, 'tests/goldens');

/** The planner's answer, and the prompt it was handed. One manifest, then no_op. */
function plannerAdapter(inner: TurnAdapter, prompts: string[]): CliAdapter & TurnAdapter {
  const answer = (output: string): AdapterInvokeResult =>
    ({ success: true, output, toolCallLog: [], exitCode: 0, duration: 0 });
  const adapter: CliAdapter & TurnAdapter = {
    name: inner.name,
    capabilities: () => inner.capabilities(),
    isAvailable: () => inner.isAvailable(),
    invoke: async (o: AdapterInvokeOptions) => {
      if (o.systemPrompt === PLANNER_SYSTEM_PROMPT) {
        prompts.push(o.prompt);
        return answer('```json\n' + JSON.stringify({
          edit: { kind: 'edit_role_prompt', role: 'coder', newPrompt: 'be thorough and systematic', rationale: 'a failed golden task' },
          expectedImprovement: 'fixes the failing task',
          targetTasks: ['coder-sum'],
        }) + '\n```');
      }
      if (o.systemPrompt?.includes('MAF harness evolution critic') === true) {
        return answer('```json\n{"verdict":"ship","notes":"plausible"}\n```');
      }
      return inner.invoke(o);
    },
    stream: (o) => inner.stream(o),
    sendTurn: (history, o) => inner.sendTurn(history, o),
  };
  return adapter;
}

interface Project {
  root: string;
  mafDir: string;
  corpus: string;
}

/**
 * A demo project with one golden task. Its script reads `sum.js` and then tries to write `.env`,
 * which the built-in policy denies — so the golden run leaves a `PolicyEvent` behind, and the task
 * is unsolved. The score is incidental; the records are the point.
 */
async function project(): Promise<Project> {
  const container = await mkdtemp(path.join(tmpdir(), 'maf-evolve-evidence-'));
  const root = await createDemoFixture(container);
  await runInit({ dir: root, out: collector() });

  const corpus = path.join(root, 'corpus');
  await mkdir(path.join(corpus, 'fixtures'), { recursive: true });
  await mkdir(path.join(corpus, 'fixtures', 'coder-sum'), { recursive: true });
  for (const file of ['sum.js', 'test.js']) {
    await writeFile(
      path.join(corpus, 'fixtures', 'coder-sum', file),
      await readFile(path.join(SEED, 'fixtures', 'coder-sum', file), 'utf8'),
      'utf8',
    );
  }
  const corpusJson = JSON.parse(await readFile(path.join(SEED, 'corpus.json'), 'utf8')) as Array<{ id: string }>;
  const task = corpusJson.find((t) => t.id === 'coder-sum');
  assert.ok(task, 'the seed corpus has coder-sum');
  await writeFile(path.join(corpus, 'corpus.json'), JSON.stringify([task]), 'utf8');

  return { root, mafDir: path.join(root, '.maf'), corpus };
}

function captureLog(t: TestContext): { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, 'log', (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); });
  t.mock.method(console, 'error', (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); });
  return { lines, errors };
}

test('MED-4: maf evolve records its golden runs, writes policy evidence and prints its rounds', needsLcm, async (t) => {
  const p = await project();
  t.after(() => rm(path.dirname(p.root), { recursive: true, force: true }));

  const task = JSON.parse(await readFile(path.join(p.corpus, 'corpus.json'), 'utf8')) as Array<{ prompt: string }>;
  const goldenTask = task[0];
  assert.ok(goldenTask);
  const script: ScriptedTask = {
    prompt: goldenTask.prompt,
    steps: [
      { tool: 'fs.read', input: { path: 'sum.js' } },
      // A writer must change the tree (the `no_work` rule); this is the real fix.
      {
        tool: 'fs.write',
        input: { path: 'sum.js', content: 'function sum(a,b){ return a + b; }\nmodule.exports = { sum };\n' },
      },
      // Denied by the built-in policy: the evidence this test looks for.
      { tool: 'fs.write', input: { path: '.env', content: 'MAF_EXAMPLE=1' } },
    ],
    final: 'Fixed sum.js; left .env alone.',
  };
  const inner = new ScriptedAdapter([script]);
  const prompts: string[] = [];
  const adapter = plannerAdapter(inner, prompts);

  const log = captureLog(t);
  const program = new Command().exitOverride();
  registerEvolveCommand(program, { adapters: new Map<AdapterName, CliAdapter>([['scripted', adapter]]) });
  await program.parseAsync([
    'evolve', '--dir', p.root, '--corpus', p.corpus, '--adapter', 'scripted',
    '--rounds', '1', '--patience', '1',
  ], { from: 'user' });

  // M14: each round says what it did. Without the `onRound` print there is no such line at all.
  assert.ok(log.lines.some((line) => /^\[maf\] round 0: [a-z-]+ — /.test(line)),
    `a round line: ${log.lines.join(' | ')}`);

  // The planner was shown the harness in force and the score its own baseline paid for (L1).
  assert.equal(prompts.length, 1, 'one planner call for one round');
  assert.match(prompts[0] ?? '', /Current harness: .*: solved 1\/1/);
  assert.match(prompts[0] ?? '', /Current harness: [^\n]*\([0-9a-f]{64}\)/,
    'the line names the sha of the harness in force');

  const base = await new HarnessStore(p.mafDir).current();
  assert.ok(base, 'the run resolved a base harness');

  const graph = new MemoryGraph(path.join(p.mafDir, 'memory.kuzu'));
  try {
    // M13: no `recordGoldens` means no GoldenResult at all. M3: a candidate that was evaluated but
    // not recorded leaves exactly one row. M5: recording the candidate under the base's sha leaves
    // one distinct sha for two harnesses.
    const goldenRows = await graph.run({
      cypher: "MATCH (n:MemoryNode) WHERE n.kind = 'GoldenResult' RETURN n.properties ORDER BY n.created_at DESC LIMIT 10",
      params: {},
    });
    const rows = goldenRows.map((raw) => JSON.parse(String(raw['n.properties'])) as {
      harnessId: string; harness_sha: string;
    });
    assert.equal(rows.length, 2,
      `the baseline and the candidate were both recorded; rounds: ${log.lines.filter((l) => l.includes('[maf] round')).join(' | ')}`);
    const shas = new Set(rows.map((r) => r.harness_sha));
    assert.equal(shas.size, 2, 'the candidate was recorded under its own sha');
    assert.ok(shas.has(base.sha), 'one row is the base the loop started from');
    assert.ok(rows.some((r) => r.harnessId.endsWith('-r1') && r.harness_sha !== base.sha),
      'the candidate row names the candidate harness');

    // M12: the policy engine was built without the graph as its recorder, so a denial left nothing.
    const policyRows = await graph.run({
      cypher: "MATCH (n:MemoryNode) WHERE n.kind = 'PolicyEvent' RETURN n.properties ORDER BY n.created_at DESC LIMIT 20",
      params: {},
    });
    const events = policyRows.map((raw) => JSON.parse(String(raw['n.properties'])) as Record<string, unknown>);
    assert.ok(events.length > 0, 'a refused tool call left a PolicyEvent behind');
    const denial = events.find((e) => e['verdict'] === 'Deny');
    assert.ok(denial, `a Deny event: ${JSON.stringify(events)}`);
    assert.equal(denial['goldenTaskId'], 'coder-sum', 'L5: the event names the golden task it belongs to');
    assert.ok(events.every((e) => e['verdict'] !== 'Allow'), 'MED-2: allowed calls are not evidence');
  } finally {
    await graph.close();
  }
});

// R2-L4: when the evidence writer fails, the run must not look like it succeeded. It exits
// non-zero, and the report left on disk keeps the round that was in flight — including the score
// that could not be written — instead of dropping it and leaving the operator nothing to act on.
test('R2-L4: a recorder failure exits 1 and the partial report keeps the in-flight round', needsLcm, async (t) => {
  const p = await project();
  t.after(() => rm(path.dirname(p.root), { recursive: true, force: true }));

  const corpusJson = JSON.parse(await readFile(path.join(p.corpus, 'corpus.json'), 'utf8')) as Array<{ prompt: string }>;
  const goldenTask = corpusJson[0];
  assert.ok(goldenTask);
  const script: ScriptedTask = {
    prompt: goldenTask.prompt,
    steps: [
      { tool: 'fs.read', input: { path: 'sum.js' } },
      // A writer must change the tree (the `no_work` rule).
      {
        tool: 'fs.write',
        input: { path: 'sum.js', content: 'function sum(a,b){ return a + b; }\nmodule.exports = { sum };\n' },
      },
    ],
    final: 'Fixed sum.js.',
  };
  const prompts: string[] = [];
  const adapter = plannerAdapter(new ScriptedAdapter([script]), prompts);

  // The baseline (call 1) records; the candidate's result (call 2) cannot be written.
  let recorded = 0;
  const log = captureLog(t);
  const program = new Command().exitOverride();
  registerEvolveCommand(program, {
    adapters: new Map<AdapterName, CliAdapter>([['scripted', adapter]]),
    recordGoldens: async () => {
      recorded++;
      if (recorded === 2) throw new Error('graph refused the evidence write');
    },
  });

  const before = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync([
      'evolve', '--dir', p.root, '--corpus', p.corpus, '--adapter', 'scripted',
      '--rounds', '1', '--patience', '1',
    ], { from: 'user' });
    assert.equal(process.exitCode, 1, 'a run that could not record its evidence exits non-zero');
  } finally {
    process.exitCode = before;
  }

  assert.ok(log.errors.some((line) => line.includes('[maf] evolve stopped:')),
    `the operator is told: ${log.errors.join(' | ')}`);

  const reports = await readdir(path.join(p.mafDir, 'evolve'));
  assert.equal(reports.length, 1, 'the partial report was written');
  const report = JSON.parse(
    await readFile(path.join(p.mafDir, 'evolve', reports[0]!), 'utf8'),
  ) as {
    stopReason: string;
    error?: string;
    finalHarness: { sha: string };
    rounds: Array<{
      outcome: string;
      evaluation?: {
        candidateSha: string;
        unrecorded?: boolean;
        candidateScores?: { harnessSha: string; solvedTaskIds: string[] };
      };
    }>;
  };

  assert.equal(report.stopReason, 'record-failed');
  assert.match(report.error ?? '', /could not record the golden result/);
  const round = report.rounds[0];
  assert.equal(round?.outcome, 'record-failed', 'the in-flight round is in the report');
  assert.equal(round?.evaluation?.unrecorded, true, 'its candidate result is marked unrecorded');
  assert.notEqual(round?.evaluation?.candidateSha, report.finalHarness.sha,
    'the candidate that could not be written is not the base');
  assert.equal(round?.evaluation?.candidateScores?.harnessSha, round?.evaluation?.candidateSha,
    'the score the recorder did not get is kept with the round, under the candidate sha');
});
