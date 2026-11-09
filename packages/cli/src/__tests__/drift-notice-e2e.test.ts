import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { Command } from 'commander';
import { HarnessStore } from '@maf/harness-config';
import { RoleRegistry, harnessRoleSetFromRegistry } from '@maf/roles';
import { createDefaultRegistry } from '@maf/tools';
import * as wiring from '../wiring.js';
import { registerEvolveCommand } from '../commands/evolve.js';
import { registerGoldensCommand } from '../commands/goldens.js';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { runInit } from '../commands/init.js';
import { cliOnlyAdapter, collector, driveRun, needsLcm, registryOf } from './runFixture.js';

// ORACLE (S6 HIGH-1(d), MED-R2-1). The drift notice is the ruled replacement for round 1's silent
// ignore: once a harness is pinned, every command that dispatches it says — in one line — that the
// roles file it replaced has moved on. Round 2 tested `harnessDriftNotice()` directly, so deleting
// the print in `run.ts` or `goldens.ts`, or printing it twice, left every cli test green. These
// tests drive the three commands, and count the lines each one actually prints.
//
// LOW-R2-2 rides here too: with nothing pinned, `goldens` and `evolve` dispatch the roles file, as
// a plain run does — proved with a real scripted golden run whose result names the edited sha.
//
// LOW-R3-2: the CURRENT `goldens` records is the tracking pointer (`legacy-default`), never a
// pinned sha. The sequence below is the one that would expose it if that changed: `init`, a real
// `goldens run`, edit the tester, then a plain run — which must use the edit, with no notice.

const REPO = path.resolve(__dirname, '../../../..');
const MAIN = path.resolve(__dirname, '../main.js');
const SEED = path.join(REPO, 'tests/goldens');
const execFileAsync = promisify(execFile);
const NOTICE = /differs from CURRENT/;

interface Project {
  root: string;
  mafDir: string;
  rolesPath: string;
  /** The harness CURRENT is pinned to, when it is. */
  pinnedSha?: string;
}

/**
 * A demo repository that has run `maf init`, optionally with a harness pinned to the roles file as
 * it is now (`pinned`). Pinning that content makes "agrees" the unpinned-by-value case, so the only
 * way to a notice is an edit to the file.
 */
async function project(opts: { pin: boolean }): Promise<Project> {
  const container = await mkdtemp(path.join(tmpdir(), 'maf-drift-e2e-'));
  const root = await createDemoFixture(container);
  await runInit({ dir: root, out: collector() });
  const mafDir = path.join(root, '.maf');
  const rolesPath = path.join(mafDir, 'roles.yaml');
  if (!opts.pin) return { root, mafDir, rolesPath };
  const store = new HarnessStore(mafDir);
  const pinned = store.mint(await harnessRoleSetFromRegistry(
    await RoleRegistry.fromYamlOrDefault(rolesPath, mafDir, createDefaultRegistry()),
  ), 'pinned');
  await store.save(pinned);
  await store.setCurrent(pinned.sha);
  return { root, mafDir, rolesPath, pinnedSha: pinned.sha };
}

/** A user's edit the pinned harness does not hold: the tester loses `fs.write` (round 2's own case). */
async function editTester(p: Project): Promise<void> {
  const parsed = JSON.parse(await readFile(p.rolesPath, 'utf8')) as {
    roles: Array<{ role: string; allowedTools: string[] }>;
  };
  const tester = parsed.roles.find((r) => r.role === 'tester');
  assert.ok(tester, 'the shipped role set has a tester');
  tester.allowedTools = tester.allowedTools.filter((tool) => tool !== 'fs.write');
  await writeFile(p.rolesPath, JSON.stringify(parsed, null, 2), 'utf8');
}

const noticesIn = (lines: readonly string[]): string[] => lines.filter((line) => NOTICE.test(line));

function assertOneNotice(notices: readonly string[], p: Project): void {
  assert.equal(notices.length, 1, `exactly one notice, not ${notices.length}: ${notices.join(' | ')}`);
  const notice = notices[0] as string;
  assert.ok(notice.includes('"pinned"') && notice.includes((p.pinnedSha as string).slice(0, 8)),
    `names the harness that runs: ${notice}`);
  assert.ok(notice.includes('"legacy-default"'), `and the one the file would mint: ${notice}`);
  assert.ok(notice.includes('maf harness set-current legacy-default'), `and the way back: ${notice}`);
}

/** `maf run`, stopped by an adapter that cannot dispatch — after the harness line and the notice. */
async function runLines(p: Project, extra: readonly string[] = []): Promise<string[]> {
  const driven = await driveRun(['t', '--dir', p.root, '--adapter', 'cli-only', ...extra],
    { adapters: registryOf(cliOnlyAdapter('cli-only')) });
  return driven.out.split('\n');
}

/** Stops `buildRunStack` where it is built; the resolution and its print have already happened. */
function stopAtStack(t: TestContext): void {
  t.mock.method(wiring, 'buildRunStack', async () => { throw new Error('stopped where the stack is built'); });
}

