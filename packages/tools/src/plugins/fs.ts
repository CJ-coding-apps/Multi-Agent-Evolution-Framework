import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ToolId, ToolContext, ToolResult } from '@maf/types';
import { BaseTool } from '../ToolPlugin.js';
import { makeToolId } from '@maf/types';

// ── fs.read ───────────────────────────────────────────────────────────────────

interface ReadInput { path: string; offset?: number; limit?: number; [k: string]: unknown }

export class FsReadTool extends BaseTool<ReadInput> {
  readonly id: ToolId = makeToolId('fs.read');
  readonly name = 'fs.read';
  readonly description = 'Read a file from disk. Returns its text content.';
  readonly permissionLevel = 'read' as const;

  async execute(input: ReadInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const abs = path.resolve(ctx.cwd, input.path);
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

  async execute(input: WriteInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const abs = path.resolve(ctx.cwd, input.path);
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

  async execute(input: DeleteInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const abs = path.resolve(ctx.cwd, input.path);
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

  async execute(input: StatInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const abs = path.resolve(ctx.cwd, input.path);
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

  async execute(input: ListInput, ctx: ToolContext): Promise<ToolResult> {
    const t = performance.now();
    const abs = path.resolve(ctx.cwd, input.path);
    const entries = await fs.readdir(abs, { withFileTypes: true, recursive: input.recursive });
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return this.ok(names.join('\n'), performance.now() - t, { count: names.length });
  }
}
