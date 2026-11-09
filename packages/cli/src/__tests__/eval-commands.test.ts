import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import type { AdapterInvokeOptions, AdapterInvokeResult, CliAdapter } from '@maf/types';
import type { MemoryGraph } from '@maf/memory-graph';
import { RoleRegistry, harnessRoleSetFromRegistry } from '@maf/roles';
import { createDefaultRegistry } from '@maf/tools';
import * as wiring from '../wiring.js';
import * as AdapterRegistry from '../AdapterRegistry.js';
import { HarnessStore } from '@maf/harness-config';
import type { HarnessConfig } from '@maf/harness-config';
import { registerGoldensCommand, resolveGoldensHarness } from '../commands/goldens.js';
import { registerEvolveCommand } from '../commands/evolve.js';
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
// an unknown name is refused and moves nothing.
test('maf evolve approve applies a stored candidate and refuses an unknown one without a run (M1)', async (t) => {
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

    // Minted and saved, but not current: exactly the state `maf evolve` leaves a needs-approval
    // candidate in.
    const store = new HarnessStore(path.join(root, '.maf'));
    const candidate = store.mint(
      { version: 1, defaultRole: 'coder', roles: [{ role: 'coder', systemPrompt: 'improved', allowedTools: ['fs.read'] }] },
      'legacy-default-e1',
    );
    await store.save(candidate);
    assert.equal(await store.current(), undefined, 'a stored candidate is not current');

    const program = new Command().exitOverride();
    registerEvolveCommand(program);
    await program.parseAsync(['evolve', 'approve', candidate.id, '-d', root], { from: 'user' });
    assert.equal((await store.current())?.sha, candidate.sha, 'CURRENT names the approved candidate');
    assert.ok(logs.some((l) => l.includes(`[maf] APPROVED ${candidate.id}`)), logs.join('\n'));

    const unknown = new Command().exitOverride();
    registerEvolveCommand(unknown);
    await unknown.parseAsync(['evolve', 'approve', 'no-such-candidate', '-d', root], { from: 'user' });
    assert.equal(process.exitCode, 2, 'an unknown candidate is refused, non-zero');
    assert.ok(errors.some((l) => l.includes('no stored harness named no-such-candidate')), errors.join('\n'));
    assert.equal((await store.current())?.sha, candidate.sha, 'a refused approval moves nothing');
    assert.deepEqual(resolved, [], 'approving builds no adapter and starts no run');
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
