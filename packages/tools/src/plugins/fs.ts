import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool } from '../ToolPlugin.js';
import { makeToolId, resolveInside } from '@maf/types';

/**
 * The single path a one-path tool declares, or `[]` when the model omitted it — a call with
 * no path touches nothing, and the tool fails on its own when it runs. Never invents a path.
 */
function onePath(input: { path?: unknown }): string[] {
  return typeof input.path === 'string' && input.path ? [input.path] : [];
}

/**
 * The one place these tools turn model-supplied input into a path a syscall will take.
 *
 * `path.resolve(ctx.cwd, input.path)` — what this replaces — accepts a traversal, an absolute
 * path, or a symlink pointing anywhere, so all five tools could read and write outside the
 * project: `../.env` left the root and no rule stopped it, because the policy layer matched the
 * raw string against a glob written for paths relative to the root. `resolveInside` resolves the
 * real path and refuses anything that leaves `ctx.projectRoot`, so the value handed to the
 * syscall is a value that was checked, and the string a path rule matched is a description of
 * that same file.
 *
 * It throws rather than returning a failed `ToolResult`. `fs.read` on a missing file already
 * throws, and a path outside the root is the same kind of thing: the tool has no answer to give,
 * and a result saying otherwise would be a result it did not obtain. Through the gate the policy
 * engine's own confinement has already refused with a `Deny`, so the model sees a policy refusal
 * and the run continues; this is the second line, and it is what keeps a direct
 * `tool.execute(...)` — one that never went past the gate — no less confined.
 */
async function confinedPath(ctx: ToolContext, p: string): Promise<string> {
  return (await resolveInside(ctx.projectRoot, p)).absolute;
}

// ── git's own data ────────────────────────────────────────────────────────────

/**
 * Whether `p` has a `.git` segment at any depth. Compared without case, because a case-insensitive
 * filesystem (macOS by default) opens `.GIT` as `.git`.
 */
export function namesGitDir(p: string): boolean {
  return p.split(/[\\/]+/).some((segment) => segment.toLowerCase() === '.git');
}

/** The refusal every write or delete tool gives for a path into `.git`; `why` says how it got there. */
export function gitDirRefusal(tool: string, p: string, why: string): Error {
  return new Error(
    `${tool} refuses ${JSON.stringify(p)}: ${why}. The run's tools never write or delete git's own ` +
    `data, because the worktree's .git is what keeps git — and every git tool — on the run's branch ` +
    `rather than on your repository.`,
  );
}

/**
 * Refuses a path naming `.git`, before policy: a write or delete tool calls this from
 * `declaredPaths`, which the gate evaluates before any rule, so no rule set — the empty one included —
 * and no approval can let one through. Deleting a worktree's `.git` file makes git find the user's
 * repository above it; rewriting it to `gitdir: <repo>/.git` points every git call at the user's branch.
 */
export function refuseGitDirPaths(tool: string, paths: readonly string[]): void {
  for (const p of paths) {
    if (namesGitDir(p)) throw gitDirRefusal(tool, p, 'the path names git\'s own data (.git)');
  }
}

/**
 * The same refusal on the resolved path, for a write or delete about to run: a link inside the root
 * that leads into `.git` passes the check on the spelling and not this one. The root itself is
 * refused too, since it holds `.git`.
 */
async function writablePath(ctx: ToolContext, tool: string, p: string): Promise<string> {
  refuseGitDirPaths(tool, [p]);
  const confined = await resolveInside(ctx.projectRoot, p);
  if (confined.relative === '') throw gitDirRefusal(tool, p, 'it is the project root, which holds git\'s own data (.git)');
  if (namesGitDir(confined.relative)) {
    throw gitDirRefusal(tool, p, `it resolves to ${JSON.stringify(confined.relative)}, which is git's own data (.git)`);
  }
  return confined.absolute;
}

// ── fs.read ───────────────────────────────────────────────────────────────────

interface ReadInput { path: string; offset?: number; limit?: number; [k: string]: unknown }

