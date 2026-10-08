import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool } from '../ToolPlugin.js';
import { makeToolId } from '@maf/types';

interface GrepInput {
  pattern:     string;
  path?:       string;
  glob?:       string;
  ignoreCase?: boolean;
  maxResults?: number;
  context?:    number;
  [k: string]: unknown;
}

/** The part of a finished `spawnSync` child that `execute` reads. */
export interface GrepSpawnResult {
  stdout: string | null;
  stderr: string | null;
  status: number | null;
  error?: Error | undefined;
}

/**
 * How grep starts its search binary. A constructor parameter so a test can assert the exact argv
 * without depending on which binaries the machine has; production passes straight to `spawnSync`.
 */
export type GrepSpawn = (
  command: string,
  args: readonly string[],
  options: { encoding: 'utf8'; cwd: string },
) => GrepSpawnResult;

const spawnSearch: GrepSpawn = (command, args, options) => spawnSync(command, args, options);

export class GrepTool extends BaseTool<GrepInput> {
  readonly id: ToolId = makeToolId('grep');
  readonly name = 'grep';
  readonly description = 'Search for a pattern in files using ripgrep. Returns matching lines with file paths and line numbers.';
  readonly permissionLevel = 'read' as const;

  constructor(private readonly spawn: GrepSpawn = spawnSearch) { super(); }

  /**
   * Searching the whole working directory is a real path surface, so it is declared as one
   * (`.`) rather than as nothing. Before this, grep had no path at all: a rule could not
   * allow it a subtree or deny it a file, because policy had nothing to match against.
   */
  declaredPaths(input: GrepInput): string[] {
    return typeof input.path === 'string' && input.path ? [input.path] : ['.'];
  }

  async execute(input: GrepInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const searchPath = input.path ? path.resolve(ctx.cwd, input.path) : ctx.cwd;

    // Every model-supplied value is either bound to its flag (`--glob=…`) or placed after `-e` and
    // `--`, so none of them can stand as an option. A bare pattern of `--pre=sh` was read by rg as
    // "run every file through sh", and the search path became the pattern.
    const args: string[] = ['--line-number', '--no-heading'];
    if (input.ignoreCase) args.push('--ignore-case');
    if (input.maxResults) args.push(`--max-count=${String(input.maxResults)}`);
    if (input.context) args.push(`--context=${String(input.context)}`);
    if (input.glob) args.push(`--glob=${input.glob}`);
    args.push('-e', input.pattern, '--', searchPath);

    // prefer rg, fallback to grep
    const rg = this.spawn('rg', args, { encoding: 'utf8', cwd: ctx.cwd });
    if (rg.error) {
      const grep = this.spawn('grep', ['-rn', ...(input.ignoreCase ? ['-i'] : []), '-e', input.pattern, '--', searchPath], { encoding: 'utf8', cwd: ctx.cwd });
      return {
        stdout: grep.stdout ?? '',
        stderr: grep.stderr ?? '',
        exitCode: grep.status ?? 1,
        duration: performance.now() - t,
        metadata: {},
      };
    }
    return {
      stdout: rg.stdout ?? '',
      stderr: rg.stderr ?? '',
      exitCode: rg.status ?? 0,
      duration: performance.now() - t,
      metadata: {},
    };
  }
}
