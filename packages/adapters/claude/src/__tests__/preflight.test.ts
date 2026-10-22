import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from '../index.js';

// ORACLE (WP-3.9 F5): every governed turn and both isolated cli-tier sets pass `--tools`. A
// `claude` that does not know the flag exits 1 on every node, and the run reported a plan full of
// identical failures instead of one sentence about the CLI. `preflight()` asks the resolved binary.
//
// The binary is real, on PATH: this is the resolution and the two probes a run performs, not a stub
// of them. The stand-in records the flags it was asked so the test can see both questions.

/**
 * A shell-script `claude` in a temp bin dir, answering `--version` and `--help` as given, and
 * recording both what it was asked and the environment it was given.
 */
async function standIn(
  t: TestContext,
  opts: { version: string; help: readonly string[] },
): Promise<{ binary: string; askedLog: string; envLog: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-claude-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  await mkdir(binDir);
  const askedLog = path.join(root, 'asked.txt');
  const envLog = path.join(root, 'env.jsonl');
  const binary = path.join(binDir, 'claude');
  // Single-quoted shell strings: none of the fixtures contains one.
  const quoted = (line: string): string => `'${line}'`;
  // The flag is passed to node with a leading `x`: an argument beginning `--` would be read by
  // node itself rather than handed to the script.
  const recordEnv =
    'const fs=require("node:fs");' +
    `fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({` +
    'flag: String(process.argv[1] ?? "").slice(1),' +
    'maf: Object.keys(process.env).filter((k) => /^MAF_/.test(k)),' +
    'path: process.env.PATH !== undefined }) + "\\n");';
  await writeFile(binary, [
    '#!/bin/sh',
    `printf '%s\\n' "$1" >> ${quoted(askedLog)}`,
    `${quoted(process.execPath)} -e ${quoted(recordEnv)} "x$1" >/dev/null`,
    'case "$1" in',
    `  --version) printf '%s\\n' ${quoted(opts.version)} ;;`,
    `  --help) printf '%s\\n' ${opts.help.map(quoted).join(' ')} ;;`,
    'esac',
    '',
  ].join('\n'));
  await chmod(binary, 0o755);
  return { binary, askedLog, envLog };
}

/** Only `dir` on PATH, restored afterwards, so the host's own `claude` can never answer. */
function withOnlyPath(t: TestContext, dir: string): void {
  const saved = process.env['PATH'];
  process.env['PATH'] = dir;
  t.after(() => { process.env['PATH'] = saved; });
}

test('preflight resolves `claude` on PATH and accepts a binary whose --help lists --tools', async (t) => {
  if (process.platform === 'win32') return; // shell-script fixture
  const { binary, askedLog } = await standIn(t, {
    version: '9.9.9 (Claude Code)',
    help: ['Usage: claude [options]', '  --tools <tools>  Specify the list of available tools'],
  });
  withOnlyPath(t, path.dirname(binary));

  const checked = await new ClaudeAdapter().preflight();

  assert.equal(checked.path, binary, 'the path is the binary PATH resolved, not the bare name');
  assert.equal(checked.version, '9.9.9 (Claude Code)', 'the version --version reported');
  assert.deepEqual((await readFile(askedLog, 'utf8')).trim().split('\n'), ['--version', '--help'],
    'both questions were put to the resolved binary');
});

test('preflight puts both probes to `claude` with the backend env, no MAF_* in it', async (t) => {
  if (process.platform === 'win32') return; // shell-script fixture
  const { binary, envLog } = await standIn(t, {
    version: '9.9.9 (Claude Code)',
    help: ['Usage: claude [options]', '  --tools <tools>  Specify the list of available tools'],
  });
  withOnlyPath(t, path.dirname(binary));
  const savedKey = process.env['MAF_SIGNING_KEY'];
  const savedState = process.env['MAF_RUNTIME_STATE'];
  process.env['MAF_SIGNING_KEY'] = 'test-signing-key';
  process.env['MAF_RUNTIME_STATE'] = '/tmp/maf-state-must-not-reach-the-backend';
  t.after(() => {
    if (savedKey === undefined) delete process.env['MAF_SIGNING_KEY'];
    else process.env['MAF_SIGNING_KEY'] = savedKey;
    if (savedState === undefined) delete process.env['MAF_RUNTIME_STATE'];
    else process.env['MAF_RUNTIME_STATE'] = savedState;
  });

  await new ClaudeAdapter().preflight();

  const rows = (await readFile(envLog, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { flag: string; maf: string[]; path: boolean });
  assert.deepEqual(rows.map((row) => row.flag), ['--version', '--help'],
    'both probes were put to the binary, in that order');
  for (const row of rows) {
    assert.deepEqual(row.maf, [], `the ${row.flag} probe is given no MAF_* variable`);
    assert.equal(row.path, true, `the ${row.flag} probe still gets PATH (the filter is not "no environment")`);
  }
});

test('preflight refuses a binary whose --help has no --tools, naming the path and the version', async (t) => {
  if (process.platform === 'win32') return; // shell-script fixture
  const { binary } = await standIn(t, {
    version: '0.1.0',
    help: ['Usage: claude [options]', '  --print  Print response and exit'],
  });
  withOnlyPath(t, path.dirname(binary));

  await assert.rejects(new ClaudeAdapter().preflight(), (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /does not support --tools/, 'the failure says what is wrong');
    assert.ok(message.includes(binary), `the failure names the resolved binary: ${message}`);
    assert.match(message, /version 0\.1\.0/, 'and the version it found');
    return true;
  });
});

test('preflight with no `claude` on PATH says so, rather than spawning a bare name', async (t) => {
  const empty = await mkdtemp(path.join(tmpdir(), 'maf-claude-absent-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  withOnlyPath(t, empty);

  await assert.rejects(new ClaudeAdapter().preflight(), (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /no executable named "claude" was found on PATH/);
    return true;
  });
});