/**
 * A commander-driven command's stderr, with the stack stopped. `lines` is cleared before each drive,
 * so a notice printed by an earlier case cannot be counted as this one's.
 */
function captureStderr(t: TestContext): { lines: string[]; drive(args: readonly string[], register: (program: Command) => void): Promise<void> } {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); });
  stopAtStack(t);
  return {
    lines,
    async drive(args, register) {
      lines.length = 0;
      const program = new Command().exitOverride();
      register(program);
      try {
        await program.parseAsync([...args], { from: 'user' });
      } catch {
        // Expected: the stack is the last thing the command reaches.
      }
    },
  };
}

test('maf run prints the drift notice once when a pinned harness differs, and never otherwise', async () => {
  const cases: Array<{ name: string; p: Project; extra: string[]; notice: boolean }> = [];
  try {
    const drifting = await project({ pin: true });
    await editTester(drifting);
    cases.push({ name: 'pinned and differing', p: drifting, extra: [], notice: true });
    cases.push({ name: 'pinned and differing, --harness', p: drifting, extra: ['--harness', 'pinned'], notice: false });
    cases.push({ name: 'pinned and differing, --roles', p: drifting, extra: ['--roles', '.maf/roles.yaml'], notice: false });

    const agreeing = await project({ pin: true });
    cases.push({ name: 'pinned and agreeing', p: agreeing, extra: [], notice: false });

    const unpinned = await project({ pin: false });
    await editTester(unpinned);
    cases.push({ name: 'nothing pinned', p: unpinned, extra: [], notice: false });

    for (const c of cases) {
      const notices = noticesIn(await runLines(c.p, c.extra));
      if (c.notice) assertOneNotice(notices, c.p);
      else assert.deepEqual(notices, [], `${c.name}: ${notices.join(' | ')}`);
    }
  } finally {
    for (const c of cases) await rm(path.dirname(c.p.root), { recursive: true, force: true });
  }
});

test('maf goldens run prints the drift notice once when a pinned harness differs, and never otherwise', async (t) => {
  const goldensArgs = (p: Project, extra: readonly string[] = []) =>
    ['goldens', 'run', '--dir', p.root, '--corpus', SEED, '--adapter', 'scripted', ...extra];
  const projects: Project[] = [];
  try {
    const drifting = await project({ pin: true });
    await editTester(drifting);
    projects.push(drifting);
    const agreeing = await project({ pin: true });
    projects.push(agreeing);
    const unpinned = await project({ pin: false });
    await editTester(unpinned);
    projects.push(unpinned);

    const cases: Array<{ name: string; p: Project; extra: string[]; notice: boolean }> = [
      { name: 'pinned and differing', p: drifting, extra: [], notice: true },
      { name: 'pinned and differing, --harness', p: drifting, extra: ['--harness', 'pinned'], notice: false },
      { name: 'pinned and agreeing', p: agreeing, extra: [], notice: false },
      { name: 'nothing pinned', p: unpinned, extra: [], notice: false },
    ];
    const stderr = captureStderr(t);
    for (const c of cases) {
      await stderr.drive(goldensArgs(c.p, c.extra), registerGoldensCommand);
      const notices = noticesIn(stderr.lines);
      if (c.notice) assertOneNotice(notices, c.p);
      else assert.deepEqual(notices, [], `${c.name}: ${notices.join(' | ')}`);
    }
  } finally {
    for (const p of projects) await rm(path.dirname(p.root), { recursive: true, force: true });
  }
});

test('maf evolve prints the drift notice once when a pinned harness differs, and never otherwise', async (t) => {
  const evolveArgs = (p: Project, extra: readonly string[] = []) =>
    ['evolve', '--dir', p.root, '--corpus', SEED, '--adapter', 'scripted', '--rounds', '1', '--patience', '1', ...extra];
  const projects: Project[] = [];
  try {
    const drifting = await project({ pin: true });
    await editTester(drifting);
    projects.push(drifting);
    const agreeing = await project({ pin: true });
    projects.push(agreeing);
    const unpinned = await project({ pin: false });
    await editTester(unpinned);
    projects.push(unpinned);

    const cases: Array<{ name: string; p: Project; extra: string[]; notice: boolean }> = [
      { name: 'pinned and differing', p: drifting, extra: [], notice: true },
      { name: 'pinned and differing, --harness', p: drifting, extra: ['--harness', 'pinned'], notice: false },
      { name: 'pinned and agreeing', p: agreeing, extra: [], notice: false },
      { name: 'nothing pinned', p: unpinned, extra: [], notice: false },
    ];
    const stderr = captureStderr(t);
    for (const c of cases) {
      await stderr.drive(evolveArgs(c.p, c.extra), registerEvolveCommand);
      const notices = noticesIn(stderr.lines);
      if (c.notice) assertOneNotice(notices, c.p);
      else assert.deepEqual(notices, [], `${c.name}: ${notices.join(' | ')}`);
    }
  } finally {
    for (const p of projects) await rm(path.dirname(p.root), { recursive: true, force: true });
  }
});

