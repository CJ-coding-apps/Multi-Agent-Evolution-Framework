import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
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
  // The child writes what it observed, and this test asserts on that file rather than on the inner
  // runner's status (WP-3.9 G14). Two reasons, both measured by the verifier: an inherited
  // `NODE_TEST_CONTEXT` puts the inner `--test` in child mode, where a failing assertion still
  // exits 0 — so a tool that passes the parent environment through kept this test green. The
  // `NODE_TEST_*` variables are therefore removed for the duration (a pass-through mutant cannot
  // inherit them), and the observation is recorded before the in-child assertions so the outer
  // assertion holds even if a runner reports a failure the way this one used to.
  await writeFile(path.join(root, 'env.test.js'), [
    "const test = require('node:test');",
    "const assert = require('node:assert');",
    "const { writeFileSync } = require('node:fs');",
    "test('no MAF variable', () => {",
    "  writeFileSync('env.json', JSON.stringify({",
    "    key: process.env.MAF_SIGNING_KEY ?? null,",
    "    state: process.env.MAF_RUNTIME_STATE ?? null,",
    "    path: process.env.PATH ?? null,",
    "  }));",
    "  assert.equal(process.env.MAF_SIGNING_KEY, undefined);",
    "  assert.equal(process.env.MAF_RUNTIME_STATE, undefined);",
    "  assert.ok(process.env.PATH, 'PATH is the one thing a runner needs');",
    "});",
    '',
  ].join('\n'));
  const saved = { sign: process.env['MAF_SIGNING_KEY'], state: process.env['MAF_RUNTIME_STATE'] };
  const savedTestVars = Object.entries(process.env).filter(([k]) => k.startsWith('NODE_TEST_'));
  for (const [key] of savedTestVars) delete process.env[key];
  process.env['MAF_SIGNING_KEY'] = 'test-key-must-not-reach-the-runner';
  process.env['MAF_RUNTIME_STATE'] = '/tmp/state-must-not-reach-the-runner';
  t.after(() => {
    if (saved.sign === undefined) delete process.env['MAF_SIGNING_KEY'];
    else process.env['MAF_SIGNING_KEY'] = saved.sign;
    if (saved.state === undefined) delete process.env['MAF_RUNTIME_STATE'];
    else process.env['MAF_RUNTIME_STATE'] = saved.state;
    for (const [key, value] of savedTestVars) if (value !== undefined) process.env[key] = value;
  });

  const result = await new TestRunnerTool().execute({ runner: 'node' }, ctxIn(root));
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const observed = JSON.parse(await readFile(path.join(root, 'env.json'), 'utf8')) as {
    key: string | null; state: string | null; path: string | null;
  };
  assert.equal(observed.key, null, 'MAF_SIGNING_KEY did not reach the runner');
  assert.equal(observed.state, null, 'MAF_RUNTIME_STATE did not reach the runner');
  assert.notEqual(observed.path, null, 'PATH did reach it');
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
  assert.deepEqual(buildTestCommand('jest', { filter: 'name' }),
    ['npx', '--no-install', 'jest', '--forceExit', '--testPathPattern', 'name']);
  assert.deepEqual(buildTestCommand('pytest', { filter: 'name' }), ['python', '-m', 'pytest', '-k', 'name']);
  // Vitest is positional, but cac cuts argv at `--` and files the rest under `options['--']`, so a
  // `--` here would run the whole suite with the filter silently dropped (WP-3.9 F12). `--no-install`
  // keeps `npx` from fetching a runner the project does not have (WP-3.9 F15).
  assert.deepEqual(buildTestCommand('vitest', { filter: 'name' }),
    ['npx', '--no-install', 'vitest', 'run', '--reporter=verbose', 'name']);
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

/** A runner that starts a grandchild which never exits, records its pid, then hangs itself. */
const HANGING_RUNNER = [
  "const test = require('node:test');",
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  "test('hangs with a child', async () => {",
  "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  "  writeFileSync('grandchild.pid', String(child.pid));",
  "  await new Promise(() => {});",
  "});",
  '',
].join('\n');

