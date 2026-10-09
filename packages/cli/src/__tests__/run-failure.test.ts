import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { HarnessStore, mintHarnessConfig } from '@maf/harness-config';
import { ScriptedAdapter } from '@maf/eval-harness';
import { MemoryGraph, recallFailures } from '@maf/memory-graph';
import { runIsolatedGit } from '@maf/git-ops';
import {
  onePlannedNode,
  FIXED_SUM, dirtyUserRepo, driveRun, lockFilePolicy, messageOf, needsLcm, registryOf, userState,
} from './runFixture.js';

// ORACLE: rules 4, 6 and 8 together, on a run that fails. A harness that requires review, run with
// no one to ask, refuses the writer's change (D-34: fail closed); the run fails, keeps its worktree
// for inspection and says where, offers no merge, and leaves the user's checkout as it was. The
// failure reaches the memory graph through the DagRunner's recorder as one Task + Failure joined by
// CAUSED_FAILURE, recalled by the run's title (D-16, D-37) — and nothing else writes a second,
// unlinked Failure node, as the post-run loop this replaced did.

const TASK = 'Fix the failing sum test';

test('a required review with no reviewer fails closed; the worktree is kept, the user untouched, the failure recalled', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-failure-'));
  try {
    const repo = await dirtyUserRepo(root);
    const policy = await lockFilePolicy(root);
    const store = new HarnessStore(path.join(repo, '.maf'));
    await store.save(mintHarnessConfig({
      id: 'strict', processorBundles: [], reviewGate: { required: true },
      roleSet: { version: 1, defaultRole: 'coder', roles: [{
        role: 'coder', systemPrompt: 'Fix the code.', allowedTools: ['fs.read', 'fs.write'], execution: 'in-process',
      }] },
    }));
    const before = await userState(repo);
    const scripted = new ScriptedAdapter([onePlannedNode(TASK), { prompt: TASK, final: 'fixed', steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }] }]);

    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted', '--harness', 'strict', '--policy', policy], {
      adapters: registryOf(scripted), io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'failure-key' } },
    });
    const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
    assert.ok(runId, run.out);
    const worktree = path.join(repo, '.maf', 'worktrees', runId);

    assert.match(messageOf(run.error), /run did not succeed \(Failed\)/);
    assert.match(run.err, /harness strict requires review and no reviewer is available/);
    assert.ok(run.err.includes(`[maf] the run's worktree is kept for inspection at ${worktree} (branch maf/${runId}).`), run.err);
    assert.doesNotMatch(run.out + run.err, /git merge/, 'a failed run offers no merge');
    assert.equal(await readFile(path.join(worktree, 'sum.js'), 'utf8'), FIXED_SUM, 'the refused change is kept where it was made');
    assert.equal((await runIsolatedGit(repo, ['rev-parse', `maf/${runId}`])).stdout.trim(), before.head, 'nothing was committed to the run branch');
    assert.deepEqual(await userState(repo), before, "the user's files, status, index, HEAD and config are byte-identical");

    const statement = JSON.parse(await readFile(path.join(repo, '.maf', 'attestations', `${runId}.bundle.json`), 'utf8')) as {
      predicate: { outcome: { status: string }; keySource: string };
    };
    assert.equal(statement.predicate.outcome.status, 'Failed', 'the failed run is still attested');
    assert.equal(statement.predicate.keySource, 'env');

    const graph = new MemoryGraph(path.join(repo, '.maf', 'memory.kuzu'));
    try {
      const recalled = await recallFailures(graph, { title: TASK, limit: 5 });
      assert.equal(recalled.length, 1, 'the failure is recalled by the run title');
      assert.equal(recalled[0]?.role, 'coder');
      assert.equal(recalled[0]?.runId, runId);
      assert.match(recalled[0]?.message ?? '', /review/i);
      const failures = await graph.run({ cypher: "MATCH (n:MemoryNode) WHERE n.kind = 'Failure' RETURN count(n) AS c", params: {} });
      assert.equal(Number((failures[0] as { c: unknown } | undefined)?.c), 1, 'one Failure node, the recorder\'s; no unlinked duplicate');
    } finally {
      graph.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
