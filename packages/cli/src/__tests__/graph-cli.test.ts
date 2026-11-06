import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { makeRunId } from '@maf/types';
import { MemoryGraph } from '@maf/memory-graph';

// ORACLE (WP-3.8, D-58). The rescue is a command a user runs *because* their graph no longer opens,
// so what matters is the process: the exit code, and the sentence on the failing stream. The
// in-process tests pin the guard's message; these pin that `maf graph export` reaches it and stops
// non-zero, and that the import/export pair actually moves the committed 0.7.1 graph.

const execFileAsync = promisify(execFile);
const MAIN = path.resolve(__dirname, '..', 'main.js');
const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'memory-graph', 'src', '__tests__', 'fixtures');
const KUZU_071_EXPORT = path.join(FIXTURES, 'kuzu-0.7.1-export.json');
const KUZU_071_TARBALL = path.join(FIXTURES, 'kuzu-0.7.1.tar.gz');

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [MAIN, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; signal?: string; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test('graph export on a Kùzu 0.7.1 directory exits non-zero and gives the one command that keeps it', async () => {
  const dir = await tempDir('maf-graph-cli-old-');
  try {
    await execFileAsync('tar', ['-xzf', KUZU_071_TARBALL, '-C', dir]);
    const old = path.join(dir, 'memory.kuzu');
    const out = path.join(dir, 'export.json');
    const result = await runCli(['graph', 'export', '--db', old, '--out', out]);

    assert.notEqual(result.code, 0, 'a graph it cannot read is a failure, not an empty export');
    assert.match(result.stderr, /Kùzu 0\.7\.x/);
    assert.ok(result.stderr.includes(`mv ${old} ${old}.0.7-backup`), result.stderr);
    assert.match(result.stderr, /does not move or delete it for you/);
    // The route this replaced needed a `graph export` that no released maf has.
    assert.doesNotMatch(result.stderr, /maf graph export/);
    assert.doesNotMatch(result.stdout, /Exported/, 'nothing was written');
    await assert.rejects(() => stat(out), /ENOENT/);
    assert.ok((await stat(old)).isDirectory(), 'and the old graph is exactly where it was');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graph export on a path that holds no graph exits non-zero and creates nothing', async () => {
  const dir = await tempDir('maf-graph-cli-missing-');
  try {
    // A typo in --db used to open a fresh database at that path and "export" zero rows — a file
    // that reads like a successful rescue of nothing. The refusal comes before anything is opened.
    const db = path.join(dir, 'missing', 'memory.kuzu');
    const out = path.join(dir, 'export.json');
    const result = await runCli(['graph', 'export', '--db', db, '--out', out]);

    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes(`no graph at ${db}`), result.stderr);
    await assert.rejects(() => stat(out), /ENOENT/, 'no export file');
    await assert.rejects(() => stat(path.join(dir, 'missing')), /ENOENT/, 'not even the parent directory');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graph export refuses a row the importer would reject, and writes no file', async () => {
  const dir = await tempDir('maf-graph-cli-badrow-');
  try {
    const db = path.join(dir, 'memory.kuzu');
    const graph = new MemoryGraph(db);
    try {
      await graph.addNode({ kind: 'Task', label: 'no run', properties: {}, runId: makeRunId('') });
    } finally {
      await graph.close();
    }

    const out = path.join(dir, 'export.json');
    const result = await runCli(['graph', 'export', '--db', db, '--out', out]);

    assert.notEqual(result.code, 0, 'a file that cannot be imported is not an export');
    // The CLI prefixes the thrown message with `[maf] error: `; the sentence after it is the
    // exporter's own, and it is the half a reader acts on.
    assert.match(result.stderr, /^\[maf\] error: Cannot export node 0 \(MemoryNode ".+"\): runId is empty\./m);
    assert.doesNotMatch(result.stdout, /Exported/);
    await assert.rejects(() => stat(out), /ENOENT/, 'the partial file was never written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graph import then graph export moves the 0.7.1 export through the CLI and the counts agree', async () => {
  const dir = await tempDir('maf-graph-cli-move-');
  try {
    const db = path.join(dir, 'memory.kuzu');
    const out = path.join(dir, 'export.json');

    const imported = await runCli(['graph', 'import', KUZU_071_EXPORT, '--db', db]);
    assert.equal(imported.code, 0, imported.stderr);
    assert.equal(
      imported.stdout.trim(),
      `Imported 4 nodes and 3 edges from ${KUZU_071_EXPORT} into ${db} (exported by Kùzu 0.7.1, graph format 1).`,
    );

    const exported = await runCli(['graph', 'export', '--db', db, '--out', out]);
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout.trim(), /^Exported 4 nodes and 3 edges to .*export\.json \(Kùzu [^,]+, graph format 1\)\.$/);

    const written = JSON.parse(await readFile(out, 'utf8')) as {
      format: string; formatVersion: number; kuzuVersion: string; nodes: unknown[]; edges: unknown[];
    };
    assert.equal(written.format, 'maf-graph');
    assert.equal(written.formatVersion, 1);
    assert.notEqual(written.kuzuVersion, '0.7.1', 'the export is written by the Kùzu this maf runs');
    assert.equal(written.nodes.length, 4);
    assert.equal(written.edges.length, 3);

    // The written file is itself importable, which is what makes it a rescue artifact.
    const again = await runCli(['graph', 'import', out, '--db', path.join(dir, 'second.kuzu')]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /^Imported 4 nodes and 3 edges/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graph import into a graph that already holds rows exits non-zero and replaces nothing', async () => {
  const dir = await tempDir('maf-graph-cli-nonempty-');
  try {
    const db = path.join(dir, 'memory.kuzu');
    assert.equal((await runCli(['graph', 'import', KUZU_071_EXPORT, '--db', db])).code, 0);

    const second = await runCli(['graph', 'import', KUZU_071_EXPORT, '--db', db]);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /already holds 4 node/);
    assert.match(second.stderr, /--db/);
    assert.doesNotMatch(second.stdout, /Imported/);

    // The original rows are still the ones on disk.
    const exported = await runCli(['graph', 'export', '--db', db, '--out', path.join(dir, 'check.json')]);
    assert.match(exported.stdout, /^Exported 4 nodes and 3 edges/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
