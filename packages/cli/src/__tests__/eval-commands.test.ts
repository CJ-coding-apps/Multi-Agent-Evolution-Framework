import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { estimateTokens } from '@maf/types';
import type { AdapterInvokeOptions, AdapterInvokeResult, CliAdapter } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';
import { RoleRegistry, harnessRoleSetFromRegistry } from '@maf/roles';
import { createDefaultRegistry } from '@maf/tools';
import * as wiring from '../wiring.js';
import * as AdapterRegistry from '../AdapterRegistry.js';
import { HarnessStore } from '@maf/harness-config';
import type { HarnessConfig, HarnessRoleSet } from '@maf/harness-config';
import { registerGoldensCommand, resolveGoldensHarness } from '../commands/goldens.js';
import { registerEvolveCommand } from '../commands/evolve.js';
import { readApprovalRecords, writeApprovalRecord } from '../approval.js';
import { registerHarnessCommand } from '../commands/harness.js';
import { messageOf } from './runFixture.js';

// ORACLE: verifier F3 and F11 — `goldens run` and `evolve` take `--allow-ungoverned` to the stack
// they dispatch through (on an adapter that cannot run the in-process loop, every writer task is
// refused without it, with no way to opt in); and on a fresh clone the two start from one harness.
// Round 2's F11 made that harness the committed default; LOW-R2-2 (round 3) supersedes it: with
// nothing pinned they dispatch the roles file, exactly as a plain run does, so an edit to
// `.maf/roles.yaml` is not silently ignored by the two evaluation commands. Each command is stopped
// where it builds its stack, which is where both answers are visible; nothing is dispatched.

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

