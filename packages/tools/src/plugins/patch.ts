import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool, closedInput } from '../ToolPlugin.js';
import { makeToolId, resolveInside, ToolDeclarationError } from '@maf/types';
import { gitDirRefusal, namesGitDir, refuseGitDirPaths } from './fs.js';

const execFileAsync = promisify(execFile);

interface PatchInput {
  diff:    string;
  strip?:  number;
  dryRun?: boolean;
  [k: string]: unknown;
}

/**
 * A header name cut at the first TAB that is not inside quotes. `diff -u` writes
 * `+++ b/Cargo.lock\t2026-01-01 00:00:00`, and keeping the timestamp made the declared name
 * `Cargo.lock\t2026-…`, so no path rule matched the file the command went on to write.
 */
function cutTimestamp(raw: string): string {
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '\t' && !quoted) return raw.slice(0, i);
  }
  return raw;
}

/** `--- 1,4 ----` / `*** 1,4 ****` are a context diff's hunk separators, not file names. */
const CONTEXT_HUNK_SEPARATOR = /^\d+(?:,\d+)? [*-]+$/;

/**
 * The files a diff touches, from its own headers, after `strip` leading path components — the
 * same number `patch` is given with `-p`.
 *
 * Every header form GNU `patch` reads is covered: `+++`/`---` (unified), the `*** old` / `--- new`
 * pair (context), `Index:`, and `diff --git` (which also names a rename's two paths, and a binary
 * patch's file). A path visible in only one of them is still a path `patch` will touch, and a path
 * the policy layer cannot see is a path no rule can refuse — so this over-declares rather than miss
 * one. Names are cut at the timestamp tab, and a context diff's hunk separators are skipped.
 *
 * `strip` is applied here rather than assuming git's `a/`: `patch -p0` on an `a/foo` header
 * touches `a/foo`, and declaring `foo` would hand the policy a file the command never opens.
 * `strip` defaults to 1, the `patch.apply` default.
 *
 * **Fails closed.** A diff that leaves no file name at all — or one whose names all vanish under
 * the chosen strip — is refused with `ToolDeclarationError`: a diff whose targets cannot be read
 * is one no path rule can cover, and the reported case was an `Index:`-only diff, which declared
 * nothing and wrote `.env` under every shipped Deny rule. Refusing here happens before policy is
 * consulted (`gatedExec` turns it into an attested refusal), so nothing is written.
 */
export function extractDiffPaths(diff: string, strip = 1): string[] {
  const paths = new Set<string>();
  const components = Number.isInteger(strip) && strip >= 0 ? strip : 1;
  const add = (raw: string): void => {
    let name = cutTimestamp(raw).trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length > 1) name = name.slice(1, -1);
    if (!name || name === '/dev/null' || CONTEXT_HUNK_SEPARATOR.test(name)) return;
    const parts = name.split('/');
    if (components >= parts.length) return;
    const stripped = parts.slice(components).join('/') || undefined;
    if (stripped !== undefined && stripped !== '/dev/null') paths.add(stripped);
  };
  const lines = diff.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.startsWith('*** ') && next !== undefined && next.startsWith('--- ')) {
      // A context diff names the old file on `*** ` and the new one on the `--- ` after it.
      add(line.slice(4));
      add(next.slice(4));
      i += 1;
    } else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      add(line.slice(4));
    } else if (line.startsWith('Index: ')) {
      add(line.slice('Index: '.length));
    } else if (line.startsWith('diff --git ')) {
      for (const token of line.slice('diff --git '.length).match(/"[^"]*"|\S+/g) ?? []) add(token);
    }
  }
  if (paths.size === 0) {
    throw new ToolDeclarationError(
      'patch.apply cannot read any file name from this diff\'s headers, so no path rule can cover '
      + 'what it would write, and the call is refused before anything runs. Use a unified diff whose '
      + '`---`/`+++` lines (or an `Index:` line) name the files.',
    );
  }
  return [...paths];
}

/** The strip the command will be given, one value for both the declaration and the argv. */
function stripOf(input: PatchInput): number {
  return typeof input.strip === 'number' && Number.isInteger(input.strip) && input.strip >= 0 ? input.strip : 1;
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
    if (typeof input.diff !== 'string') {
      // The gate checks the schema first; a direct caller gets the same answer: no diff, no declaration,
      // and no call.
      throw new ToolDeclarationError(
        'patch.apply can only declare the files a diff touches when it is given a `diff` string, and this '
        + 'call has none, so no path rule can cover it.',
      );
    }
    const paths = extractDiffPaths(input.diff, strip);
    // Before policy, as fs.write does: a diff that touches .git is refused whatever the rules say.
    refuseGitDirPaths(this.name, paths);
    return paths;
  }

  async execute(input: PatchInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const unusable = this.unusable(input, t);
    if (unusable !== undefined) return unusable;
    await refuseGitDirTargets(this.name, ctx, this.declaredPaths(input));
    const tmpFile = path.join(tmpdir(), `maf-patch-${crypto.randomUUID()}.diff`);

    try {
      await writeFile(tmpFile, input.diff, 'utf8');

      // The same sanitised value the declaration used: `patch -p -1` opens no file the policy saw.
      const args = ['-p', String(stripOf(input))];
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