/**
 * An `npm test` script that passes and leaves a helper holding the inherited stdout (WP-3.9 G16b).
 *
 * `npm test`, not `node --test`: node's own runner waits for its file child's stdio, so the hang
 * happens one level above MAF and no tool-side fix could answer it. npm exits when the script does,
 * whatever the script left behind — which is the shape a user hits (vitest with a worker, a test
 * that starts a server and does not stop it).
 */
const INHERITING_SUITE = [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  // `inherit`, not `ignore`: the helper keeps the runner's stdout — the pipe MAF reads — open, so
  // `close` (child gone AND stdio closed) never fires even though `npm test` has exited 0.
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
  "child.unref();",
  "writeFileSync('grandchild.pid', String(child.pid));",
  "console.log('suite passed');",
  '',
].join('\n');

/** A runner that passes, and leaves the same kind of grandchild behind while it exits 0. */
const LEAKING_RUNNER = [
  "const test = require('node:test');",
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  "test('passes and leaves a child running', () => {",
  "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  // `unref` is what lets the runner exit 0 with the child still alive: without it the open
  // ChildProcess handle keeps the runner's event loop alive and the fixture times out instead.
  "  child.unref();",
  "  writeFileSync('grandchild.pid', String(child.pid));",
  "});",
  '',
].join('\n');

/** The pid a fixture recorded, waiting until it is on disk. */
async function waitForPid(file: string): Promise<number> {
  let pid: number | undefined;
  for (let i = 0; i < 40 && pid === undefined; i++) {
    pid = await readFile(file, 'utf8').then((s) => Number(s.trim()) || undefined, () => undefined);
    if (pid === undefined) await new Promise((r) => setTimeout(r, 50));
  }
  if (pid === undefined || !Number.isInteger(pid)) assert.fail('the grandchild recorded its pid');
  return pid;
}

/** Wait for the kernel to retire `pid`; SIGKILL is delivered with the group, so allow a moment. */
async function waitForDeath(pid: number, when: string): Promise<void> {
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); }
    catch { alive = false; }
  }
  assert.equal(alive, false, `grandchild ${String(pid)} survived ${when}`);
}

/**
 * A real MAF-shaped parent that starts a live `test.run` and then ends itself the way `tail` says.
 * The runner group belongs to the parent's child, not to the parent, so nothing but the parent's own
 * exit hooks can reach it — which is what these tests are about.
 */
async function parentRunningATest(t: TestContext, root: string, tail: readonly string[]): Promise<ChildProcess> {
  await writeFile(path.join(root, 'parent.js'), [
    "const { TestRunnerTool } = require(process.env.MAF_TOOLS_ENTRY);",
    'const root = process.env.MAF_FIXTURE_ROOT;',
    'const ctx = {',
    '  cwd: root, projectRoot: root, runId: "r1", taskId: "t1", agentId: "a1", sessionId: "s1",',
    '  policy: { async evaluate() { return { verdict: "Allow" }; } },',
    '  attestor: { async record() {} },',
    '};',
    'new TestRunnerTool().execute({ runner: "node", timeout: 60000 }, ctx).then(',
    '  () => { process.stdout.write("runner finished\\n"); });',
    ...tail,
    '',
  ].join('\n'));

  const parent = spawn(process.execPath, [path.join(root, 'parent.js')], {
    cwd: root,
    env: {
      ...process.env,
      MAF_TOOLS_ENTRY: path.resolve(__dirname, '..', 'index.js'),
      MAF_FIXTURE_ROOT: root,
    },
    stdio: 'ignore',
  });
  t.after(() => parent.kill('SIGKILL'));
  return parent;
}

/** The parent's own end, as the OS reported it to this process. */
function whenExited(parent: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => { parent.on('exit', (code, signal) => resolve({ code, signal })); });
}