// M1 (§7): a sensitive candidate is stored, not made current, and `maf evolve approve <id>` ships
// it. Approve is a real subcommand — a positional to plain `evolve` is still refused (M1b) so a
// typo cannot buy a round — and approving spends nothing: no adapter is built and no run starts.
// An intact stored candidate becomes CURRENT through the same write `maf harness set-current` makes;
// an unknown name is refused and moves nothing; R2-M1: only a stored needs-approval candidate is
// applied, an id two sessions claim is refused, and a candidate whose base has moved is refused.
test('maf evolve approve applies only a stored needs-approval candidate (R2-M1)', async (t) => {
  const resolved: string[] = [];
  t.mock.method(AdapterRegistry, 'resolveAdapter', async (name: string) => {
    resolved.push(name);
    throw new Error('adapter built');
  });
  const logs: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, 'log', (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); });
  t.mock.method(console, 'error', (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); });
  const root = await mkdtemp(path.join(tmpdir(), 'maf-evolve-approve-'));
  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    // A positional on the parent is still an excess argument (M1b), never a run.
    const parent = new Command().exitOverride();
    registerEvolveCommand(parent);
    let excess: unknown;
    try {
      await parent.parseAsync(['evolve', 'abc123'], { from: 'user' });
    } catch (err: unknown) {
      excess = err;
    }
    assert.equal((excess as { code?: string } | undefined)?.code, 'commander.excessArguments');

    const store = new HarnessStore(path.join(root, '.maf'));
    const roles = (prompt: string): HarnessRoleSet => ({
      version: 1, defaultRole: 'coder', roles: [{ role: 'coder', systemPrompt: prompt, allowedTools: ['fs.read'] }],
    });
    // CURRENT: the base two sessions both evolved from.
    const base = store.mint(roles('base'), 'legacy-default');
    await store.save(base);
    await store.setCurrent(base.sha);
    assert.equal((await store.current())?.sha, base.sha);

    const approve = async (ref: string): Promise<void> => {
      process.exitCode = 0;
      const program = new Command().exitOverride();
      registerEvolveCommand(program);
      await program.parseAsync(['evolve', 'approve', ref, '-d', root], { from: 'user' });
    };

    // Saved but never held for approval: `maf harness set-current` is the way to apply it.
    const plain = store.mint(roles('plain edit'), 'legacy-default-e1');
    await store.save(plain);
    await approve(plain.id);
    assert.equal(process.exitCode, 2, 'a harness that was not held for approval is refused');
    assert.ok(errors.some((l) => l.includes('was not held for approval')), errors.join('\n'));
    assert.equal((await store.current())?.sha, base.sha, 'a refused approval moves nothing');

    // Two sessions, same id, different candidates.
    const one = store.mint(roles('session one edit'), 'legacy-default-e1');
    const two = store.mint(roles('session two edit'), 'legacy-default-e1');
    await store.save(one);
    await store.save(two);
    await writeApprovalRecord(store.dir, { id: one.id, sha: one.sha, baseSha: base.sha, session: 'run-1' });
    await writeApprovalRecord(store.dir, { id: two.id, sha: two.sha, baseSha: base.sha, session: 'run-2' });
    await approve(one.id);
    assert.equal(process.exitCode, 2, 'an id two sessions claim is refused');
    assert.ok(errors.some((l) => l.includes('ambiguous') && l.includes('run-1/legacy-default-e1') && l.includes('run-2/legacy-default-e1')), errors.join('\n'));
    assert.equal((await store.current())?.sha, base.sha);

    // A qualified name resolves it; the approval is exactly a set-current of that sha.
    await approve(`run-2/${two.id}`);
    assert.equal((await store.current())?.sha, two.sha, 'CURRENT names the approved candidate');
    assert.ok(logs.some((l) => l.includes(`[maf] APPROVED ${two.id}`)), logs.join('\n'));

    // CURRENT has moved since that candidate was measured: applying it would ship an improvement
    // measured against another harness.
    await approve(`run-1/${one.id}`);
    assert.equal(process.exitCode, 2, 'a candidate whose base has moved is refused');
    assert.ok(
      errors.some((l) => l.includes(`measured against base ${base.sha.slice(0, 8)}`) && l.includes(`CURRENT is ${two.id}`)),
      errors.join('\n'),
    );
    assert.equal((await store.current())?.sha, two.sha, 'a refused approval moves nothing');

    // An unknown name, and an unknown sha, are refusals too.
    await approve('no-such-candidate');
    assert.equal(process.exitCode, 2);
    assert.ok(errors.some((l) => l.includes('no stored needs-approval candidate no-such-candidate')), errors.join('\n'));
    await approve('f'.repeat(64));
    assert.equal(process.exitCode, 2);
    assert.ok(errors.some((l) => l.includes(`no harness ${'f'.repeat(64)} is stored`)), errors.join('\n'));

    assert.deepEqual(resolved, [], 'approving builds no adapter and starts no run');
  } finally {
    process.exitCode = saved;
    await rm(root, { recursive: true, force: true });
  }
});

test('maf evolve refuses --held-out-repeats below three before anything is spent (R2-H3)', async (t) => {
  const { root } = await freshClone();
  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    const { stacks } = stopAtStack(t);
    const errors: string[] = [];
    t.mock.method(console, 'error', (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); });
    const program = new Command().exitOverride();
    registerEvolveCommand(program);
    await program.parseAsync(evolve(root, '--held-out-repeats', '2'), { from: 'user' });
    assert.equal(process.exitCode, 2, 'a count that cannot measure noise is refused, non-zero');
    assert.ok(
      errors.some((l) => l.includes('--held-out-repeats must be an integer of at least 3')),
      errors.join('\n'),
    );
    assert.deepEqual(stacks, [], 'no stack, no round, no money');
  } finally {
    process.exitCode = saved;
    await rm(root, { recursive: true, force: true });
  }
});

