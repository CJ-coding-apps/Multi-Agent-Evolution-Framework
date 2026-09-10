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

export class GrepTool extends BaseTool<GrepInput> {
  readonly id: ToolId = makeToolId('grep');
  readonly name = 'grep';
  readonly description = 'Search for a pattern in files using ripgrep. Returns matching lines with file paths and line numbers.';
  readonly permissionLevel = 'read' as const;

  async execute(input: GrepInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const searchPath = input.path ? path.resolve(ctx.cwd, input.path) : ctx.cwd;

    const args: string[] = ['--line-number', '--no-heading'];
    if (input.ignoreCase) args.push('--ignore-case');
    if (input.maxResults) args.push('--max-count', String(input.maxResults));
    if (input.context) args.push('--context', String(input.context));
    if (input.glob) args.push('--glob', input.glob);
    args.push(input.pattern, searchPath);

    // prefer rg, fallback to grep
    const rg = spawnSync('rg', args, { encoding: 'utf8', cwd: ctx.cwd });
    if (rg.error) {
      const grep = spawnSync('grep', ['-rn', ...(input.ignoreCase ? ['-i'] : []), input.pattern, searchPath], { encoding: 'utf8', cwd: ctx.cwd });
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
