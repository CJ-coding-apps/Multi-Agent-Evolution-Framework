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
 * How long the child's `exit` waits for `close` before the call answers anyway (WP-3.9 G16b).
 *
 * `close` fires only when the child has exited *and* its stdio is closed. A suite that leaves a
 * helper holding the inherited stdout — `vitest run` with a worker, a test that starts a server —
 * keeps that second half from ever happening, so a passing suite was answered by the timeout: exit
 * code 124 and a `[TIMEOUT …]` line, for a run that had already finished. The group is killed on
 * `exit`, which is what closes that stdout, so this grace is only the time the kernel needs to
 * deliver the follow-up event — not a second budget for the suite.
 */
const CLOSE_GRACE_MS = 100;

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

/**
 * Every runner still in flight (WP-3.9 F9). A tool call that returns does not necessarily end the
 * process group it started: the runner exits and leaves its own children behind, and a MAF that is
 * interrupted leaves the runner behind. Each is a process the operator never sees — a server still
 * holding a port, a watcher still writing files — so a call removes its group on every exit it can
 * observe, and the process-level hooks below cover the exits it cannot.
 */
const live = new Set<ChildProcess>();
let exitHooksInstalled = false;

/** Send `signal` to every in-flight group; the callers decide when. */
function reapAll(signal: NodeJS.Signals): void {
  for (const proc of live) killProcessGroup(proc, signal);
}

/**
 * Cover the exit MAF did not choose. Installed once per process, at the first runner:
 *
 * - `exit` covers a normal end — `process.on('exit')` runs with the event loop stopped, and a
 *   synchronous `kill` still reaches the kernel.
 * - `SIGINT` / `SIGTERM` cover the terminal and a supervisor. Node runs listeners instead of the
 *   default action, so the hook kills the groups and then re-raises the signal at itself; `once`
 *   has already removed the listener, so the re-raise takes the default action and MAF dies with
 *   the status it would have had without the hook.
 *
 * Both are `once`: a second runner must not stack a second listener.
 */
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on('exit', () => reapAll('SIGKILL'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      reapAll('SIGKILL');
      process.kill(process.pid, signal);
    });
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

    installExitHooks();
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

      live.add(proc);

      // Three paths answer a call — close, error, timeout — and the first one to arrive wins. Losing
      // the race is not harmless: a timer that fires after `close` used to resolve a second time (the
      // later value discarded) and, now that a call owns a process group, it would also reap a group
      // that is already finished. `settle` answers once and stops tracking the group.
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const settle = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace !== undefined) clearTimeout(grace);
        live.delete(proc);
        resolve(result);
      };
      /** The result of this run, with `code` as the runner's own exit status. */
      const answer = (code: number | null): ToolResult => ({
        stdout, stderr, exitCode: code ?? 1, duration: performance.now() - t, metadata: { runner, timeoutMs },
      });

      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        killProcessGroup(proc, 'SIGKILL');
        settle({
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
      proc.on('error', (err: Error) => settle(this.failed(err, t)));

      // A normal exit is the end of the runner, not necessarily the end of its group (WP-3.9 F9).
      // `vitest run` that leaves a worker, `npm test` that leaves the script's shell, a test that
      // starts a server and does not stop it: all of them exit 0 and leave a process behind that
      // the operator never asked for and MAF no longer tracks. Reaping on every observed exit —
      // not only the timeout — is what makes "the call ended" mean "the group ended".
      //
      // `exit` answers the call first (WP-3.9 G16b). It fires when the child is gone; `close` also
      // waits for the child's stdio, and a helper that inherited stdout keeps that from happening,
      // so the run was reported as a timeout (124) after it had passed. The group kill here is what
      // closes the pipe; if `close` follows within the grace, it answers with the same status.
      proc.on('exit', (code: number | null) => {
        killProcessGroup(proc, 'SIGKILL');
        // `close` may have answered already, and the timeout may have; a grace scheduled then would
        // hold the event loop for its whole duration with nothing left to answer.
        if (settled) return;
        grace = setTimeout(() => settle(answer(code)), CLOSE_GRACE_MS);
      });

      proc.on('close', (code: number | null) => {
        killProcessGroup(proc, 'SIGKILL');
        settle(answer(code));
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
