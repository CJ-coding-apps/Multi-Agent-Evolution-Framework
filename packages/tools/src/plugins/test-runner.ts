import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool, closedInput } from '../ToolPlugin.js';
import { makeToolId } from '@maf/types';

const RUNNERS = ['auto', 'bun', 'node', 'npm', 'pnpm', 'vitest', 'jest', 'pytest', 'cargo'] as const;
type TestRunner = typeof RUNNERS[number];

/** No `coverage`: it was declared here and read nowhere, so the schema does not offer it. */
interface TestInput {
  runner?:   TestRunner;
  filter?:   string;
  timeout?:  number;
  [k: string]: unknown;
}

async function detectRunner(cwd: string): Promise<TestRunner> {
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
    const runner = input.runner === 'auto' || !input.runner
      ? await detectRunner(ctx.cwd)
      : input.runner;

    const argv = buildCommand(runner, input);
    const cmd  = argv[0]!;
    const args = argv.slice(1);
    const timeoutMs = input.timeout ?? 120_000;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const proc = spawn(cmd, args, { cwd: ctx.cwd, shell: false });

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({ stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: 124, duration: performance.now() - t, metadata: { runner } });
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
        resolve({ stdout, stderr, exitCode: code ?? 1, duration: performance.now() - t, metadata: { runner } });
      });
    });
  }
}

function buildCommand(runner: TestRunner, input: TestInput): string[] {
  switch (runner) {
    case 'bun':     return ['bun', 'test', ...(input.filter ? ['--filter', input.filter] : [])];
    // `node` and `pnpm` are both in the schema's enum, so a model may ask for either. With no case
    // they fell through to `npm test` — the one runner the `node:test` fixture wanted ran npm
    // instead. `node --test` takes no `filter`; the schema's description already says so.
    case 'node':    return ['node', '--test'];
    case 'pnpm':    return ['pnpm', 'test'];
    case 'vitest':  return ['npx', 'vitest', 'run', ...(input.filter ? ['--reporter=verbose', input.filter] : [])];
    case 'jest':    return ['npx', 'jest', '--forceExit', ...(input.filter ? ['--testPathPattern', input.filter] : [])];
    case 'pytest':  return ['python', '-m', 'pytest', ...(input.filter ? ['-k', input.filter] : [])];
    case 'cargo':   return ['cargo', 'test', ...(input.filter ? [input.filter] : [])];
    default:        return ['npm', 'test'];
  }
}
