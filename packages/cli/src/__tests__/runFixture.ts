import { readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import type { AdapterInvokeOptions, AdapterName, CliAdapter, TurnAdapter } from '@maf/types';
import type { ScriptedAdapter, ScriptedTask } from '@maf/eval-harness';
import { LcmEngine } from '@maf/lcm';
import { runIsolatedGit } from '@maf/git-ops';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { registerRunCommand } from '../commands/run.js';
import type { RunDeps } from '../commands/run.js';

/** What a `maf run` printed, and what it threw (the CLI turns a throw into exit 1). */
export interface DrivenRun {
  out:    string;
  err:    string;
  error?: unknown;
}

/** A stream that keeps what is written to it, so a test reads what `run` printed. */
export function collector(): PassThrough & { text(): string } {
  let buf = '';
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => { buf += chunk.toString('utf8'); });
  return Object.assign(stream, { text: () => buf });
}

/**
 * `maf run <args>` through commander, as main.ts registers it, so flag sources are commander's
 * own; `deps` replaces the adapters and streams. Never exits the process.
 */
export async function driveRun(args: readonly string[], deps: RunDeps = {}): Promise<DrivenRun> {
  const stdout = collector();
  const stderr = collector();
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program, { ...deps, io: { stdout, stderr, ...deps.io } });
  let error: unknown;
  try {
    await program.parseAsync(['run', ...args], { from: 'user' });
  } catch (err: unknown) {
    error = err;
  }
  // Let the streams hand over what was written last.
  await new Promise((resolve) => setImmediate(resolve));
  return { out: stdout.text(), err: stderr.text(), ...(error !== undefined ? { error } : {}) };
}

/** An adapter that is never available: a run that picks it stops at adapter resolution, naming it. */
export function unavailableAdapter(name: AdapterName): CliAdapter {
  return {
    name,
    capabilities: () => ({
      supportsStreaming: false, supportsToolCalling: false, supportsWorktrees: false,
      inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
    }),
    isAvailable: async () => false,
    invoke: async () => { throw new Error(`${name} must never be invoked`); },
    stream: async function* () { throw new Error(`${name} must never be invoked`); },
  };
}

/**
 * An available adapter that cannot run the in-process loop — every writer lands on the cli tier
 * (D-01) — and that fails the test if anything asks it a thing.
 */
export function cliOnlyAdapter(name: AdapterName): CliAdapter {
  return { ...unavailableAdapter(name), isAvailable: async () => true };
}

/** One request an adapter was handed: where it was told to work, and for how long. */
export interface AdapterCall {
  via:        'invoke' | 'turn';
  workingDir: string;
  timeoutMs:  number;
  /** Its entry in the inner adapter's `exchanges`, which says what the request was. */
  exchange:   number;
  /** `false` when the caller asked for no backend tools of its own (the planner, the security review). */
  nativeTools?: boolean;
}

/**
 * The scripted planner's answer for `task`, which `maf run` plans as its title and its description:
 * text with no JSON plan block, so the planner makes one node of the role set's default role. The
 * runs these tests drive are about that node. Until F6 of the 0.3.0 release audit they got the same
 * node from the scripted adapter's *failure* to answer the planner, read as plan text; a failed
 * planner call now stops the run, so the plan is scripted.
 */
export function onePlannedNode(task: string): ScriptedTask {
  return { prompt: `Create a task execution DAG for: ${task}\n\n${task}`, steps: [], final: 'One node of the default role does the whole task.' };
}

/**
 * `inner` behind a wrapper that keeps each request's working directory and timeout. The scripted
 * adapter ignores both, so a run that pointed the planner or a gate at the wrong directory, or gave
 * it the wrong timeout, would pass unseen without this.
 */
export function recording(inner: ScriptedAdapter): { adapter: TurnAdapter; calls: AdapterCall[] } {
  const calls: AdapterCall[] = [];
  const note = (via: AdapterCall['via'], o: AdapterInvokeOptions): void => {
    calls.push({
      via, workingDir: o.workingDir, timeoutMs: o.timeoutMs, exchange: inner.exchanges.length,
      ...(o.nativeTools !== undefined ? { nativeTools: o.nativeTools } : {}),
    });
  };
  return {
    calls,
    adapter: {
      name:         inner.name,
      capabilities: () => inner.capabilities(),
      isAvailable:  () => inner.isAvailable(),
      invoke:       (o) => { note('invoke', o); return inner.invoke(o); },
      stream:       (o) => inner.stream(o),
      sendTurn:     (history, o) => { note('turn', o); return inner.sendTurn(history, o); },
    },
  };
}

