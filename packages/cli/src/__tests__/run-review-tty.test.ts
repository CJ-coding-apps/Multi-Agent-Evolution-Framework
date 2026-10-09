import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { AttestationBundle } from '@maf/types';
import { HarnessStore, mintHarnessConfig } from '@maf/harness-config';
import { ScriptedAdapter } from '@maf/eval-harness';
import { runIsolatedGit } from '@maf/git-ops';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { FIXED_SUM, collector, driveRun, lockFilePolicy, messageOf, needsLcm, registryOf } from './runFixture.js';

// ORACLE: verifier F1 (D-34, rule 6) — on a terminal, `run` asks the terminal reviewer, and a
// harness that requires review hands the gate `required: true`: the prompt says so, a typed `deny`
// fails the writer node with ReviewRefused and records the denial in the signed bundle, and a typed
// `approve` lets the run finish and hand its branch over. Every other run-level test injects a
// reviewer or runs headless, so dropping the terminal reviewer, or passing `required: false`, went
// unseen.

const TASK = 'Fix the bug in sum.js';

/** A run on a "terminal": stdin a PassThrough that answers `answer` each time the review prompt appears. */
async function reviewedRun(answer: string, body: (r: {
  repo: string; runId: string; out: string; err: string; error: unknown; prompts: number; bundle: AttestationBundle;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-tty-'));
  try {
    const repo = await createDemoFixture(root);
    await new HarnessStore(path.join(repo, '.maf')).save(mintHarnessConfig({
      id: 'strict', processorBundles: [], reviewGate: { required: true },
      roleSet: { version: 1, defaultRole: 'coder', roles: [{
        role: 'coder', systemPrompt: 'Fix the code.', allowedTools: ['fs.read', 'fs.write'], execution: 'in-process',
      }] },
    }));
    const scripted = new ScriptedAdapter([{ prompt: TASK, final: 'fixed', steps: [{ tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } }] }]);
    const stdin = new PassThrough();
    const stderr = collector();
    let prompts = 0;
    stderr.on('data', (chunk: Buffer) => {
      // Answered after the prompt is out, as an operator would: input typed before it is discarded.
      if (chunk.toString('utf8').includes('review> ')) {
        prompts += 1;
        setImmediate(() => stdin.write(`${answer}\n`));
      }
    });
    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted', '--harness', 'strict', '--policy', await lockFilePolicy(root)], {
      adapters: registryOf(scripted), io: { stdin, stderr, isTTY: true, env: { MAF_SIGNING_KEY: 'tty-key' } },
    });
    const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
    assert.ok(runId, `${run.out}\n${stderr.text()}`);
    const statement = JSON.parse(await readFile(path.join(repo, '.maf', 'attestations', `${runId}.bundle.json`), 'utf8')) as { predicate: AttestationBundle };
    await body({ repo, runId, out: run.out, err: stderr.text(), error: run.error, prompts, bundle: statement.predicate });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('on a terminal, a required review asks there; "deny" fails the writer with ReviewRefused, on the record', needsLcm, async () => {
  await reviewedRun('deny', async ({ repo, runId, out, err, error, prompts, bundle }) => {
    assert.equal(prompts, 1, `the terminal reviewer was asked once\n${err}`);
    assert.match(err, /\[maf\] review needed: node "[^"]+" \(role "coder"\) changed the tree/);
    assert.match(err, /required: {4}anything but approve fails the node/, 'the gate was built with required: true');
    assert.doesNotMatch(err, /no reviewer is available/);

    assert.match(messageOf(error), /run did not succeed \(Failed\)/);
    assert.equal(bundle.outcome.status, 'Failed');
    const failed = (bundle.outcome.nodes ?? []).filter((n) => n.status === 'Failed');
    assert.equal(failed.length, 1, JSON.stringify(bundle.outcome));
    assert.match(failed[0]?.error ?? '', /Human review refused the change from node .*denied at the terminal.*The review gate is required for this run/s,
      'the node failed with the review gate\'s ReviewRefused');

    const reviews = bundle.approvals.filter((a) => a.decision.reviewer.startsWith('terminal:'));
    assert.deepEqual(reviews.map((a) => a.decision.status), ['Rejected'], 'the denial is in the signed bundle');
    assert.doesNotMatch(out + err, /git merge/);
    assert.equal((await runIsolatedGit(repo, ['rev-parse', `maf/${runId}`])).stdout.trim(),
      (await runIsolatedGit(repo, ['rev-parse', 'HEAD'])).stdout.trim(), 'nothing was committed to the run branch');
  });
});

test('on a terminal, "approve" lets a required review pass and the run hand its branch over', needsLcm, async () => {
  await reviewedRun('approve', async ({ repo, runId, out, err, error, prompts, bundle }) => {
    assert.equal(error, undefined, `${out}\n${err}`);
    assert.equal(prompts, 1);
    assert.match(err, /required: {4}anything but approve fails the node/);
    assert.equal(bundle.outcome.status, 'Succeeded');
    assert.deepEqual(bundle.approvals.filter((a) => a.decision.reviewer.startsWith('terminal:')).map((a) => a.decision.status), ['Approved']);
    assert.ok(out.includes(`To take it: git merge maf/${runId}`), out);
    assert.equal((await runIsolatedGit(repo, ['show', `maf/${runId}:sum.js`])).stdout, FIXED_SUM);
  });
});
