import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool } from '../ToolPlugin.js';
import { makeToolId, resolveInside } from '@maf/types';
import { gitDirRefusal, namesGitDir, refuseGitDirPaths } from './fs.js';

const execFileAsync = promisify(execFile);

interface PatchInput {
  diff:    string;
  strip?:  number;
  dryRun?: boolean;
  [k: string]: unknown;
}

/**
 * The files a unified diff touches, from its own headers.
 *
 * Both header forms are read. `+++`/`---` is the authoritative pair, but a path visible only
 * in `diff --git` is still a path `patch` will touch, and a path the policy layer cannot see
 * is a path no rule can refuse — so this over-declares rather than miss one.
 */
export function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  const add = (raw: string): void => {
    const bare = raw.startsWith('"') && raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1) : raw;
    const stripped = bare.replace(/^[ab]\//, '');
    if (stripped && stripped !== '/dev/null') paths.add(stripped);
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      add(line.slice(4).trim());
    } else if (line.startsWith('diff --git ')) {
      for (const token of line.slice('diff --git '.length).match(/"[^"]*"|\S+/g) ?? []) add(token);
    }
  }
  return [...paths];
}

/**
 * The resolved half of the `.git` refusal: a path whose spelling avoids `.git` but that resolves into
 * it through a link inside the root. A path that does not resolve inside the root is the policy
 * engine's to refuse (this tool is confined there only; see docs/SECURITY.md), so it is passed over.
 */
async function refuseGitDirTargets(tool: string, ctx: ToolContext, paths: readonly string[]): Promise<void> {
  for (const p of paths) {
    const relative = await resolveInside(ctx.projectRoot, p).then((c) => c.relative, () => undefined);
    if (relative !== undefined && namesGitDir(relative)) {
      throw gitDirRefusal(tool, p, `it resolves to ${JSON.stringify(relative)}, which is git's own data (.git)`);
    }
  }
}

export class PatchApplyTool extends BaseTool<PatchInput> {
  readonly id: ToolId = makeToolId('patch.apply');
  readonly name = 'patch.apply';
  readonly description = 'Apply a unified diff patch to the working tree. Use dryRun to verify before applying.';
  readonly permissionLevel = 'write' as const;

  /**
   * A pure function of the diff — the same value the policy layer is handed, computed the
   * same way every time. Deriving this inside `execute` (and writing it back onto the input)
   * meant the gate had already run: `protect-secrets` denied `fs.write ".env"` and allowed a
   * patch writing the same file.
   */
  declaredPaths(input: PatchInput): string[] {
    const paths = typeof input.diff === 'string' ? extractDiffPaths(input.diff) : [];
    // Before policy, as fs.write does: a diff that touches .git is refused whatever the rules say.
    refuseGitDirPaths(this.name, paths);
    return paths;
  }

  async execute(input: PatchInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    await refuseGitDirTargets(this.name, ctx, this.declaredPaths(input));
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
