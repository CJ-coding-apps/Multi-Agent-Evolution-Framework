import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { Dag } from '@maf/types';
import { DagRunner } from '@maf/dag-runner';
import { LcmEngine } from '@maf/lcm';
import type { LcmEngineConfig } from '@maf/lcm';
import { ScriptedAdapter } from '@maf/eval-harness';
import { runIsolatedGit } from '@maf/git-ops';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { onePlannedNode, FIXED_SUM, driveRun, lockFilePolicy, needsLcm, recording, registryOf } from './runFixture.js';

// ORACLE: verifier F4 (WP-2.5, rules 2 and 5) — what config.yaml says reaches the pieces that use
// it: `dag` the scheduler (applyDagSettings), `lcm` the LcmEngine, `timeouts` the planner's call
// and the security gate's review. And `--allow-ungoverned` reaches the dispatcher, not only the
// preflight: a writer on the cli tier runs to a merge, where without it the preflight would pass
// and the dispatcher refuse the node. Each value is read back where it was used.

const TASK = 'Fix the bug in sum.js';
const headless = () => ({ stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'settings-key' } });

async function withRepo(body: (root: string, repo: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-settings-'));
  try {
    await body(root, await createDemoFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('config.yaml\'s dag, lcm and timeouts reach the scheduler, the LcmEngine, the planner and the security gate', needsLcm, async (t) => {
  await withRepo(async (root, repo) => {
    await mkdir(path.join(repo, '.maf'), { recursive: true });
    await writeFile(path.join(repo, '.maf', 'config.yaml'), [
      'adapter: scripted',
      'lcm: { mode: Dolt, contextThreshold: 0.5, freshTailCount: 7 }',
      'dag: { maxConcurrent: 1, retry: { maxAttempts: 1, backoffMs: 5 } }',
      'timeouts: { planMs: 11111, securityReviewMs: 22222 }',
      '',
    ].join('\n'), 'utf8');

    const dags: Dag[] = [];
    const run0 = DagRunner.prototype.run;
    t.mock.method(DagRunner.prototype, 'run', function (this: DagRunner, ...args: Parameters<DagRunner['run']>) {
      dags.push(args[0].dag);
      return run0.apply(this, args);
    });
    const lcms: LcmEngineConfig[] = [];
    const close0 = LcmEngine.prototype.close;
    t.mock.method(LcmEngine.prototype, 'close', function (this: LcmEngine) {
      lcms.push((this as unknown as { config: LcmEngineConfig }).config);
      return close0.call(this);
    });

    const scripted = new ScriptedAdapter([onePlannedNode(TASK), { prompt: TASK, final: 'fixed', steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }] }]);
    const { adapter, calls } = recording(scripted);
    const run = await driveRun([TASK, '--dir', repo, '--policy', await lockFilePolicy(root)], { adapters: registryOf(adapter), io: headless() });
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);

    // dag → the scheduler: its concurrency, and every node's retry policy.
    assert.equal(dags.length, 1);
    const dag = dags[0];
    assert.ok(dag);
    assert.equal(dag.config.maxConcurrent, 1);
    assert.equal(dag.config.retryPolicy.maxAttempts, 1);
    assert.ok(dag.nodes.size >= 1);
    for (const node of dag.nodes.values()) assert.deepEqual(node.retryPolicy, { maxAttempts: 1, backoffMs: 5, backoffFactor: 2, jitterMs: 500 });

    // lcm → the run's LcmEngine.
    assert.equal(lcms.length, 1);
    assert.deepEqual({ mode: lcms[0]?.mode, contextThreshold: lcms[0]?.contextThreshold, freshTailCount: lcms[0]?.freshTailCount },
      { mode: 'Dolt', contextThreshold: 0.5, freshTailCount: 7 });

    // timeouts → the planner's invoke and the security gate's review.
    const kind = (i: number) => scripted.exchanges[i]?.kind;
    const planner = calls.filter((c) => c.via === 'invoke' && kind(c.exchange) === 'task');
    const security = calls.filter((c) => c.via === 'invoke' && kind(c.exchange) === 'security-review');
    assert.ok(planner.length >= 1 && security.length >= 1, JSON.stringify(calls));
    assert.deepEqual([...new Set(planner.map((c) => c.timeoutMs))], [11111]);
    assert.deepEqual([...new Set(security.map((c) => c.timeoutMs))], [22222]);
  });
});

test('--allow-ungoverned runs a cli-tier writer through the dispatcher to a merge', needsLcm, async () => {
  await withRepo(async (root, repo) => {
    const roles = path.join(root, 'roles.yaml');
    await writeFile(roles, [
      'version: 1', 'defaultRole: coder', 'roles:',
      '  - { role: coder, systemPrompt: c, allowedTools: [fs.read, fs.write], execution: cli }', '',
    ].join('\n'), 'utf8');
    const scripted = new ScriptedAdapter([onePlannedNode(TASK), { prompt: TASK, final: 'fixed', steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }] }]);
    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted', '--roles', roles, '--allow-ungoverned', '--policy', await lockFilePolicy(root)],
      { adapters: registryOf(scripted), io: headless() });
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
    const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
    assert.ok(runId, run.out);
    assert.ok(scripted.exchanges.some((e) => e.via === 'invoke' && e.kind === 'task' && e.prompt === TASK), 'the writer ran on the cli tier');
    assert.ok(!scripted.exchanges.some((e) => e.via === 'turn'), 'not in-process');
    assert.ok(run.out.includes(`To take it: git merge maf/${runId}`), run.out);
    assert.equal((await runIsolatedGit(repo, ['show', `maf/${runId}:sum.js`])).stdout, FIXED_SUM);
  });
});
