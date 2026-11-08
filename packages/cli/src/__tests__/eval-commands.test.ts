import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import type { AdapterInvokeOptions, AdapterInvokeResult, CliAdapter } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';
import * as wiring from '../wiring.js';
import * as AdapterRegistry from '../AdapterRegistry.js';
import { HarnessStore } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { registerGoldensCommand } from '../commands/goldens.js';
import { registerEvolveCommand } from '../commands/evolve.js';
import { registerHarnessCommand } from '../commands/harness.js';
import { messageOf } from './runFixture.js';

// ORACLE: verifier F3 and F11 — `goldens run` and `evolve` take `--allow-ungoverned` to the stack
// they dispatch through (on an adapter that cannot run the in-process loop, every writer task is
// refused without it, with no way to opt in); and on a fresh clone the two start from one harness,
// the committed default, where evolve used to mint legacy-default from roles.yaml and evolve a
// harness goldens never measured. Each command is stopped where it builds its stack, which is
// where both answers are visible; nothing is dispatched.

const REPO = path.resolve(__dirname, '../../../..');
const SEED = path.join(REPO, 'tests/goldens');
const STOP = 'stopped where the stack is built';

type StackConfig = Parameters<typeof wiring.buildRunStack>[0];

/** What a fresh clone has under .maf/: the committed roles, prompts, policy and default harness — no state. */
async function freshClone(): Promise<{ root: string; defaultSha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-eval-commands-'));
  const from = path.join(REPO, '.maf');
  const to = path.join(root, '.maf');
  await mkdir(path.join(to, 'harnesses'), { recursive: true });
  for (const entry of ['roles.yaml', 'policy.yaml', 'prompts']) await cp(path.join(from, entry), path.join(to, entry), { recursive: true });
  const name = (await readdir(path.join(from, 'harnesses'))).find((n) => /^default-[0-9a-f]{64}\.json$/.test(n));
  assert.ok(name, 'the repository commits a default harness');
  await cp(path.join(from, 'harnesses', name), path.join(to, 'harnesses', name));
  return { root, defaultSha: name.slice('default-'.length, -'.json'.length) };
}

/** Stops `buildRunStack` at its first line, keeping what it was asked for, and keeps what the commands log. */
function stopAtStack(t: TestContext): { stacks: StackConfig[]; logs: string[] } {
  const stacks: StackConfig[] = [];
  const logs: string[] = [];
  t.mock.method(wiring, 'buildRunStack', async (cfg: StackConfig) => {
    stacks.push(cfg);
    throw new Error(STOP);
  });
  t.mock.method(console, 'log', (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); });
  return { stacks, logs };
}

async function drive(register: (program: Command) => void, args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  register(program);
  let error: unknown;
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err: unknown) {
    error = err;
  }
  assert.equal(messageOf(error), STOP, `maf ${args.join(' ')} reached the stack`);
}

const goldens = (root: string, ...extra: string[]) => ['goldens', 'run', '--dir', root, '--corpus', SEED, '--adapter', 'scripted', ...extra];
const evolve = (root: string, ...extra: string[]) => ['evolve', '--dir', root, '--corpus', SEED, '--adapter', 'scripted', ...extra];

