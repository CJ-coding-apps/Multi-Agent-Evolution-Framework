import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool, closedInput } from '../ToolPlugin.js';
import { makeToolId, resolveInside, toolEnv } from '@maf/types';
import { gitDirRefusal, namesGitDir, refuseGitDirPaths } from './fs.js';

const execFileAsync = promisify(execFile);

interface PatchInput {
  diff:    string;
  strip?:  number;
  dryRun?: boolean;
  [k: string]: unknown;
}

/**
 * The files a unified diff touches, from its own headers, after `strip` leading path components
 * — the same number `patch` is given with `-p`.
 *
 * Both header forms are read. `+++`/`---` is the authoritative pair, but a path visible only
 * in `diff --git` is still a path `patch` will touch, and a path the policy layer cannot see
 * is a path no rule can refuse — so this over-declares rather than miss one.
 *
 * `strip` is applied here rather than assuming git's `a/`: `patch -p0` on a `a/foo` header
 * touches `a/foo`, and declaring `foo` would hand the policy a file the command never opens.
 * A path with no component left after stripping is one `patch` itself refuses, so it is not
 * declared. `strip` defaults to 1, the `patch.apply` default.
 */
export function extractDiffPaths(diff: string, strip = 1): string[] {
  const paths = new Set<string>();
  const components = Number.isInteger(strip) && strip >= 0 ? strip : 1;
  const add = (raw: string): void => {
    const bare = raw.startsWith('"') && raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1) : raw;
    if (!bare || bare === '/dev/null') return;
    const parts = bare.split('/');
    if (components >= parts.length) return;
    const stripped = parts.slice(components).join('/') || undefined;
    if (stripped !== undefined && stripped !== '/dev/null') paths.add(stripped);
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
 * The files `patch` may write: the targets, and the reject/backup siblings it leaves beside a
 * target that does not apply cleanly (`<path>.rej`, and `<path>.orig` when it makes a backup).
 * Declaring them is what lets a path rule cover them — an editor's `.env.orig` is a copy of the
 * same secret.
 */
export function patchWritePaths(targets: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const target of targets) {
    paths.add(target);
    paths.add(`${target}.orig`);
    paths.add(`${target}.rej`);
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

/** The strip the command will be given, one value for both the declaration and the argv. */
function stripOf(input: PatchInput): number {
  return typeof input.strip === 'number' && Number.isInteger(input.strip) && input.strip >= 0 ? input.strip : 1;
}

export class PatchApplyTool extends BaseTool<PatchInput> {
  readonly id: ToolId = makeToolId('patch.apply');
  readonly name = 'patch.apply';
  readonly description = 'Apply a unified diff patch to the working tree. Use dryRun to verify before applying.';
  readonly permissionLevel = 'write' as const;
  readonly inputSchema = closedInput({
    diff:   { type: 'string', description: 'the unified diff to apply, with ---/+++ file headers' },
    strip:  { type: 'number', description: 'leading path components to strip from its file names, as patch -p (default 1)' },
    dryRun: { type: 'boolean', description: 'check that the diff applies without changing anything (default false)' },
  }, ['diff']);

  /**
   * A pure function of the diff — the same value the policy layer is handed, computed the
   * same way every time. Deriving this inside `execute` (and writing it back onto the input)
   * meant the gate had already run: `protect-secrets` denied `fs.write ".env"` and allowed a
   * patch writing the same file.
   */
  declaredPaths(input: PatchInput): string[] {
    const strip = stripOf(input);
    const targets = typeof input.diff === 'string' ? extractDiffPaths(input.diff, strip) : [];
    const written = patchWritePaths(targets);
    // Before policy, as fs.write does: a diff that touches .git is refused whatever the rules say.
    refuseGitDirPaths(this.name, written);
    return written;
  }

  async execute(input: PatchInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const unusable = this.unusable(input, t);
    if (unusable !== undefined) return unusable;
    await refuseGitDirTargets(this.name, ctx, this.declaredPaths(input));
    const tmpFile = path.join(tmpdir(), `maf-patch-${crypto.randomUUID()}.diff`);

    try {
      // `wx` fails rather than following a symlink planted at the path, and 0600 means the diff —
      // which can contain a secret the agent is moving — is not readable by other users while
      // `patch` works on it.
      await writeFile(tmpFile, input.diff, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

      const args = ['-p', String(stripOf(input))];
      if (input.dryRun) args.push('--dry-run');
      args.push('-i', tmpFile);

      try {
        const r = await execFileAsync('patch', args, { cwd: ctx.cwd, env: toolEnv() });
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
