import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool, closedInput } from '../ToolPlugin.js';
import { makeToolId, resolveInside, toolEnv } from '@maf/types';

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
  options: { encoding: 'utf8'; cwd: string; env?: NodeJS.ProcessEnv },
) => GrepSpawnResult;

const spawnSearch: GrepSpawn = (command, args, options) => spawnSync(command, args, options);

export class GrepTool extends BaseTool<GrepInput> {
  readonly id: ToolId = makeToolId('grep');
  readonly name = 'grep';
  readonly description = 'Search for a pattern in files using ripgrep. Returns matching lines with file paths and line numbers.';
  readonly permissionLevel = 'read' as const;
  readonly inputSchema = closedInput({
    pattern:    { type: 'string', description: 'the regular expression to search for' },
    path:       { type: 'string', description: 'the file or directory to search, relative to the working directory (default: all of it)' },
    glob:       { type: 'string', description: 'search only files matching this glob, e.g. "*.ts"' },
    ignoreCase: { type: 'boolean', description: 'match regardless of case (default false)' },
    maxResults: { type: 'number', description: 'at most this many matching lines per file' },
    context:    { type: 'number', description: 'lines of context to show around each match' },
  }, ['pattern']);

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
    const unusable = this.unusable(input, t);
    if (unusable !== undefined) return unusable;
    // Resolved inside the project root, as the fs tools resolve theirs: `path.resolve(ctx.cwd, …)`
    // searched wherever `../` or an absolute path led a caller that bypassed the gate. A path that
    // leaves the root, or a root that cannot be resolved, is a failed result.
    let searchPath = ctx.cwd;
    if (input.path) {
      try {
        searchPath = (await resolveInside(ctx.projectRoot, input.path)).absolute;
      } catch (err: unknown) {
        return this.failed(err, t);
      }
    }

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
    const rg = this.spawn('rg', args, { encoding: 'utf8', cwd: ctx.cwd, env: toolEnv() });
    if (rg.error) {
      const grep = this.spawn('grep', ['-rn', ...(input.ignoreCase ? ['-i'] : []), '-e', input.pattern, '--', searchPath], { encoding: 'utf8', cwd: ctx.cwd, env: toolEnv() });
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
