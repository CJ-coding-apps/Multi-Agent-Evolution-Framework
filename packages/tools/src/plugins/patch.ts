import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool } from '../ToolPlugin.js';
import { makeToolId } from '@maf/types';

const execFileAsync = promisify(execFile);

interface PatchInput {
  diff:    string;
  strip?:  number;
  dryRun?: boolean;
  paths?:  string[];
  [k: string]: unknown;
}

export function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      if (raw && raw !== '/dev/null') {
        const stripped = raw.replace(/^[ab]\//, '');
        if (stripped) paths.add(stripped);
      }
    } else if (line.startsWith('--- ')) {
      const raw = line.slice(4).trim();
      if (raw && raw !== '/dev/null') {
        const stripped = raw.replace(/^[ab]\//, '');
        if (stripped) paths.add(stripped);
      }
    }
  }
  return [...paths];
}

export class PatchApplyTool extends BaseTool<PatchInput> {
  readonly id: ToolId = makeToolId('patch.apply');
  readonly name = 'patch.apply';
  readonly description = 'Apply a unified diff patch to the working tree. Use dryRun to verify before applying.';
  readonly permissionLevel = 'write' as const;

  async execute(input: PatchInput, ctx: ToolContext): Promise<ToolResult> {
    // Populate input.paths from the diff so policy.evaluate can match path globs
    // across every file the patch touches, not just whatever the caller passed in.
    if (!input.paths || input.paths.length === 0) {
      input.paths = extractDiffPaths(input.diff);
    }

    const t = performance.now();
    const tmpFile = path.join(tmpdir(), `maf-patch-${crypto.randomUUID()}.diff`);

    try {
      await writeFile(tmpFile, input.diff, 'utf8');

      const args = ['-p', String(input.strip ?? 1)];
      if (input.dryRun) args.push('--dry-run');
      args.push('-i', tmpFile);

      try {
        const r = await execFileAsync('patch', args, { cwd: ctx.cwd });
        return {
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: 0,
          duration: performance.now() - t,
          metadata: { dryRun: input.dryRun ?? false },
        };
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
          exitCode: err.code ?? 1,
          duration: performance.now() - t,
          metadata: { dryRun: input.dryRun ?? false },
        };
      }
    } finally {
      await unlink(tmpFile).catch(() => undefined);
    }
  }
}
