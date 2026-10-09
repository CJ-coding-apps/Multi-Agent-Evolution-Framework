import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { AttestationBundle } from '@maf/types';
import { ScriptedAdapter } from '@maf/eval-harness';
import { Attestor, MAF_RUN_PREDICATE_TYPE, componentId, parseBundle } from '@maf/attestation';
import type { InTotoStatement } from '@maf/attestation';
import { runIsolatedGit } from '@maf/git-ops';
import type { ReviewDecision, ReviewRequest } from '@maf/git-ops';
import { attestVerify } from '../commands/attest.js';
import {
  onePlannedNode,
  BUGGY_SUM, FIXED_SUM, dirtyUserRepo, driveRun, lockFilePolicy, needsLcm, recording, registryOf, userState,
} from './runFixture.js';

// ORACLE: WP-2.10 acceptance (BUILD_PLAN §6) — `maf run` against a temporary repository with the
// scripted adapter goes worktree → in-process coder → security gate → review record → attestation
// with keySource and approvals, and the user's tree is untouched. Driven through commander exactly
// as main.ts registers the command; only the adapters, the reviewer and the streams are the test's.

const TASK = 'Fix the bug in sum.js so the test passes';
const KEY = 'acceptance-signing-key';

test('maf run: worktree → in-process coder → security gate → review record → signed attestation; the user untouched', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-acceptance-'));
  try {
    const repo = await dirtyUserRepo(root);
    const policy = await lockFilePolicy(root);
    const before = await userState(repo);

    const scripted = new ScriptedAdapter([onePlannedNode(TASK), {
      prompt: TASK,
      steps: [
        { tool: 'fs.read', input: { path: 'sum.js' } },
        { tool: 'fs.write', input: { path: 'yarn.lock', content: 'pinned\n' } }, // escalated; no one can approve
        { tool: 'fs.write', input: { path: 'sum.js', content: FIXED_SUM } },
      ],
      final: 'Fixed sum.js: a - b → a + b.',
    }]);
    // The scripted adapter ignores the directory it is handed; the wrapper keeps it.
    const { adapter, calls } = recording(scripted);
    const asked: ReviewRequest[] = [];
    const reviewer = async (request: ReviewRequest): Promise<ReviewDecision> => {
      asked.push(request);
      return { verdict: 'Approve', reviewer: 'acceptance-reviewer', comment: 'looks right' };
    };

    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted', '--review', '--policy', policy], {
      adapters: registryOf(adapter), reviewer,
      io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: KEY } },
    });
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
    const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
    assert.ok(runId, run.out);
    const branch = `maf/${runId}`;
    const show = async (rev: string) => (await runIsolatedGit(repo, ['show', rev])).stdout;

    // ── worktree: created from HEAD, the work on the run branch, handed over as a merge command ──
    const worktree = path.join(repo, '.maf', 'worktrees', runId);
    await access(worktree);
    assert.ok(run.out.includes(`[maf] worktree: ${worktree} (branch ${branch}, from ${before.head.slice(0, 12)})`), run.out);
    assert.match(run.err, /has uncommitted or untracked changes; the run starts from HEAD in its own worktree and will not see them/);
    assert.ok(run.out.includes(`To take it: git merge ${branch}`), run.out);
    assert.equal(await show(`${branch}:sum.js`), FIXED_SUM, 'the fix is on the run branch');
    assert.equal(await show(`${before.head}:sum.js`), BUGGY_SUM);
    await assert.rejects(show(`${branch}:yarn.lock`), 'the escalated write never ran');
    await assert.rejects(show(`${branch}:notes.txt`), "the user's untracked file is not in the run");
    assert.doesNotMatch(await show(`${branch}:test.js`), /staged by the user/, "the user's staged edit is not in the run");

    // ── the user's checkout: byte for byte as it was ──
    assert.deepEqual(await userState(repo), before, "the user's files, status, index, HEAD and config are byte-identical");

    // ── the coder ran in-process: one turn per tool call and one to finish, never a CLI invoke ──
    const turns = scripted.exchanges.filter((e) => e.via === 'turn');
    assert.equal(turns.length, 4);
    assert.ok(turns.every((e) => e.prompt === TASK && e.kind === 'task'));
    const invokes = scripted.exchanges.filter((e) => e.via === 'invoke');
    assert.ok(invokes.every((e) => e.prompt !== TASK), 'the task never went to the cli tier');
    assert.ok(invokes.some((e) => e.prompt.startsWith('Create a task execution DAG for:')), 'the planner was asked');

    // ── every request went to the run's worktree: the planner, each coder turn, the security gate ──
    const asks = calls.map((c) => ({ ...c, what: `${c.via}:${scripted.exchanges[c.exchange]?.kind ?? '?'}` }));
    assert.deepEqual([...new Set(asks.map((a) => a.what))].sort(), ['invoke:security-review', 'invoke:task', 'turn:task']);
    // F4 of the 0.3.0 release audit: the planner's call and the security review ask for text only.
    for (const a of asks.filter((x) => x.via === 'invoke')) assert.equal(a.nativeTools, false, `${a.what} asks for no backend tools`);
    for (const a of asks) {
      assert.ok(a.workingDir === worktree || a.workingDir.startsWith(worktree + path.sep),
        `${a.what} was handed ${a.workingDir}, outside the run's worktree ${worktree}`);
    }

    // ── the attestation on disk: an in-toto statement that verifies with the run's key ──
    const file = path.join(repo, '.maf', 'attestations', `${runId}.bundle.json`);
    const text = await readFile(file, 'utf8');
    const statement = JSON.parse(text) as InTotoStatement<AttestationBundle> & { signature: string };
    assert.equal(statement._type, 'https://in-toto.io/Statement/v0.1');
    assert.equal(statement.predicateType, MAF_RUN_PREDICATE_TYPE);
    const report = Attestor.report(parseBundle(text), { secret: KEY });
    assert.equal(report.valid, true, report.reason);
    assert.equal(report.keySource, 'env');
    assert.equal(report.legacy, false);
    const verified = await attestVerify(file, { secret: KEY });
    assert.deepEqual(verified.lines, ['valid: true', 'keySource: env (checked against MAF_SIGNING_KEY)', `subjects: ${statement.subject.length}`]);
    const predicate = statement.predicate;
    assert.equal(predicate.keySource, 'env', 'keySource is inside the signed predicate');
    assert.equal(predicate.outcome.status, 'Succeeded');
    assert.equal(predicate.provenance.builder.id, componentId('@maf/adapter-scripted'));

    // ── at least one subject: the coder's diff, the one the security gate and the reviewer saw ──
    const [request] = asked;
    assert.ok(request, 'the reviewer was asked');
    assert.equal(asked.length, 1, 'one writer node, one review');
    const nodeId = String(request.nodeId);
    assert.ok(statement.subject.length >= 1);
    assert.deepEqual(statement.subject.find((s) => s.name === `${nodeId}.diff`)?.digest,
      { sha256: crypto.createHash('sha256').update(request.diff).digest('hex') });

    // ── the security gate ran on that diff ──
    const reviews = scripted.exchanges.filter((e) => e.kind === 'security-review');
    assert.ok(reviews.length >= 1, 'the security gate asked for a review');
    assert.ok(reviews.some((e) => e.prompt.includes('+module.exports = (a, b) => a + b;')), 'of the coder\'s diff');
    assert.deepEqual(predicate.securityFindings?.map((f) => [f.nodeId, f.result.passed]), [[nodeId, true]]);

    // ── the review record: asked once, with the diff, recorded as the reviewer decided ──
    assert.equal(request.role, 'coder');
    assert.equal(request.required, false, '--review on a harness that does not require it is advisory');
    assert.equal(String(request.baseCommit), before.head, 'reviewed against the commit the node started from');
    assert.match(request.diff, /\+module\.exports = \(a, b\) => a \+ b;/);
    assert.equal(request.diffHash, crypto.createHash('sha256').update(request.diff).digest('hex'));
    const review = predicate.approvals.find((a) => a.requestId === request.id);
    assert.ok(review, 'the review decision is in the signed bundle');
    assert.equal(review.decision.status, 'Approved');
    assert.equal(review.decision.reviewer, 'acceptance-reviewer');
    assert.equal(review.diffHash, request.diffHash);

    // ── the approval gate: the escalated write, refused headless, attested and left pending ──
    const refused = predicate.approvals.filter((a) => a.decision.reviewer === 'headless');
    assert.deepEqual(refused.map((a) => a.decision.status), ['Rejected']);
    await access(path.join(repo, '.maf', 'approvals', 'pending', `${refused[0]?.requestId}.json`));
    assert.equal(predicate.approvals.length, 2, 'the review and the refusal, nothing else');

    // ── the harness that ran is the one the bundle names ──
    const sha = predicate.provenance.invocation.configSource.digest['sha256'];
    assert.ok(sha && run.out.includes(`[maf] harness: legacy-default (${sha.slice(0, 8)}) [legacy]`), run.out);
    assert.equal(predicate.provenance.invocation.configSource.uri, path.join(repo, '.maf', 'harnesses', `${sha}.yaml`));
    await access(predicate.provenance.invocation.configSource.uri);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