test('a timeout kills the runner\'s own children, not only the runner', async (t) => {
  if (process.platform === 'win32') return; // no process groups; the POSIX path is under test
  const root = await project(t);
  // Signalling only the runner leaves the grandchild alive — which is what the old code did.
  await writeFile(path.join(root, 'hang.test.js'), HANGING_RUNNER);

  const result = await new TestRunnerTool().execute({ runner: 'node', timeout: 2000 }, ctxIn(root));
  assert.equal(result.exitCode, 124, result.stdout + result.stderr);

  await waitForDeath(await waitForPid(path.join(root, 'grandchild.pid')), 'the timeout');
});

// WP-3.9 F9: the timeout was the only exit that killed the group. A runner that exits 0 leaves just
// as much behind — a vitest worker, a server a test started, a watcher — and the old code answered
// `close` without touching the group, so the leftovers outlived the tool call and the run.
test('a runner that exits 0 has its leftover children killed too (WP-3.9 F9)', async (t) => {
  if (process.platform === 'win32') return;
  const root = await project(t);
  await writeFile(path.join(root, 'leak.test.js'), LEAKING_RUNNER);

  const result = await new TestRunnerTool().execute({ runner: 'node' }, ctxIn(root));
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);

  await waitForDeath(await waitForPid(path.join(root, 'grandchild.pid')), 'a normal exit');
});

