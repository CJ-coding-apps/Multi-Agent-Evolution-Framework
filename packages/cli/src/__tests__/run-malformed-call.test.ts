import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { AttestationBundle } from '@maf/types';
import { buildTurnSystemPrompt, serializeTools } from '@maf/adapter-base';
import { ScriptedAdapter } from '@maf/eval-harness';
import type { InTotoStatement } from '@maf/attestation';
import { runIsolatedGit } from '@maf/git-ops';
import { createDefaultRegistry } from '@maf/tools';
import { createDemoFixture } from '../commands/inprocessDemo.js';
import { BUGGY_SUM, driveRun, needsLcm, onePlannedNode, registryOf } from './runFixture.js';

// ORACLE: WP-2.18 — the maintainer's live proof of the 0.3.0 release candidate, on macOS with the real
// `claude` adapter: `maf run "add a hello function"` on a repository with no `.maf/` ended Failed with
// `The "data" argument must be of type string … Received undefined`. The coder sent `patch.apply` a
// `{path, patch}`; the field is `diff`, and the catalog never said so. Replayed here with the scripted
// adapter through `maf run` as main.ts registers it: the catalog now names `diff`, the malformed call is
// answered with an error naming it, the coder's next turn sends `{diff}`, and the node succeeds. Round 2
// adds the failure round one predicted: the coder first reads `hello.js`, which is not there; that ENOENT
// is answered as `fs.read failed: …` instead of ending the node.

const TASK = 'add a hello function';
const DIFF = [
  '--- a/sum.js',
  '+++ b/sum.js',
  '@@ -1 +1,3 @@',
  ' module.exports = (a, b) => a - b;',
  '+',
  "+module.exports.hello = () => 'hello';",
  '',
].join('\n');
const WITH_HELLO = `${BUGGY_SUM}\nmodule.exports.hello = () => 'hello';\n`;
const PATCH_INPUT = '{"diff": string (required), "strip": number, "dryRun": boolean}';
const ANSWER = `patch.apply expects input ${PATCH_INPUT}; "diff" is missing and the input has "path", "patch", which it does not take.`;

test('the catalog a model is shown names each tool\'s fields: "diff" for patch.apply, "content" for fs.write', () => {
  const lines = serializeTools(createDefaultRegistry().getAll()).split('\n');
  const entry = (id: string): string => lines.find((l) => l.startsWith(`- ${id} [`)) ?? `(no entry for ${id})`;
  assert.ok(entry('patch.apply').endsWith(` — input: ${PATCH_INPUT}`), entry('patch.apply'));
  assert.ok(entry('fs.write').endsWith(' — input: {"path": string (required), "content": string (required), "createDirs": boolean}'), entry('fs.write'));
});

test('maf run, the live failures replayed: a missing hello.js and a {path, patch} are answered, the corrected call applies, the node succeeds', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-run-malformed-'));
  try {
    const repo = await createDemoFixture(root);
    await assert.rejects(access(path.join(repo, '.maf')), 'a repository with no .maf/, as in the live proof');
    const scripted = new ScriptedAdapter([onePlannedNode(TASK), {
      prompt: TASK,
      steps: [
        { tool: 'fs.read', input: { path: 'hello.js' } },                  // not there
        { tool: 'patch.apply', input: { path: 'sum.js', patch: DIFF } }, // what the model sent
        { tool: 'patch.apply', input: { diff: DIFF } },                  // what it sends once told
      ],
      final: 'Added hello().',
    }]);

    const run = await driveRun([TASK, '--dir', repo, '--adapter', 'scripted'], {
      adapters: registryOf(scripted),
      io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'malformed-call-key' } },
    });
    assert.equal(run.error, undefined, `${run.out}\n${run.err}`);
    const runId = /\[maf\] run (\S+) \|/.exec(run.out)?.[1];
    assert.ok(runId, run.out);

    // ── the change: on the run's branch, as the corrected call made it ──
    assert.equal((await runIsolatedGit(repo, ['show', `maf/${runId}:sum.js`])).stdout, WITH_HELLO);

    // ── what the coder was shown: the catalog naming "diff", then the answer to each call ──
    const turns = scripted.exchanges.filter((e) => e.via === 'turn');
    assert.equal(turns.length, 4, 'the missing read, the malformed call, the corrected call, the final answer');
    const [first, second, third, fourth] = turns;
    assert.ok(first && second && third && fourth);
    const catalog = buildTurnSystemPrompt(first.systemPrompt, first.tools);
    assert.match(catalog, /^- patch\.apply \[write\]: .* — input: \{"diff": string \(required\), "strip": number, "dryRun": boolean\}$/m);
    assert.equal(first.lastToolResult, undefined);
    assert.match(second.lastToolResult ?? '', /^fs\.read failed: ENOENT: no such file or directory, open '.*hello\.js'$/,
      'the missing file was answered, not thrown');
    assert.equal(third.lastToolResult, ANSWER, 'the malformed call was answered, naming "diff"');
    // `git apply` says nothing when it applies — GNU `patch` printed `patching file sum.js`, and
    // `patch.apply` no longer runs it. The change is the confirmation, and it is asserted above on
    // the run's branch; the bundle below records exit code 0 for this call.
    assert.equal(fourth.lastToolResult, '');

    // ── the bundle: the failed read, run and allowed; both patch calls, the first not run and why ──
    const text = await readFile(path.join(repo, '.maf', 'attestations', `${runId}.bundle.json`), 'utf8');
    const predicate = (JSON.parse(text) as InTotoStatement<AttestationBundle>).predicate;
    assert.deepEqual(predicate.toolCalls.filter((c) => c.toolId === 'fs.read').map((c) => [c.policyDecision.verdict, c.result.exitCode]),
      [['Allow', 1]]);
    const patches = predicate.toolCalls.filter((c) => c.toolId === 'patch.apply');
    assert.deepEqual(patches.map((c) => [c.input, c.policyDecision.verdict, c.result.exitCode]), [
      [{ path: 'sum.js', patch: DIFF }, 'Indeterminate', 1],
      [{ diff: DIFF }, 'Allow', 0],
    ]);
    assert.deepEqual(patches[0]?.policyDecision, { verdict: 'Indeterminate', reason: ANSWER, ruleId: 'builtin:input-schema' });
    assert.equal(patches[0]?.result.stderr, ANSWER);
    assert.equal(patches[0]?.result.metadata['refused'], true);
    assert.equal(predicate.outcome.status, 'Succeeded');
    assert.deepEqual(predicate.outcome.nodes?.map((n) => n.status), ['Succeeded']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