export function registryOf(...adapters: CliAdapter[]): () => Map<AdapterName, CliAdapter> {
  return () => new Map(adapters.map((a) => [a.name, a]));
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A run opens an LCM store (better-sqlite3). A host whose native build does not load skips the
 * tests that run one, as goldens-offline does — never under CI, where the skip would leave the
 * claim proved by nothing.
 */
export const needsLcm = {
  skip: lcmLoads() || process.env['CI'] ? false : 'better-sqlite3 does not load on this host (CI runs this)',
  timeout: 120_000,
};

function lcmLoads(): boolean {
  try {
    new LcmEngine({ dbPath: ':memory:', contextThreshold: 0.75, freshTailCount: 64, mode: 'Upward', summarize: async () => '' }).close();
    return true;
  } catch {
    return false;
  }
}

// ── A user's repository ──────────────────────────────────────────────────────────────────────

export const BUGGY_SUM = 'module.exports = (a, b) => a - b;\n';
export const FIXED_SUM = 'module.exports = (a, b) => a + b;\n';

/**
 * The demo's buggy repository under `<root>/repo`, committed, with work the user has not committed:
 * a staged edit, an unstaged edit and an untracked file — what a run must neither see nor touch.
 * package.json is touched but unchanged, so a plain `git status` would refresh the index and write
 * it: a run that read the user's status that way would change the index's bytes.
 */
export async function dirtyUserRepo(root: string): Promise<string> {
  const repo = await createDemoFixture(root);
  await writeFile(path.join(repo, 'test.js'), `${await readFile(path.join(repo, 'test.js'), 'utf8')}// staged by the user\n`, 'utf8');
  await runIsolatedGit(repo, ['add', 'test.js']);
  await writeFile(path.join(repo, 'config.txt'), 'db_host=localhost\nport=6543\n', 'utf8');
  await writeFile(path.join(repo, 'notes.txt'), 'my own notes, never committed\n', 'utf8');
  const anHourAgo = new Date(Date.now() - 3_600_000);
  await utimes(path.join(repo, 'package.json'), anHourAgo, anHourAgo);
  return repo;
}

/** Everything of the user's a run could disturb, read without taking git's optional locks. */
export interface UserState {
  head:     string;
  branch:   string;
  status:   string[];
  files:    Record<string, string>;
  gitFiles: Record<string, string>;
}

/**
 * HEAD and its branch, `git status` (MAF's own `.maf/` left out: a run keeps its state there by
 * design), the bytes of every file outside `.git/` and `.maf/`, and the raw bytes of the index,
 * `.git/HEAD` and `.git/config`.
 */
export async function userState(repo: string): Promise<UserState> {
  const git = async (...args: string[]) => (await runIsolatedGit(repo, args, { env: { GIT_OPTIONAL_LOCKS: '0' } })).stdout;
  const files: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(repo, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (child === '.git' || child === '.maf') continue;
      if (entry.isDirectory()) await walk(child);
      else files[child] = (await readFile(path.join(repo, child))).toString('base64');
    }
  };
  await walk('');
  const gitFiles: Record<string, string> = {};
  for (const f of ['index', 'HEAD', 'config']) gitFiles[f] = (await readFile(path.join(repo, '.git', f))).toString('base64');
  return {
    head:   (await git('rev-parse', 'HEAD')).trim(),
    branch: (await git('symbolic-ref', '-q', 'HEAD')).trim(),
    status: (await git('status', '--porcelain=v1', '-z', '--untracked-files=all')).split('\0').filter((e) => e && !e.slice(3).startsWith('.maf/')),
    files,
    gitFiles,
  };
}

/** A policy file outside the repository: escalate a write to a lock file, allow the rest. */
export async function lockFilePolicy(root: string): Promise<string> {
  const file = path.join(root, 'policy.json');
  await writeFile(file, JSON.stringify({ rules: [{
    id: 'lock-files-need-a-human', description: 'a lock file changes only with a human\'s approval', priority: 95,
    predicate: { toolId: 'fs.write', pathGlob: '**/*.lock' }, action: { kind: 'Escalate', requiresApproval: true },
  }] }), 'utf8');
  return file;
}
