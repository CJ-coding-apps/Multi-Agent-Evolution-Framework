import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import type { AdapterName, CliAdapter } from '@maf/types';
import { LcmEngine } from '@maf/lcm';
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