test('maf evolve refuses a held-out gate resting on fewer than minHeldOut deterministic tasks (R2-M2)', async (t) => {
  const { root } = await freshClone();
  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    // A split whose held-out side is one task: a gate that cannot tell an improvement from a coin
    // toss. The floor is declared in the file, so this is a visible edit a reviewer can see.
    const corpus = path.join(root, 'corpus');
    await cp(SEED, corpus, { recursive: true });
    const corpusJson = JSON.parse(await readFile(path.join(corpus, 'corpus.json'), 'utf8')) as { id: string }[];
    await writeFile(path.join(corpus, 'splits.json'), JSON.stringify({
      version: 1, minHeldOut: 5,
      train: corpusJson.map((t) => t.id).filter((id) => id !== 'coder-fib'),
      heldOut: ['coder-fib'],
    }), 'utf8');

    const { stacks } = stopAtStack(t);
    const errors: string[] = [];
    t.mock.method(console, 'error', (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); });
    const program = new Command().exitOverride();
    registerEvolveCommand(program);
    await program.parseAsync(['evolve', '--dir', root, '--corpus', corpus, '--adapter', 'scripted'], { from: 'user' });
    assert.equal(process.exitCode, 2, 'an unmeasurable yardstick is refused, non-zero');
    assert.ok(
      errors.some((l) => l.includes('1 deterministically scored task') && l.includes('minHeldOut is 5')),
      errors.join('\n'),
    );
    assert.deepEqual(stacks, [], 'no stack, no round, no money');
  } finally {
    process.exitCode = saved;
    await rm(root, { recursive: true, force: true });
  }
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

