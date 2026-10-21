import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, PolicyDecision, PolicyEngineHandle, AttestorHandle } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId } from '@maf/types';
import { TestRunnerTool } from '../index.js';
import { buildTestCommand, MAX_TEST_TIMEOUT_MS } from '../plugins/test-runner.js';

// ORACLE: a live v0.3.0 sweep. `test.run` spawns the runner without a `shell`, so a runner that is
// not installed fails the *spawn*. Node reports that with an `error` event, and an unhandled `error`
// on a ChildProcess is fatal to the whole process — a run whose tester asked for `bun` died with
// `Error: spawn bun ENOENT` and wrote no attestation at all. A missing binary is a tool that failed
// while running, which WP-2.18 already decided is an error *result*. The same sweep caught the
// second half: `node` and `pnpm` are advertised in the schema's enum but had no case, so both fell
// through to `npm test` — the `node:test` fixture asked for `node` and silently got npm.

const ALLOW: PolicyEngineHandle = { async evaluate(): Promise<PolicyDecision> { return { verdict: 'Allow' }; } };
const NO_ATTESTOR: AttestorHandle = { async record(): Promise<void> {} };

const ctxIn = (root: string): ToolContext => ({
  cwd: root, projectRoot: root, runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
  sessionId: 's1', policy: ALLOW, attestor: NO_ATTESTOR,
});

async function project(t: TestContext): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), 'maf-test-runner-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a runner that is not installed resolves a failed result instead of killing the process', async (t) => {
  const root = await project(t);
  // Emptied PATH makes the spawn fail deterministically on every machine, rather than depending on
  // whether this particular host happens to have `bun` — which is what made the original defect
  // invisible: `bun` was absent on the machine that ran the sweep and present on none of the tests.
  const savedPath = process.env['PATH'];
  process.env['PATH'] = '';
  t.after(() => { process.env['PATH'] = savedPath; });

  const result = await new TestRunnerTool().execute({ runner: 'bun' }, ctxIn(root));

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /^test\.run failed: .*\bbun\b/);
});

test('runner "node" runs node:test rather than falling through to npm', async (t) => {
  const root = await project(t);
  await writeFile(path.join(root, 'x.test.js'), "require('node:test')('x', () => {});\n");
  // No package.json, so `npm test` cannot succeed here: exiting 0 proves `node --test` ran.
  const result = await new TestRunnerTool().execute({ runner: 'node' }, ctxIn(root));
  assert.equal(result.exitCode, 0, result.stderr);
});

test('runner "pnpm" runs pnpm rather than falling through to npm', async (t) => {
  const root = await project(t);
  await writeFile(path.join(root, 'probe.js'), 'console.log("execpath=" + process.env.npm_execpath);\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node probe.js' } }));
  const result = await new TestRunnerTool().execute({ runner: 'pnpm' }, ctxIn(root));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /pnpm/i);
  assert.doesNotMatch(result.stdout, /npm-cli\.js/);
});

// ─── WP-3.9: the allowlist, the argv shape, the ceiling, the process group ──

