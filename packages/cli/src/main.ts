#!/usr/bin/env node --max-old-space-size=8192
import { Command } from 'commander';
import { createAdapterRegistry } from './AdapterRegistry.js';
import { registerRunCommand } from './commands/run.js';

const program = new Command();

program
  .name('maf')
  .description('Multi-Agent Framework — CLI-agnostic orchestration with LCM memory')
  .version('0.1.0');

registerRunCommand(program);

// ── adapters list ─────────────────────────────────────────────────────────────
program
  .command('adapters')
  .description('List available CLI adapters and their availability status')
  .action(async () => {
    const registry = createAdapterRegistry();
    for (const [name, adapter] of registry) {
      const available = await adapter.isAvailable().catch(() => false);
      const caps = adapter.capabilities();
      const status = available ? '✓' : '✗';
      console.log(`${status} ${name.padEnd(12)} streaming=${caps.supportsStreaming} tools=${caps.supportsToolCalling} concurrent=${caps.maxConcurrentTasks}`);
    }
  });

// ── merge-runs ────────────────────────────────────────────────────────────────
program
  .command('merge-runs <runId1> <runId2> [targetRunId]')
  .description('Merge two run memory graphs into a new combined run')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .action(async (runId1: string, runId2: string, targetRunId: string | undefined, opts: { dir: string }) => {
    const path = await import('node:path');
    const crypto = await import('node:crypto');
    const { MemoryGraph } = await import('@maf/memory-graph');
    const { LcmEngine } = await import('@maf/lcm');
    const { makeRunId } = await import('@maf/types');

    const mafDir = path.join(path.resolve(opts.dir), '.maf');
    const target = makeRunId(targetRunId ?? crypto.randomUUID());
    const graph  = new MemoryGraph(path.join(mafDir, 'memory.kuzu'));
    const lcm    = new LcmEngine({
      dbPath: path.join(mafDir, 'lcm.db'),
      contextThreshold: 0.75, freshTailCount: 64, mode: 'Upward',
      summarize: async (msgs) => msgs.map((m) => m.content.slice(0, 200)).join('\n'),
    });

    const report = await graph.mergeRuns([makeRunId(runId1), makeRunId(runId2)], target);
    await lcm.mergeRuns([makeRunId(runId1), makeRunId(runId2)], target);

    console.log(`Merged into run ${target}`);
    console.log(`Nodes created: ${report.nodesCreated}, Edges: ${report.edgesCreated}`);
    if (report.conflictsFound.length > 0) {
      console.log(`Conflicts (skipped): ${report.conflictsFound.join(', ')}`);
    }

    graph.close();
    lcm.close();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('[maf] error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