// ORACLE (WP-3.7 §7): the loop's tier rule is only as good as the map `maf evolve` hands it, and
// nothing proved that wiring — deleting the two options at the call site left the whole suite
// green. The adapter here has no `sendTurn`, so every role runs on the cli tier, where the
// in-process loop's `maxToolIterations` is never read; the edit can only be refused there. The
// command runs end to end (real registry, loop and gate), so the refusal is the product's.
test('maf evolve refuses a budget edit that cannot reach its role\'s tier (§7)', async (t) => {
  const MANIFEST = '```json\n' + JSON.stringify({
    edit: { kind: 'tune_role_budgets', role: 'coder', maxToolIterations: 3 },
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
      rounds: { outcome: string; note: string; gate?: { verdict: string; stage?: string; reason: string } }[];
      ships: number;
    };
    assert.equal(report.ships, 0);
    assert.equal(report.rounds[0]?.outcome, 'reject');
    assert.equal(report.rounds[0]?.gate?.stage, 'b-proposal-relevance',
      'refused at proposal, before the critic, the smoke test or a golden run');
    assert.match(report.rounds[0]?.gate?.reason ?? '', /runs on the cli tier under adapter "scripted"/);
    assert.equal(calls.filter((s) => s.includes('critic')).length, 0, 'no critic call after the refusal');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('on a fresh clone, goldens and evolve dispatch the roles file, as a plain run does (LOW-R2-2)', async (t) => {
  const { root } = await freshClone();
  try {
    const mafDir = path.join(root, '.maf');
    const store = new HarnessStore(mafDir);
    // What a plain run mints from the file as it is now — the same harness, not a snapshot of it.
    const expected = store.mint(await harnessRoleSetFromRegistry(
      await RoleRegistry.fromYamlOrDefault(path.join(mafDir, 'roles.yaml'), mafDir, createDefaultRegistry()),
    ), 'legacy-default');
    const { stacks, logs } = stopAtStack(t);
    await drive(registerGoldensCommand, goldens(root));
    await drive(registerEvolveCommand, evolve(root));
    assert.deepEqual(stacks.map((s) => s.harnessSha), [expected.sha, expected.sha], 'one harness, not two');
    assert.ok(logs.some((l) => l.includes(`| harness: legacy-default (${expected.sha.slice(0, 8)})`)), logs.join('\n'));
    assert.ok(logs.some((l) => l.includes(`| base: legacy-default (${expected.sha.slice(0, 8)})`)), logs.join('\n'));
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
    // LOW-R2-2: with no CURRENT, evolve's base is the roles file, and resolving it adopts that base
    // as CURRENT — what a plain run does. Read "before" after that write, so `CURRENT did not move`
    // below is about the candidate the human has not approved, not about the base being adopted.
    const { harness: base } = await resolveGoldensHarness(path.join(root, '.maf'));
    const before = (await store.current())?.sha;
    assert.equal(before, base.sha, 'resolving the base adopted it');

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
    // R2-M1: the line names the approval path that now exists — the qualified id — beside the
    // raw set-current escape, which never was the approval rule.
    const records = await readApprovalRecords(store.dir);
    assert.equal(records.length, 1, 'storing wrote one approval record');
    assert.equal(records[0]!.sha, sha);
    assert.equal(records[0]!.baseSha, before, 'the record remembers the base it was measured against');
    assert.ok(logs.some((l) => l.includes('[maf] STORED') && l.includes(`maf evolve approve ${records[0]!.session}/${records[0]!.id}`)),
      'STORED line names the qualified approval');
    assert.ok(logs.some((l) => l.includes(`maf harness set-current ${sha}`)), 'STORED line still names set-current');
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

// Q1 (round 7, Reviewer A's probe m1g): the base moves only on a ship. Round 1 here stores a
// sensitive edit as needs-approval; round 2 ships an ordinary coder edit. The P1 test runs one
// round, so a loop that adopted the stored candidate as the next base (`base = finalCandidate`
// after storing) left the whole suite green — and in the real wiring that round-2 SHIP saves the
// harness and makes it CURRENT, carrying the unread security prompt with no human involved.
// `--rounds 2` drives that path through `evolve.ts`, the loop, the gate, the golden runner and
// the store; only the adapter and the stack stand in.
test('real evolve.ts: an unapproved sensitive candidate never becomes a later round\'s base (Q1)', async (t) => {
  const SENSITIVE = '```json\n' + JSON.stringify({
    edit: { kind: 'edit_role_prompt', role: 'security', newPrompt: 'be thorough when auditing', rationale: 'r' },
    expectedImprovement: 'x', targetTasks: ['security-eval-endpoint'],
  }) + '\n```';
  const CODER = '```json\n' + JSON.stringify({
    edit: { kind: 'edit_role_prompt', role: 'coder', newPrompt: 'be thorough and systematic', rationale: 'r' },
    expectedImprovement: 'x', targetTasks: ['coder-sum'],
  }) + '\n```';

  const { root, defaultSha } = await freshClone();
  try {
    const calls = { planner: 0, critic: 0, judge: 0, audit: 0 };
    const adapter = {
      name: 'scripted',
      invoke: async (o: AdapterInvokeOptions): Promise<AdapterInvokeResult> => {
        const prompt = o.prompt ?? '';
        const systemPrompt = o.systemPrompt ?? '';
        let output: string;
        // The diff the coder edit produces is scored by the security gate, which is another call
        // on this adapter; it must not consume a planner slot.
        if (prompt.includes('Audit this diff')) { calls.audit++; output = '{"findings":[],"summary":"clean"}'; }
        else if (prompt.includes('THOROUGH-ANSWER')) { calls.judge++; output = '{"passed":true,"rationale":"ok"}'; }
        else if (prompt.includes('NAIVE-ANSWER')) { calls.judge++; output = '{"passed":false,"rationale":"no"}'; }
        else if (systemPrompt.includes('critic')) { calls.critic++; output = '```json\n{"verdict":"ship","notes":"ok"}\n```'; }
        else {
          calls.planner++;
          output = calls.planner === 1 ? SENSITIVE : calls.planner === 2 ? CODER : '```json\n{"no_op":true}\n```';
        }
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
      dispatchTask: async (harness: HarnessConfig, role: string, prompt: string, workDir: string) => {
        const rolePrompt = harness.roleSet.roles.find((r) => r.role === role)?.systemPrompt ?? '';
        if (role === 'security' || role === 'reviewer')
          return rolePrompt.includes('thorough') ? 'THOROUGH-ANSWER' : 'NAIVE-ANSWER';
        // The coder edit's improvement is grounded in a test-script task, so it can ship; write the
        // one fixture fix the corpus checks.
        if (rolePrompt.includes('thorough') && prompt.includes('Fix sum.js')) {
          await writeFile(path.join(workDir, 'sum.js'),
            'function sum(a,b){ return a + b; }\nmodule.exports = { sum };\n');
          return 'fixed sum.js';
        }
        return 'no change';
      },
      close: async () => {},
    }) as unknown as wiring.RunStack);

    const store = new HarnessStore(path.join(root, '.maf'));
    // LOW-R2-2 (round 3): with no CURRENT, evolve starts from the roles file — not the committed
    // default round 2's F11 made it. An edit to `.maf/roles.yaml` is what a fresh clone evolves.
    const { harness: base } = await resolveGoldensHarness(path.join(root, '.maf'));
    const fromFile = store.mint(await harnessRoleSetFromRegistry(
      await RoleRegistry.fromYamlOrDefault(
        path.join(root, '.maf', 'roles.yaml'), path.join(root, '.maf'), createDefaultRegistry()),
    ), 'legacy-default');
    assert.equal(base.sha, fromFile.sha, 'the base is the roles file, as a plain run dispatches it');
    assert.notEqual(base.sha, defaultSha, 'and not the committed default, which `--harness default` names');

    const program = new Command();
    program.exitOverride();
    registerEvolveCommand(program);
    await program.parseAsync(evolve(root, '--rounds', '2', '--patience', '2', '--approve-sensitive'), { from: 'user' });

    const reportDir = path.join(root, '.maf', 'evolve');
    const reports = await readdir(reportDir);
    const report = JSON.parse(await readFile(path.join(reportDir, reports[0]!), 'utf8')) as {
      rounds: { outcome: string; evaluation?: { candidateSha: string } }[];
      ships: number;
    };
    assert.deepEqual(report.rounds.map((r) => r.outcome), ['needs-approval', 'ship']);
    assert.equal(report.ships, 1, 'round 2 shipped the ordinary edit');

    const storedSha = report.rounds[0]!.evaluation!.candidateSha;
    const current = await store.current();
    assert.ok(current, 'round 2 made a harness current');
    assert.notEqual(current.sha, storedSha, 'the unread sensitive candidate did not become current');

    const promptOf = (h: HarnessConfig, role: string) =>
      h.roleSet.roles.find((r) => r.role === role)?.systemPrompt;
    assert.equal(promptOf(current, 'security'), promptOf(base, 'security'),
      'the shipped harness did not carry the unread security prompt');
    // §7 bounds the id: each minted candidate is `<root>-e<n>`, so it stays rooted at the base
    // whatever round it came from (the old `${base.id}-r${round}` grew a segment per round).
    assert.match(current.id, /^legacy-default-e\d+$/, 'the shipped id is rooted at the pre-round-1 base');
    assert.ok(promptOf(current, 'coder')?.includes('thorough'), 'the ship is the coder edit');
    assert.ok(await store.tryLoad(storedSha), 'the sensitive candidate is still there for a human');
    assert.equal(logs.filter((l) => l.includes('[maf] SHIP')).length, 1, 'exactly one ship');
    assert.equal(logs.filter((l) => l.includes('[maf] STORED')).length, 1, 'exactly one store');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-H4: the budget used to charge one estimate per golden task, so every tool-loop turn, every
// planner and critic call, the judge, the security gate and every injected context went uncounted —
// the audit measured an undercount of about 60×. The metering adapter wraps the run's adapter, and
// the report carries the count.
test('real evolve.ts (R2-H4): every model call is counted, estimated from the bytes sent', async (t) => {
  const MANIFEST = '```json\n' + JSON.stringify({
    edit: { kind: 'edit_role_prompt', role: 'coder', newPrompt: 'be thorough and systematic', rationale: 'r' },
    expectedImprovement: 'x', targetTasks: ['coder-sum'],
  }) + '\n```';

  const { root } = await freshClone();
  try {
    const exchanges: { sent: string; received: string }[] = [];
    const adapter = {
      name: 'scripted',
      capabilities: () => ({
        supportsStreaming: false, supportsToolCalling: false, supportsWorktrees: false,
        inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
      }),
      isAvailable: async () => true,
      stream: async function* () { /* unused */ },
      invoke: async (o: AdapterInvokeOptions): Promise<AdapterInvokeResult> => {
        const systemPrompt = o.systemPrompt ?? '';
        let output: string;
        if (systemPrompt.includes('MAF harness evolution planner')) {
          output = exchanges.filter((e) => e.sent.includes('planner')).length === 0
            ? MANIFEST : '```json\n{"no_op":true}\n```';
        } else if (systemPrompt.includes('critic')) {
          output = '```json\n{"verdict":"ship","notes":"ok"}\n```';
        } else if (systemPrompt.includes('security')) {
          output = '```json\n{"findings":[],"summary":"none","passed":true}\n```';
        } else {
          output = `answer for: ${o.prompt.slice(0, 40)}`;
        }
        exchanges.push({ sent: `${systemPrompt}\n${o.prompt}`, received: output });
        return { success: true, output, toolCallLog: [], exitCode: 0, duration: 0 };
      },
    } as unknown as CliAdapter;
    t.mock.method(AdapterRegistry, 'resolveAdapter', async () => adapter);

    // Every role dispatch is one opaque model call through whatever adapter the stack was built
    // with — which is the metered wrapper, so the turn is counted exactly as a real one would be.
    t.mock.method(wiring, 'buildRunStack', async (cfg: StackConfig) => ({
      adapter: cfg.adapter,
      graph: { run: async () => [], addNode: async () => 'id', addEdge: async () => 'e' } as unknown as MemoryGraph,
      securityPrompt: 'security',
      dispatchTask: async (
        _h: HarnessConfig, _role: string, prompt: string, _workDir: string, _timeoutMs: number,
      ) => (await cfg.adapter.invoke({
        prompt, systemPrompt: 'role prompt', workingDir: root, timeoutMs: 1_000,
      })).output,
      close: async () => {},
    }) as unknown as wiring.RunStack);

    t.mock.method(console, 'log', () => {});
    const program = new Command();
    program.exitOverride();
    registerEvolveCommand(program);
    await program.parseAsync(evolve(root, '--rounds', '1', '--patience', '1'), { from: 'user' });

    const reportDir = path.join(root, '.maf', 'evolve');
    const [file] = await readdir(reportDir);
    const report = JSON.parse(await readFile(path.join(reportDir, file!), 'utf8')) as {
      usage?: { calls: number; tokens: number; reportedTokens: number; estimatedTokens: number; statement: string };
      budget?: { tokens: number };
    };
    const usage = report.usage;
    assert.ok(usage, 'the report carries the usage figures');
    assert.ok(exchanges.length > 4, 'planner, critic, security and role calls all happened');
    assert.equal(usage!.calls, exchanges.length, 'every model call is counted, not one per task');

    // What the bytes say, computed independently from what each call sent and received.
    const bytesBased = exchanges.reduce((n, e) => n + estimateTokens(e.sent) + estimateTokens(e.received), 0);
    assert.ok(
      Math.abs(usage!.tokens - bytesBased) / bytesBased < 0.1,
      `counted ${usage!.tokens} tokens against ${bytesBased} bytes-based (${exchanges.length} calls)`,
    );
    assert.equal(usage!.reportedTokens, 0, 'the fake adapter reports nothing, so nothing is claimed as reported');
    assert.equal(report.budget?.tokens, usage!.tokens, 'the budget is fed from the meter, not from a second count');
    assert.equal(usage!.estimatedTokens, usage!.tokens);
    assert.match(usage!.statement, /estimated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-H2, second path: held-out scoring runs through the dispatcher, and the dispatcher's policy
// engine and security hooks write `PolicyEvent` and `Failure` nodes into whatever graph they were
// given. On the project graph those rows are the next session's evidence — the exact leak that lets
// a planner aim at the yardstick. So the held-out measurement must be dispatched through a SECOND
// stack whose graph is not the project's.
test('real evolve.ts (R2-H2): held-out scoring is dispatched through an isolated graph', async (t) => {
  const { root } = await freshClone();
  try {
    // The committed split, not a copy of it: the corpus grows, the rule does not (R2-M2).
    const HE = new Set<string>(
      (JSON.parse(await readFile(path.join(REPO, 'tests/goldens/splits.json'), 'utf8')) as { heldOut: string[] }).heldOut,
    );
    const calls: StackConfig[] = [];
    const dispatched: { stack: number; task?: string }[] = [];
    let built = 0;
    let plannerCalls = 0;
    t.mock.method(wiring, 'buildRunStack', async (cfg: StackConfig) => {
      calls.push(cfg);
      const index = ++built;
      return {
        adapter: {} as CliAdapter,
        graph: { run: async () => [], addNode: async () => 'id', addEdge: async () => 'e' } as unknown as MemoryGraph,
        securityPrompt: '',
        dispatchTask: async (
          harness: HarnessConfig, role: string, prompt: string, workDir: string,
          _timeoutMs: number, _temperature?: number, goldenTaskId?: string,
        ) => {
          dispatched.push({ stack: index, ...(goldenTaskId !== undefined ? { task: goldenTaskId } : {}) });
          // The coder edit's improvement is grounded in a test-script task: one candidate must ship
          // for a survivor to exist and the held-out split to be scored at all.
          const rolePrompt = harness.roleSet.roles.find((r) => r.role === role)?.systemPrompt ?? '';
          if (rolePrompt.includes('thorough') && prompt.includes('Fix sum.js')) {
            await writeFile(path.join(workDir, 'sum.js'),
              'function sum(a,b){ return a + b; }\nmodule.exports = { sum };\n');
            return 'fixed sum.js';
          }
          return 'no change';
        },
        close: async () => {},
      } as unknown as wiring.RunStack;
    });
    const adapter = {
      name: 'scripted',
      invoke: async (o: AdapterInvokeOptions): Promise<AdapterInvokeResult> => {
        const systemPrompt = o.systemPrompt ?? '';
        let output: string;
        if (systemPrompt.includes('MAF harness evolution planner')) {
          plannerCalls++;
          output = plannerCalls === 1
            ? '```json\n' + JSON.stringify({
              edit: { kind: 'edit_role_prompt', role: 'coder', newPrompt: 'be thorough and systematic', rationale: 'r' },
              expectedImprovement: 'coder-sum', targetTasks: ['coder-sum'],
            }) + '\n```'
            : '```json\n{"no_op":true}\n```';
        } else if (systemPrompt.includes('critic')) {
          output = '```json\n{"verdict":"ship","notes":"ok"}\n```';
        } else {
          output = '```json\n{"passed":false,"rationale":"no"}\n```';
        }
        return { success: true, output, toolCallLog: [], exitCode: 0, duration: 0 };
      },
    } as unknown as CliAdapter;
    t.mock.method(AdapterRegistry, 'resolveAdapter', async () => adapter);
    t.mock.method(console, 'log', () => {});

    const program = new Command();
    program.exitOverride();
    registerEvolveCommand(program);
    await program.parseAsync(evolve(root, '--rounds', '2', '--patience', '1'), { from: 'user' });

    assert.equal(calls.length, 2, 'a second stack is built for the held-out split');
    const [project, heldOut] = calls;
    assert.equal(project?.graphDir, undefined, 'the project stack keeps .maf/memory.kuzu');
    assert.ok(heldOut?.graphDir !== undefined && heldOut.graphDir !== path.join(root, '.maf'),
      'the held-out stack writes its graph somewhere else');

    const projectTasks = dispatched.filter((d) => d.stack === 1).map((d) => d.task);
    assert.ok(projectTasks.every((id) => id === undefined || !HE.has(id)),
      'the project stack never dispatched a held-out task');
    const heldTasks = dispatched.filter((d) => d.stack === 2).map((d) => d.task);
    assert.ok(heldTasks.length > 0, 'the held-out split was actually scored');
    assert.ok(heldTasks.every((id) => id !== undefined && HE.has(id)),
      `every isolated dispatch is a held-out task: ${heldTasks.join(', ')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
