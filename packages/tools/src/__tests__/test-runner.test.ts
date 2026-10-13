import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext, PolicyDecision, PolicyEngineHandle, AttestorHandle } from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId } from '@maf/types';
import { TestRunnerTool } from '../index.js';

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
