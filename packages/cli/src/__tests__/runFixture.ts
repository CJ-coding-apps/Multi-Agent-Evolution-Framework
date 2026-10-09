import { Command } from 'commander';
import type { AdapterName, CliAdapter } from '@maf/types';
import { registerRunCommand } from '../commands/run.js';
import type { RunDeps } from '../commands/run.js';

/** What a `maf run` printed, and what it threw (the CLI turns a throw into exit 1). */
export interface DrivenRun {
  out:    string;
  err:    string;
  error?: unknown;
}

/** Writes into a string, so a test reads what `run` printed. */
export function collector(): { write(text: string): boolean; text(): string } {
  let buf = '';
  return { write: (text: string) => { buf += text; return true; }, text: () => buf };
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
  try {
    await program.parseAsync(['run', ...args], { from: 'user' });
    return { out: stdout.text(), err: stderr.text() };
  } catch (error: unknown) {
    return { out: stdout.text(), err: stderr.text(), error };
  }
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

export function registryOf(...adapters: CliAdapter[]): () => Map<AdapterName, CliAdapter> {
  return () => new Map(adapters.map((a) => [a.name, a]));
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