/** A one-task corpus and its script, so a real golden run is seconds rather than the full ten. */
async function miniCorpus(root: string): Promise<string> {
  const corpus = path.join(root, 'corpus');
  await mkdir(path.join(corpus, 'fixtures'), { recursive: true });
  await cp(path.join(SEED, 'fixtures', 'coder-sum'), path.join(corpus, 'fixtures', 'coder-sum'), { recursive: true });
  const tasks = JSON.parse(await readFile(path.join(SEED, 'corpus.json'), 'utf8')) as Array<{ id: string }>;
  const first = tasks[0];
  assert.ok(first, 'the seed corpus has a task');
  const scripts = JSON.parse(await readFile(path.join(SEED, 'scripted.json'), 'utf8')) as {
    version: number; tasks: Record<string, unknown>;
  };
  const script = scripts.tasks[first.id];
  assert.ok(script, `the seed script answers ${first.id}`);
  await writeFile(path.join(corpus, 'corpus.json'), JSON.stringify([first]), 'utf8');
  await writeFile(path.join(corpus, 'scripted.json'),
    JSON.stringify({ version: scripts.version, tasks: { [first.id]: script } }), 'utf8');
  return corpus;
}

test('LOW-R3-2: goldens records a CURRENT that tracks the roles file, so a later run uses the edit', needsLcm, async () => {
  const p = await project({ pin: false });
  try {
    const store = new HarnessStore(p.mafDir);
    const mintFromFile = async () => store.mint(await harnessRoleSetFromRegistry(
      await RoleRegistry.fromYamlOrDefault(p.rolesPath, p.mafDir, createDefaultRegistry()),
    ), 'legacy-default');
    const recorded = await mintFromFile();
    const corpus = await miniCorpus(p.root);

    // 1. A real `goldens run` on a project with nothing pinned. Resolution is what writes CURRENT.
    await execFileAsync(process.execPath,
      [MAIN, 'goldens', 'run', '--adapter', 'scripted', '--corpus', corpus, '--attempts', '1', '-d', p.root],
      { cwd: p.root });
    const current = await store.current();
    assert.ok(current, 'goldens recorded a CURRENT');
    assert.equal(current.id, 'legacy-default', 'the tracking pointer, not a pinned harness');
    assert.equal(current.sha, recorded.sha, 'and it names the roles file as it was then');

    // 2. The user edits the tester. 3. A plain run must dispatch the edit.
    await editTester(p);
    const edited = await mintFromFile();
    assert.notEqual(edited.sha, recorded.sha, 'the edit changed the role set');

    const lines = await runLines(p);
    assert.ok(
      lines.some((line) => line.includes(`harness: legacy-default (${edited.sha.slice(0, 8)}) [legacy]`)),
      `the plain run mints the edited file, not the recorded snapshot:\n${lines.join('\n')}`,
    );
    assert.deepEqual(noticesIn(lines), [],
      'and there is nothing to warn about: the CURRENT it recorded follows the file');
  } finally {
    await rm(path.dirname(p.root), { recursive: true, force: true });
  }
});

test('LOW-R2-2: with nothing pinned, goldens evaluates the edited roles file and its result names that sha', needsLcm, async () => {
  const p = await project({ pin: false });
  try {
    await editTester(p);
    const edited = new HarnessStore(p.mafDir).mint(await harnessRoleSetFromRegistry(
      await RoleRegistry.fromYamlOrDefault(p.rolesPath, p.mafDir, createDefaultRegistry()),
    ), 'legacy-default');
    const corpus = await miniCorpus(p.root);

    const { stdout, stderr } = await execFileAsync(process.execPath,
      [MAIN, 'goldens', 'run', '--adapter', 'scripted', '--corpus', corpus, '--attempts', '1', '-d', p.root],
      { cwd: p.root });
    assert.match(stdout, new RegExp(`\\| harness: legacy-default \\(${edited.sha.slice(0, 8)}\\) from `),
      `the run names the harness it evaluated:\n${stdout}`);

    const resultPath = path.join(p.mafDir, 'goldens', 'results', `${edited.sha}.scripted.json`);
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as { harnessSha: string; harnessId: string; solvedTaskIds: string[] };
    assert.equal(result.harnessSha, edited.sha, 'the result is named for — and records — the edited role set');
    assert.equal(result.harnessId, 'legacy-default');
    assert.deepEqual(result.solvedTaskIds, ['coder-sum'], 'and the run dispatched: the scripted fix passed');
    assert.equal(noticesIn(stderr.split('\n')).length, 0, 'nothing is pinned, so there is no disagreement to report');
  } finally {
    await rm(path.dirname(p.root), { recursive: true, force: true });
  }
});
