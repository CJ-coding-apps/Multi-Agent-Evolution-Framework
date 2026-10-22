import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool, closedInput } from '../ToolPlugin.js';
import { makeToolId, toolEnv } from '@maf/types';

const RUNNERS = ['auto', 'bun', 'node', 'npm', 'pnpm', 'vitest', 'jest', 'pytest', 'cargo'] as const;
type TestRunner = typeof RUNNERS[number];
/** Every runner except `auto`, which is resolved before an argv is built. */
type ConcreteRunner = Exclude<TestRunner, 'auto'>;

/**
 * A run cannot outlast this, however large the caller's `timeout`. A test command is a tool call
 * inside a node's budget, not a background job: without a ceiling a model that asks for an hour
 * holds a node (and, at `maxConcurrent`, a slot) for an hour. The value is long enough for a
 * large suite and short enough that one node cannot stall a run all afternoon.
 */
export const MAX_TEST_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 120_000;

/**
 * Stop the child and everything it started. The child is spawned `detached` on POSIX, so it is
 * the leader of its own process group and `-pid` names the group; signalling only `pid` is how
 * the old code left a runner's own children (vitest workers, `npm`'s script shell) alive after
 * the timeout answered 124.
 */
function killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  if (process.platform === 'win32') {
    // No process groups in the POSIX sense; the tree needs `taskkill /T`. The direct child is
    // still better than nothing, and is what the old path did.
    proc.kill(signal);
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    // The group is already gone, or the child exited between the timeout and the signal.
    proc.kill(signal);
  }
}

/** No `coverage`: it was declared here and read nowhere, so the schema does not offer it. */
interface TestInput {
  runner?:   TestRunner;
  filter?:   string;
  timeout?:  number;
  [k: string]: unknown;
}

async function detectRunner(cwd: string): Promise<ConcreteRunner> {
  const { readFile } = await import('node:fs/promises');
  try {
    const pkg = JSON.parse(await readFile(`${cwd}/package.json`, 'utf8')) as { scripts?: Record<string, string> };
    const testScript = pkg.scripts?.['test'] ?? '';
    if (testScript.includes('vitest'))  return 'vitest';
    if (testScript.includes('jest'))    return 'jest';
    if (testScript.includes('bun'))     return 'bun';
  } catch { /* no package.json */ }
  try {
    await readFile(`${cwd}/Cargo.toml`, 'utf8');
    return 'cargo';
  } catch { /* not rust */ }
  try {
    await readFile(`${cwd}/pyproject.toml`, 'utf8');
    return 'pytest';
  } catch { /* not python */ }
  return 'npm';
}

export class TestRunnerTool extends BaseTool<TestInput> {
  readonly id: ToolId = makeToolId('test.run');
  readonly name = 'test.run';
  readonly description = 'Run the project test suite. Auto-detects runner (bun/vitest/jest/pytest/cargo). Returns pass/fail summary.';
  readonly permissionLevel = 'execute' as const;
  readonly inputSchema = closedInput({
    runner:  { type: 'string', description: 'which runner to use (default "auto": detected from the project)', enum: RUNNERS },
    filter:  { type: 'string', description: 'run only the tests matching this; ignored when the runner is npm, node or pnpm' },
    timeout: { type: 'number', description: 'milliseconds before the run is stopped (default 120000)' },
  });

  /**
   * No path argument, so there is no path to declare. What test.run can reach is governed by
   * its tool id and the `execute` permission level, not by a path rule — and inventing a path
   * here would make a path rule deny a call that never named one.
   */
  declaredPaths(): string[] { return []; }