// WP-3.9 G16b: a passing suite used to be reported as a timeout. `close` fires only when the child
// has exited *and* its stdio is closed, and a helper that inherited stdout keeps the second half
// from ever happening — measured on this fixture before the fix: `npm test` reported EXIT 0 and no
// CLOSE arrived in 4 s, so the call answered 124 with a `[TIMEOUT]` line for a suite that had
// finished. The fix answers on `exit`, kills the group there (which is what closes the pipe) and
// reports the runner's own status.
test('a passing suite is not reported as a timeout when a helper holds its stdout (WP-3.9 G16b)', async (t) => {
  if (process.platform === 'win32') return; // the group kill is the mechanism under test
  const root = await project(t);
  await writeFile(path.join(root, 'package.json'),
    JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node leave.js' } }));
  await writeFile(path.join(root, 'leave.js'), INHERITING_SUITE);

  const result = await new TestRunnerTool().execute({ runner: 'npm', timeout: 8000 }, ctxIn(root));
  assert.equal(result.exitCode, 0, `a passing suite answered ${String(result.exitCode)}:\n${result.stdout}${result.stderr}`);
  assert.doesNotMatch(result.stderr, /\[TIMEOUT after/);

  await waitForDeath(await waitForPid(path.join(root, 'grandchild.pid')), 'the normal exit');
});

/**
 * A suite whose helper leaves the runner's process group *and* keeps the inherited stdout (WP-3.9
 * H6). `detached: true` puts the helper in its own group, so the group kill on `exit` cannot reach
 * it; `stdio: 'inherit'` means it holds the write end of MAF's pipe, so `close` — child gone AND
 * stdio closed — never fires. The grace timer is then the only path that can answer the call.
 */
const ESCAPING_SUITE = [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
  "  { stdio: 'inherit', detached: true });",
  "child.unref();",
  "writeFileSync('escaped.pid', String(child.pid));",
  "console.log('suite passed');",
  '',
].join('\n');

// WP-3.9 H6: the 100 ms grace, tested as the path that answers rather than as an exit code that
// happens to be right. In the G16b fixture above the group kill closes the pipe, so `close` can
// answer first and the grace is never exercised; a helper that left the group leaves the pipe
// open, so no `close` ever arrives and only the grace can answer. What is asserted is the
// ordering, not a duration: the call returns with the runner's own status while the helper is
// still alive and still holding the pipe. Without the grace the same call cannot answer until the
// timeout — which is why the timeout is generous: it is the failure mode, not the expected wait.
test('the grace answers the call while a helper that left the group still holds stdout (WP-3.9 H6)', async (t) => {
  if (process.platform === 'win32') return; // no process groups; the grace is not the mechanism
  const root = await project(t);
  await writeFile(path.join(root, 'package.json'),
    JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node escape.js' } }));
  await writeFile(path.join(root, 'escape.js'), ESCAPING_SUITE);

  const result = await new TestRunnerTool().execute({ runner: 'npm', timeout: 10_000 }, ctxIn(root));

  const pid = await waitForPid(path.join(root, 'escaped.pid'));
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } });

  // The helper was alive when the call answered, so no `close` can have produced this result.
  assert.doesNotThrow(() => process.kill(pid, 0), 'the escaping helper is still alive when the call returns');
  assert.equal(result.exitCode, 0, `a passing suite answered ${String(result.exitCode)}:\n${result.stdout}${result.stderr}`);
  assert.doesNotMatch(result.stderr, /\[TIMEOUT after/);

  // Clean up the group the group kill could not reach, and prove it went.
  process.kill(-pid, 'SIGKILL');
  await waitForDeath(pid, 'the test cleanup');
});

// WP-3.9 F9: the other exit MAF does not choose. A tool call is synchronous from the operator's point
// of view — Ctrl-C at the terminal ends MAF, and the runner it started used to keep running with no
// parent to answer to. The parent fixture is a real process, because only a process can receive the
// signal and run the hooks; the grandchild is in the runner's group, not the parent's, so only the
// forwarded kill can reach it.
test('SIGINT to MAF reaches the runner it started (WP-3.9 F9)', async (t) => {
  if (process.platform === 'win32') return;
  const root = await project(t);
  await writeFile(path.join(root, 'hang.test.js'), HANGING_RUNNER);
  const parent = await parentRunningATest(t, root, []);
  const exited = whenExited(parent);

  const pid = await waitForPid(path.join(root, 'grandchild.pid'));
  parent.kill('SIGINT');
  // The hook re-raises the signal rather than swallowing it, so MAF dies with the status it would
  // have had without the hook — a supervisor sees an interrupt, not a clean exit.
  assert.equal((await exited).signal, 'SIGINT');

  await waitForDeath(pid, 'the forwarded interrupt');
});

// WP-3.9 G10: the second signal a supervisor sends. It had a hook but no test, and a hook without
// a test is a sentence about the code rather than a fact about the process — the same gap that let
// the normal-exit hook below run with an empty body.
test('SIGTERM to MAF reaches the runner it started (WP-3.9 G10)', async (t) => {
  if (process.platform === 'win32') return;
  const root = await project(t);
  await writeFile(path.join(root, 'hang.test.js'), HANGING_RUNNER);
  const parent = await parentRunningATest(t, root, []);
  const exited = whenExited(parent);

  const pid = await waitForPid(path.join(root, 'grandchild.pid'));
  parent.kill('SIGTERM');
  assert.equal((await exited).signal, 'SIGTERM');

  await waitForDeath(pid, 'the forwarded termination');
});

// WP-3.9 G10: the exit MAF chooses — a run that finishes, a CLI that returns, a `process.exit` in
// any caller. The hook is the only thing that runs then: the event loop is stopped, the tool call
// never resolves, and the runner's group has no other parent. An empty listener in its place leaves
// a live `node --test` (and whatever it started) with nothing tracking it.
test('MAF exiting normally kills the runner it started (WP-3.9 G10)', async (t) => {
  if (process.platform === 'win32') return;
  const root = await project(t);
  await writeFile(path.join(root, 'hang.test.js'), HANGING_RUNNER);
  const parent = await parentRunningATest(t, root, [
    // Ends its own process once the runner's grandchild is on disk, so the exit hook runs with a
    // group still in flight — the only state this test is about.
    'const tick = setInterval(() => {',
    '  if (require("node:fs").existsSync(root + "/grandchild.pid")) { clearInterval(tick); process.exit(0); }',
    '}, 20);',
  ]);
  const exited = whenExited(parent);

  const pid = await waitForPid(path.join(root, 'grandchild.pid'));
  // A clean status is the point: the operator's process ended the way it meant to, and the runner it
  // left behind still has to be reaped.
  assert.deepEqual(await exited, { code: 0, signal: null });

  await waitForDeath(pid, "MAF's normal exit");
});
