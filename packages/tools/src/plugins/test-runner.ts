import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool } from '../ToolPlugin.js';
import { makeToolId } from '@maf/types';

type TestRunner = 'auto' | 'bun' | 'node' | 'npm' | 'pnpm' | 'vitest' | 'jest' | 'pytest' | 'cargo';

interface TestInput {
  runner?:   TestRunner;
  filter?:   string;
  coverage?: boolean;
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

  async execute(input: TestInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
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
    case 'vitest':  return ['npx', 'vitest', 'run', ...(input.filter ? ['--reporter=verbose', input.filter] : [])];
    case 'jest':    return ['npx', 'jest', '--forceExit', ...(input.filter ? ['--testPathPattern', input.filter] : [])];
    case 'pytest':  return ['python', '-m', 'pytest', ...(input.filter ? ['-k', input.filter] : [])];
    case 'cargo':   return ['cargo', 'test', ...(input.filter ? [input.filter] : [])];
    default:        return ['npm', 'test'];
  }
}