export class FsReadTool extends BaseTool<ReadInput> {
  readonly id: ToolId = makeToolId('fs.read');
  readonly name = 'fs.read';
  readonly description = 'Read a file from disk. Returns its text content.';
  readonly permissionLevel = 'read' as const;

  declaredPaths(input: ReadInput): string[] { return onePath(input); }

  async execute(input: ReadInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const abs = await confinedPath(ctx, input.path);
    const content = await fs.readFile(abs, 'utf8');
    const lines = content.split('\n');
    const slice = lines.slice(input.offset ?? 0, input.limit ? (input.offset ?? 0) + input.limit : undefined);
    return this.ok(slice.join('\n'), performance.now() - t, { lines: lines.length });
  }
}

// ── fs.write ──────────────────────────────────────────────────────────────────

interface WriteInput { path: string; content: string; createDirs?: boolean; [k: string]: unknown }

export class FsWriteTool extends BaseTool<WriteInput> {
  readonly id: ToolId = makeToolId('fs.write');
  readonly name = 'fs.write';
  readonly description = 'Write text content to a file, overwriting if it exists.';
  readonly permissionLevel = 'write' as const;

  declaredPaths(input: WriteInput): string[] {
    const paths = onePath(input);
    refuseGitDirPaths(this.name, paths);
    return paths;
  }

  async execute(input: WriteInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const abs = await writablePath(ctx, this.name, input.path);
    if (input.createDirs) await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, 'utf8');
    return this.ok(`Wrote ${input.content.length} bytes to ${input.path}`, performance.now() - t);
  }
}

// ── fs.delete ─────────────────────────────────────────────────────────────────

interface DeleteInput { path: string; recursive?: boolean; [k: string]: unknown }

export class FsDeleteTool extends BaseTool<DeleteInput> {
  readonly id: ToolId = makeToolId('fs.delete');
  readonly name = 'fs.delete';
  readonly description = 'Delete a file or directory.';
  readonly permissionLevel = 'dangerous' as const;

  declaredPaths(input: DeleteInput): string[] {
    const paths = onePath(input);
    refuseGitDirPaths(this.name, paths);
    return paths;
  }

  async execute(input: DeleteInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const abs = await writablePath(ctx, this.name, input.path);
    await fs.rm(abs, { recursive: input.recursive ?? false });
    return this.ok(`Deleted ${input.path}`, performance.now() - t);
  }
}

// ── fs.stat ───────────────────────────────────────────────────────────────────

interface StatInput { path: string; [k: string]: unknown }

export class FsStatTool extends BaseTool<StatInput> {
  readonly id: ToolId = makeToolId('fs.stat');
  readonly name = 'fs.stat';
  readonly description = 'Stat a file or directory — returns size, type, mtime.';
  readonly permissionLevel = 'read' as const;

  declaredPaths(input: StatInput): string[] { return onePath(input); }

  async execute(input: StatInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const abs = await confinedPath(ctx, input.path);
    const st = await fs.stat(abs);
    return this.ok(JSON.stringify({
      isFile: st.isFile(), isDirectory: st.isDirectory(),
      size: st.size, mtime: st.mtime.toISOString(),
    }), performance.now() - t);
  }
}

// ── fs.list ───────────────────────────────────────────────────────────────────

interface ListInput { path: string; recursive?: boolean; [k: string]: unknown }

export class FsListTool extends BaseTool<ListInput> {
  readonly id: ToolId = makeToolId('fs.list');
  readonly name = 'fs.list';
  readonly description = 'List files in a directory.';
  readonly permissionLevel = 'read' as const;

  declaredPaths(input: ListInput): string[] { return onePath(input); }

  async execute(input: ListInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const abs = await confinedPath(ctx, input.path);
    const entries = await fs.readdir(abs, { withFileTypes: true, recursive: input.recursive });
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return this.ok(names.join('\n'), performance.now() - t, { count: names.length });
  }
}
