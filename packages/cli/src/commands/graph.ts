import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  MemoryGraph, parseGraphExport, kuzuVersion,
  GRAPH_EXPORT_FORMAT_VERSION,
} from '@maf/memory-graph';

export interface GraphExportOutcome {
  /** One fact per line, as the command prints them. */
  lines: string[];
  file:  string;
  nodes: number;
  edges: number;
}

export interface GraphImportOutcome {
  lines: string[];
  nodes: number;
  edges: number;
}

/** `maf graph export`, minus the process: reads the graph, writes the JSON, closes the graph. */
export async function runGraphExport(dbPath: string, outFile: string): Promise<GraphExportOutcome> {
  // Opening a graph that is not there creates an empty one, and exporting that writes a file
  // that reads like a successful rescue of nothing. Refuse before anything is opened, so a
  // mistyped path leaves the directory exactly as it was.
  try {
    await stat(dbPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`no graph at ${dbPath}`);
    throw err;
  }
  const graph = new MemoryGraph(dbPath);
  try {
    const version = kuzuVersion();
    // `graph.exportGraph`, not the free `exportGraph`: the whole export is one admitted operation,
    // so a concurrent close cannot refuse it halfway (R2-1).
    const exported = await graph.exportGraph(version);
    // The file can hold task titles, file paths and failure messages; it is the user's to keep,
    // and nobody else's to read by default.
    await writeFile(outFile, `${JSON.stringify(exported, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return {
      lines: [
        `Exported ${exported.nodes.length} nodes and ${exported.edges.length} edges to ${outFile}` +
        ` (Kùzu ${version}, graph format ${GRAPH_EXPORT_FORMAT_VERSION}).`,
      ],
      file: outFile,
      nodes: exported.nodes.length,
      edges: exported.edges.length,
    };
  } finally {
    await graph.close();
  }
}

/** `maf graph import`, minus the process: reads and validates the file, writes a fresh graph. */
export async function runGraphImport(file: string, dbPath: string): Promise<GraphImportOutcome> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read the graph export at ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const exported = parseGraphExport(text, file);

  const graph = new MemoryGraph(dbPath);
  try {
    const report = await graph.importGraph(exported);
    return {
      lines: [
        `Imported ${report.nodesCreated} nodes and ${report.edgesCreated} edges from ${file} into ${dbPath}` +
        ` (exported by Kùzu ${exported.kuzuVersion}, graph format ${exported.formatVersion}).`,
      ],
      nodes: report.nodesCreated,
      edges: report.edgesCreated,
    };
  } finally {
    await graph.close();
  }
}

export function registerGraphCommand(program: Command): void {
  const graph = program
    .command('graph')
    .description('Export and import the run memory graph as version-neutral JSON');

  graph
    .command('export')
    .description('Write every node and edge of the memory graph to a JSON file (run this before upgrading Kùzu)')
    .option('-d, --dir <path>', 'Project directory; reads <dir>/.maf/memory.kuzu', '.')
    .option('--db <path>', 'Graph database path (default: <dir>/.maf/memory.kuzu)')
    .option('-o, --out <file>', 'Export file (default: <dir>/graph-export.json)')
    .action(async (opts: { dir: string; db?: string; out?: string }) => {
      const dir = path.resolve(opts.dir);
      const dbPath = path.resolve(opts.db ?? path.join(dir, '.maf', 'memory.kuzu'));
      const outFile = path.resolve(opts.out ?? path.join(dir, 'graph-export.json'));
      const outcome = await runGraphExport(dbPath, outFile);
      for (const line of outcome.lines) console.log(line);
    });

  graph
    .command('import <file>')
    .description('Restore an export into a fresh memory graph')
    .option('-d, --dir <path>', 'Project directory; writes <dir>/.maf/memory.kuzu', '.')
    .option('--db <path>', 'Graph database path (default: <dir>/.maf/memory.kuzu)')
    .action(async (file: string, opts: { dir: string; db?: string }) => {
      const dir = path.resolve(opts.dir);
      const dbPath = path.resolve(opts.db ?? path.join(dir, '.maf', 'memory.kuzu'));
      const outcome = await runGraphImport(path.resolve(file), dbPath);
      for (const line of outcome.lines) console.log(line);
    });
}
