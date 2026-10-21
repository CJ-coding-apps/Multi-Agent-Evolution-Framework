import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { ScriptedAdapter } from '@maf/eval-harness';
import { runIsolatedGit } from '@maf/git-ops';
import { driveRun, dirtyUserRepo, FIXED_SUM, needsLcm, registryOf } from './runFixture.js';

// ORACLE (WP-3.6): `maf run --plan-from <spec>` runs the DAG the spec describes, in the order its
// edges name, and makes no planner call. Before this a spec's `edges` were kept beside the DAG and
// the scheduler ignored them, so a two-node spec could run both nodes at once; and the only way to
// get a plan was to ask a model, which is neither deterministic nor offline.

const FIRST = 'Fix sum.js so the test passes';
const SECOND = 'Add the helper module for the fix';
const HELPER = 'module.exports = (a, b) => a + b;\n';

test('maf run --plan-from: a two-node spec runs both nodes in edge order, with no model plan', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-plan-from-'));
  const repo = await dirtyUserRepo(root);
  const spec = path.join(root, 'two-node.json');
  await writeFile(spec, JSON.stringify({
    id: 'two-node',
    nodes: [
      { id: 'n1', label: FIRST },
      { id: 'n2', label: SECOND },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  }), 'utf8');

  const scripted = new ScriptedAdapter([
    { prompt: FIRST,  steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }], final: 'Fixed sum.js.' },
    { prompt: SECOND, steps: [{ tool: 'fs.write', input: { path: 'helper.js', content: HELPER } }], final: 'Added helper.js.' },
  ]);

  const run = await driveRun([FIRST, '--dir', repo, '--adapter', 'scripted', '--plan-from', spec], {
    adapters: registryOf(scripted),
    io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'plan-from-key' } },
  });
  assert.equal(run.error, undefined, `${run.out}\n${run.err}`);

  // The plan was read, not generated.
  assert.match(run.out, new RegExp(`\\[maf\\] plan: ${escapeRe(spec)} \\(read from spec, no model call\\)`));
  assert.match(run.out, /\[maf\] running DAG with 2 node\(s\)/);
  const firstAt = run.out.indexOf('[maf] → node n1 started');
  const secondAt = run.out.indexOf('[maf] → node n2 started');
  assert.ok(firstAt >= 0 && secondAt >= 0, run.out);
  assert.ok(firstAt < secondAt, 'n2 starts only after n1: the edge is an ordering constraint');
  assert.ok(run.out.includes('[maf] ← node n1 Succeeded'));
  assert.ok(run.out.includes('[maf] ← node n2 Succeeded'));

  // No planner call: every invoke is the security gate's review, never a plan.
  const planCalls = scripted.exchanges.filter((e) => e.via === 'invoke' && e.kind === 'task');
  assert.deepEqual(planCalls, [], 'the planner was never asked');

  // Both nodes' work is on the run branch.
  const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
  assert.ok(runId, run.out);
  const show = async (file: string) => (await runIsolatedGit(repo, ['show', `maf/${runId}:${file}`])).stdout;
  assert.equal(await show('sum.js'), FIXED_SUM);
  assert.equal(await show('helper.js'), HELPER);
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