test('goldens run and evolve take --allow-ungoverned to the stack they dispatch through, and only when typed', async (t) => {
  const { root } = await freshClone();
  try {
    const { stacks } = stopAtStack(t);
    await drive(registerGoldensCommand, goldens(root, '--allow-ungoverned'));
    await drive(registerGoldensCommand, goldens(root));
    await drive(registerEvolveCommand, evolve(root, '--allow-ungoverned'));
    await drive(registerEvolveCommand, evolve(root));
    assert.deepEqual(stacks.map((s) => s.allowUngoverned === true), [true, false, true, false]);
    assert.ok(stacks.every((s) => s.headless === true), 'evaluations stay headless');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// M1(b): `maf evolve approve <sha>` is WP-3.7's command and does not exist yet. Typing it must be
// refused rather than read as `evolve` with surplus arguments and start a paid round.
test('maf evolve refuses a positional argument instead of starting a run (M1)', async (t) => {
  const resolved: string[] = [];
  t.mock.method(AdapterRegistry, 'resolveAdapter', async (name: string) => {
    resolved.push(name);
    throw new Error('adapter built');
  });
  const program = new Command();
  program.exitOverride();
  registerEvolveCommand(program);
  let error: unknown;
  try {
    await program.parseAsync(['evolve', 'approve', 'abc123'], { from: 'user' });
  } catch (err: unknown) {
    error = err;
  }
  assert.ok(error instanceof Error, 'the command refused the argument');
  assert.equal((error as { code?: string }).code, 'commander.excessArguments');
  assert.notEqual((error as { exitCode?: number }).exitCode, 0);
  assert.deepEqual(resolved, [], 'no adapter was built for a command that does not exist');
});

// ORACLE (WP-3.9 round 2, G4): `maf evolve` hands the evolver the registry's tool ids and the
// permission level of each. A manifest that adds a tool which is not in that registry is a
// malformed candidate — the invariant stage refuses it, naming the tools that do exist — and it is
// refused before the critic, the smoke test or a golden run. `gateWidening` alone would have
// called the unknown id `dangerous` and sent the operator an approval request for a tool that does
// not exist. The command is driven end to end; only the stack and the adapter stand in, so the
// registry, the loop and the gate under test are the real ones.
test('maf evolve refuses an unknown tool id at the invariant stage, naming the known tools', async (t) => {
  const UNKNOWN = 'nope.bogus';
  const MANIFEST = '```json\n' + JSON.stringify({
    edit: { kind: 'adjust_tool_allowlist', role: 'coder', add: [UNKNOWN], remove: [] },
    expectedImprovement: 'x', targetTasks: ['coder-sum'],
  }) + '\n```';

  const { root } = await freshClone();
  try {
    const calls: string[] = [];
    const adapter = {
      name: 'scripted',
      invoke: async (o: AdapterInvokeOptions): Promise<AdapterInvokeResult> => {
        calls.push(o.systemPrompt ?? '');
        return { success: true, output: MANIFEST, toolCallLog: [], exitCode: 0, duration: 0 };
      },
    } as unknown as CliAdapter;
    t.mock.method(AdapterRegistry, 'resolveAdapter', async () => adapter);
    t.mock.method(console, 'log', () => {});

    const graph = {
      run: async () => [], addNode: async () => 'id', addEdge: async () => 'e',
    } as unknown as MemoryGraph;
    // The golden runner is real; only the stack it dispatches through stands in. A candidate
    // refused at the invariant stage never reaches a smoke test, so the baseline is the only run
    // this test can cause — the assertion is on the refusal and on the absent critic call.
    t.mock.method(wiring, 'buildRunStack', async () => ({
      adapter, graph,
      securityPrompt: '',
      dispatchTask: async () => 'done',
      close: () => {},
    }) as unknown as wiring.RunStack);

    const program = new Command();
    program.exitOverride();
    registerEvolveCommand(program);
    await program.parseAsync(['evolve', '--dir', root, '--corpus', SEED, '--adapter', 'scripted', '--rounds', '1', '--patience', '1'], { from: 'user' });

    const reportDir = path.join(root, '.maf', 'evolve');
    const reports = (await readdir(reportDir)).filter((n) => n.endsWith('.json'));
    assert.equal(reports.length, 1, 'the command wrote one report');
    const report = JSON.parse(await readFile(path.join(reportDir, reports[0]!), 'utf8')) as {
      rounds: { outcome: string; note: string; gate?: { verdict: string; stage?: string } }[];
      ships: number;
      stopReason: string;
    };
    assert.equal(report.ships, 0);
    assert.equal(report.rounds[0]?.outcome, 'reject');
    assert.equal(report.rounds[0]?.gate?.stage, 'b-invariants');
    assert.match(report.rounds[0]?.note ?? '', /unknown tool "nope\.bogus"/);
    assert.match(report.rounds[0]?.note ?? '', /known tools: .*\bfs\.read\b/, 'the refusal names the registry it checked');
    assert.equal(calls.filter((s) => s.includes('critic')).length, 0, 'no critic call after the refusal');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ORACLE (WP-3.9 round 2, G9): the permission map is part of the gate's input, and nothing proved
// the map `maf evolve` builds reaches the loop — mapping every tool to `read` at the options
// construction survived the whole cli suite. The command runs end to end here (real registry, loop
// and gate), with a meta-model that widens the read-only `analyst` role with `fs.write`. The round
// can only come back `needs-approval` if the map says `fs.write` is a write: under an all-`read`
// map it is not a widening, and the manifest reaches the critic instead.
test('maf evolve gives the gate each tool\'s registry permission: fs.write widens analyst into an approval', async (t) => {
  const MANIFEST = '```json\n' + JSON.stringify({
    edit: { kind: 'adjust_tool_allowlist', role: 'analyst', add: ['fs.write'], remove: [] },
    expectedImprovement: 'x', targetTasks: ['coder-sum'],
  }) + '\n```';

  const { root } = await freshClone();
  try {
    const calls: string[] = [];
    const adapter = {
      name: 'scripted',
      invoke: async (o: AdapterInvokeOptions): Promise<AdapterInvokeResult> => {
        calls.push(o.systemPrompt ?? '');
        return { success: true, output: MANIFEST, toolCallLog: [], exitCode: 0, duration: 0 };
      },
    } as unknown as CliAdapter;
    t.mock.method(AdapterRegistry, 'resolveAdapter', async () => adapter);
    t.mock.method(console, 'log', () => {});

    const graph = {
      run: async () => [], addNode: async () => 'id', addEdge: async () => 'e',
    } as unknown as MemoryGraph;
    t.mock.method(wiring, 'buildRunStack', async () => ({
      adapter, graph,
      securityPrompt: '',
      dispatchTask: async () => 'done',
      close: () => {},
    }) as unknown as wiring.RunStack);

    const program = new Command();
    program.exitOverride();
    registerEvolveCommand(program);
    await program.parseAsync(['evolve', '--dir', root, '--corpus', SEED, '--adapter', 'scripted', '--rounds', '1', '--patience', '1'], { from: 'user' });

    const reportDir = path.join(root, '.maf', 'evolve');
    const reports = (await readdir(reportDir)).filter((n) => n.endsWith('.json'));
    assert.equal(reports.length, 1, 'the command wrote one report');
    const report = JSON.parse(await readFile(path.join(reportDir, reports[0]!), 'utf8')) as {
      rounds: {
        outcome: string; note: string;
        manifest?: { edit: { role: string; add: string[] } };
        gate?: { verdict: string; reason: string };
      }[];
      ships: number;
    };
    assert.equal(report.ships, 0);
    assert.equal(report.rounds[0]?.outcome, 'needs-approval',
      'the widening reached the gate as one: the map said fs.write is not a read');
    assert.equal(report.rounds[0]?.manifest?.edit.role, 'analyst');
    assert.deepEqual(report.rounds[0]?.manifest?.edit.add, ['fs.write']);
    assert.match(report.rounds[0]?.note ?? '', /b4-write-tool-widening/);
    assert.match(report.rounds[0]?.gate?.reason ?? '', /"fs\.write"/, 'the refusal names the tool it would have granted');
    assert.equal(calls.filter((s) => s.includes('critic')).length, 0, 'refused before any further model call');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('on a fresh clone, evolve starts from the harness goldens evaluates: the committed default', async (t) => {
  const { root, defaultSha } = await freshClone();
  try {
    const { stacks, logs } = stopAtStack(t);
    await drive(registerGoldensCommand, goldens(root));
    await drive(registerEvolveCommand, evolve(root));
    assert.deepEqual(stacks.map((s) => s.harnessSha), [defaultSha, defaultSha], 'one harness, not two');
    assert.ok(logs.some((l) => l.includes(`| harness: default (${defaultSha.slice(0, 8)})`)), logs.join('\n'));
    assert.ok(logs.some((l) => l.includes(`| base: default (${defaultSha.slice(0, 8)})`)), logs.join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ORACLE (WP-3.9 round 6, P1 — Reviewer A's probe): saving an evaluated sensitive candidate and
// applying it are two acts, and no test proved either through the real `evolve.ts` wiring. Three
// planted bugs left the whole suite green: `storeCandidate` also set CURRENT (M1b), stored nothing
// (M1c), and the stored candidate also went through `onShip` (M1e) — which, in the real wiring,
// ships a sensitive edit with no human. This drives the real command, loop, gate and store; only
// the adapter and the stack stand in.
test('real evolve.ts: a flag-on sensitive candidate is stored, not current, and set-current applies it (P1)', async (t) => {
  const MANIFEST = '```json\n' + JSON.stringify({
    edit: { kind: 'edit_role_prompt', role: 'security', newPrompt: 'be thorough when auditing', rationale: 'r' },
    expectedImprovement: 'x', targetTasks: ['security-eval-endpoint'],
  }) + '\n```';

  const { root } = await freshClone();
  try {
    const calls = { planner: 0, critic: 0, judge: 0 };
    const adapter = {
      name: 'scripted',
      invoke: async (o: AdapterInvokeOptions): Promise<AdapterInvokeResult> => {
        const prompt = o.prompt ?? '';
        const systemPrompt = o.systemPrompt ?? '';
        let output: string;
        if (prompt.includes('THOROUGH-ANSWER')) { calls.judge++; output = '{"passed":true,"rationale":"ok"}'; }
        else if (prompt.includes('NAIVE-ANSWER')) { calls.judge++; output = '{"passed":false,"rationale":"no"}'; }
        else if (systemPrompt.includes('critic')) { calls.critic++; output = '```json\n{"verdict":"ship","notes":"ok"}\n```'; }
        else { calls.planner++; output = calls.planner === 1 ? MANIFEST : '```json\n{"no_op":true}\n```'; }
        return { success: true, output, toolCallLog: [], exitCode: 0, duration: 0 };
      },
    } as unknown as CliAdapter;
    t.mock.method(AdapterRegistry, 'resolveAdapter', async () => adapter);

    const logs: string[] = [];
    t.mock.method(console, 'log', (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); });

    const graph = { run: async () => [], addNode: async () => 'id', addEdge: async () => 'e' } as unknown as MemoryGraph;
    t.mock.method(wiring, 'buildRunStack', async () => ({
      adapter, graph,
      securityPrompt: '',
      dispatchTask: async (harness: HarnessConfig) =>
        (harness.roleSet.roles.find((r) => r.role === 'security')?.systemPrompt ?? '').includes('thorough')
          ? 'THOROUGH-ANSWER' : 'NAIVE-ANSWER',
      close: async () => {},
    }) as unknown as wiring.RunStack);

    const store = new HarnessStore(path.join(root, '.maf'));
    const before = (await store.current())?.sha;

    const program = new Command();
    program.exitOverride();
    registerEvolveCommand(program);
    await program.parseAsync(evolve(root, '--rounds', '1', '--patience', '1', '--approve-sensitive'), { from: 'user' });

    const reportDir = path.join(root, '.maf', 'evolve');
    const reports = await readdir(reportDir);
    const report = JSON.parse(await readFile(path.join(reportDir, reports[0]!), 'utf8')) as {
      rounds: { outcome: string; evaluation?: { candidateSha: string } }[];
      ships: number;
    };
    const round = report.rounds[0]!;
    assert.equal(round.outcome, 'needs-approval');
    assert.equal(report.ships, 0);
    assert.ok(calls.critic >= 1, 'evaluated: the critic ran');

    const sha = round.evaluation!.candidateSha;
    assert.ok(await store.tryLoad(sha), 'candidate is in the harness store');
    assert.equal((await store.current())?.sha, before, 'CURRENT did not move');
    assert.notEqual((await store.current())?.sha, sha);
    assert.ok(logs.some((l) => l.includes('[maf] STORED') && l.includes(`maf harness set-current ${sha}`)),
      'STORED line names set-current');
    assert.ok(!logs.some((l) => l.includes('[maf] SHIP')), 'no SHIP line');

    const harnessProgram = new Command();
    harnessProgram.exitOverride();
    registerHarnessCommand(harnessProgram);
    await harnessProgram.parseAsync(['harness', 'set-current', sha, '--dir', root], { from: 'user' });
    assert.equal((await store.current())?.sha, sha, 'set-current applied it');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