  async execute(input: TestInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const unusable = this.unusable(input, t);
    if (unusable !== undefined) return unusable;

    // The schema's enum already refuses a name outside the list; this is the same check at the
    // point the argv is built, so a caller that bypasses schema validation still cannot reach
    // the old fall-through (`npm test` for anything unrecognised — a runner the caller did not
    // ask for, chosen silently).
    if (input.runner !== undefined && input.runner !== 'auto' && !(RUNNERS as readonly string[]).includes(input.runner)) {
      return this.failed(new Error(`unknown test runner ${JSON.stringify(input.runner)}; expected one of ${RUNNERS.join(', ')}`), t);
    }
    // A filter is model-authored. One that begins with `-` is an option, not a filter, whichever
    // runner reads it — refuse it here rather than rely on every runner's parser.
    if (typeof input.filter === 'string' && input.filter.startsWith('-')) {
      return this.failed(new Error(`filter must not begin with "-": ${JSON.stringify(input.filter)}`), t);
    }
    const runner = input.runner === 'auto' || !input.runner
      ? await detectRunner(ctx.cwd)
      : input.runner;

    const argv = buildTestCommand(runner, input);
    const cmd  = argv[0]!;
    const args = argv.slice(1);
    const requestedMs = typeof input.timeout === 'number' && Number.isFinite(input.timeout) && input.timeout > 0
      ? input.timeout
      : DEFAULT_TEST_TIMEOUT_MS;
    const timeoutMs = Math.min(requestedMs, MAX_TEST_TIMEOUT_MS);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const proc = spawn(cmd, args, {
        cwd: ctx.cwd,
        shell: false,
        // The group this process leads is what the timeout kills. On Windows there is no
        // equivalent, so the child is spawned normally and only it is signalled.
        detached: process.platform !== 'win32',
        env: toolEnv(),
      });

      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        killProcessGroup(proc, 'SIGKILL');
        resolve({
          stdout,
          stderr: stderr + `\n[TIMEOUT after ${String(timeoutMs)} ms]`,
          exitCode: 124,
          duration: performance.now() - t,
          metadata: { runner, timeoutMs },
        });
      }, timeoutMs);

      // A runner that is not installed (`bun`, `python`, `cargo` …) fails the spawn, not the run.
      // Node emits `error` for that, and an unhandled `error` on a ChildProcess is fatal to the whole
      // process: one missing binary ended a live run with an attestation-less death, not a failed node.
      // Answer it the way WP-2.18 answers a tool that fails while running — with a result.
      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        resolve(this.failed(err, t));
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1, duration: performance.now() - t, metadata: { runner, timeoutMs } });
      });
    });
  }
}

/**
 * The argv for one run. The runner is a member of the enum by construction; the default throws
 * rather than picking a runner the caller did not ask for.
 *
 * The filter is the one model-authored argument. Where the runner takes a positional filter
 * (`bun`, `cargo`) it follows `--`, so it cannot be read as another option; where the filter is
 * the value of an option (`--testPathPattern`, `-k`) the option consumes it already, and a `--`
 * there would change how the runner parses the rest. `execute` additionally refuses a filter
 * that begins with `-`, which covers the positional cases even if a runner treats `--` loosely.
 */
export function buildTestCommand(runner: ConcreteRunner, input: TestInput): string[] {
  const filter = input.filter;
  switch (runner) {
    case 'bun':     return ['bun', 'test', ...(filter ? ['--', filter] : [])];
    // `node` and `pnpm` are both in the schema's enum, so a model may ask for either. With no case
    // they fell through to `npm test` — the one runner the `node:test` fixture wanted ran npm
    // instead. `node --test` takes no `filter`; the schema's description already says so.
    case 'node':    return ['node', '--test'];
    case 'pnpm':    return ['pnpm', 'test'];
    case 'npm':     return ['npm', 'test'];
    // `--no-install`: without it `npx` downloads the runner from the registry when the project does
    // not have it installed — a network fetch (and code execution) chosen by a model-authored
    // `runner` field. With it, a missing runner fails by name instead (WP-3.9 F15).
    //
    // No `--` before vitest's filter, deliberately (WP-3.9 F12): vitest parses with cac, which cuts
    // argv at `--` and puts everything after it in `options['--']` rather than in `filters`, so
    // `vitest run -- <filter>` silently runs the whole suite instead of filtering it.
    case 'vitest':  return ['npx', '--no-install', 'vitest', 'run', ...(filter ? ['--reporter=verbose', filter] : [])];
    case 'jest':    return ['npx', '--no-install', 'jest', '--forceExit', ...(filter ? ['--testPathPattern', filter] : [])];
    case 'pytest':  return ['python', '-m', 'pytest', ...(filter ? ['-k', filter] : [])];
    case 'cargo':   return ['cargo', 'test', ...(filter ? ['--', filter] : [])];
    default: {
      const unreachable: never = runner;
      throw new Error(`unknown test runner ${String(unreachable)}`);
    }
  }
}
