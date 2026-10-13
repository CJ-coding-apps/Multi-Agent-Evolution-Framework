import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import * as wiring from '../wiring.js';
import { registerGoldensCommand } from '../commands/goldens.js';
import { registerEvolveCommand } from '../commands/evolve.js';
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