test('a runner cannot read MAF_SIGNING_KEY: the child gets the tool allowlist only', async (t) => {
  const root = await project(t);
  // Assert inside the child, so the test fails if the variable reaches it however the runner
  // reports the outcome. `node --test` exits non-zero when its only test fails.
  await writeFile(path.join(root, 'env.test.js'), [
    "const test = require('node:test');",
    "const assert = require('node:assert');",
    "test('no MAF variable', () => {",
    "  assert.equal(process.env.MAF_SIGNING_KEY, undefined);",
    "  assert.equal(process.env.MAF_RUNTIME_STATE, undefined);",
    "  assert.ok(process.env.PATH, 'PATH is the one thing a runner needs');",
    "});",
    '',
  ].join('\n'));
  const saved = { sign: process.env['MAF_SIGNING_KEY'], state: process.env['MAF_RUNTIME_STATE'] };
  process.env['MAF_SIGNING_KEY'] = 'test-key-must-not-reach-the-runner';
  process.env['MAF_RUNTIME_STATE'] = '/tmp/state-must-not-reach-the-runner';
  t.after(() => {
    if (saved.sign === undefined) delete process.env['MAF_SIGNING_KEY'];
    else process.env['MAF_SIGNING_KEY'] = saved.sign;
    if (saved.state === undefined) delete process.env['MAF_RUNTIME_STATE'];
    else process.env['MAF_RUNTIME_STATE'] = saved.state;
  });

  const result = await new TestRunnerTool().execute({ runner: 'node' }, ctxIn(root));
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('a filter that begins with "-" is refused rather than passed as an option', async (t) => {
  const root = await project(t);
  const result = await new TestRunnerTool().execute({ runner: 'node', filter: '--update-snapshots' }, ctxIn(root));
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /filter must not begin with "-"/);
});

test('an unknown runner is refused by name, not silently replaced by npm', async (t) => {
  const root = await project(t);
  // The schema's enum refuses this too; the point here is that the argv builder has no fall-through.
  const result = await new TestRunnerTool()
    .execute({ runner: 'shell' as never }, ctxIn(root));
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /shell/);
});

test('a positional filter follows "--" so it cannot be read as an option', () => {
  // `bun test -- -t/x` and `cargo test -- x` take the filter after `--`.
  assert.deepEqual(buildTestCommand('bun', { filter: 'name' }), ['bun', 'test', '--', 'name']);
  assert.deepEqual(buildTestCommand('cargo', { filter: 'name' }), ['cargo', 'test', '--', 'name']);
  // Where the filter is an option's value, `--` would change how the runner parses the rest.
  assert.deepEqual(buildTestCommand('jest', { filter: 'name' }), ['npx', 'jest', '--forceExit', '--testPathPattern', 'name']);
  assert.deepEqual(buildTestCommand('pytest', { filter: 'name' }), ['python', '-m', 'pytest', '-k', 'name']);
  assert.deepEqual(buildTestCommand('node', { filter: 'ignored' }), ['node', '--test']);
});

test('an oversized timeout is clamped to the ceiling, and the result says so', async (t) => {
  const root = await project(t);
  await writeFile(path.join(root, 'x.test.js'), "require('node:test')('x', () => {});\n");
  // The run finishes at once; what is under test is the value the ceiling produced, which every
  // result reports in `metadata.timeoutMs` — an unclamped value would be Number.MAX_SAFE_INTEGER.
  const result = await new TestRunnerTool().execute({ runner: 'node', timeout: Number.MAX_SAFE_INTEGER }, ctxIn(root));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.metadata, { runner: 'node', timeoutMs: MAX_TEST_TIMEOUT_MS });
});

test('a timeout kills the runner\'s own children, not only the runner', async (t) => {
  if (process.platform === 'win32') return; // no process groups; the POSIX path is under test
  const root = await project(t);
  // The runner starts a grandchild that never exits and records its pid, then hangs itself. Signalling
  // only the runner leaves the grandchild alive — which is what the old code did.
  await writeFile(path.join(root, 'hang.test.js'), [
    "const test = require('node:test');",
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "test('hangs with a child', async () => {",
    "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "  writeFileSync('grandchild.pid', String(child.pid));",
    "  await new Promise(() => {});",
    "});",
    '',
  ].join('\n'));

  const result = await new TestRunnerTool().execute({ runner: 'node', timeout: 2000 }, ctxIn(root));
  assert.equal(result.exitCode, 124, result.stdout + result.stderr);

  const pidFile = path.join(root, 'grandchild.pid');
  let pid: number | undefined;
  for (let i = 0; i < 40 && pid === undefined; i++) {
    pid = await readFile(pidFile, 'utf8').then((s) => Number(s.trim()) || undefined, () => undefined);
    if (pid === undefined) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(pid !== undefined && Number.isInteger(pid), 'the grandchild recorded its pid');

  // SIGKILL is delivered with the group; give the kernel a moment to retire the process.
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(pid!, 0); await new Promise((r) => setTimeout(r, 50)); }
    catch { alive = false; }
  }
  assert.equal(alive, false, `grandchild ${String(pid)} survived the timeout`);
});
