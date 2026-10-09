import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AttestationBundle } from '@maf/types';
import { Attestor, MAF_RUN_PREDICATE_TYPE, componentId, parseBundle } from '@maf/attestation';
import type { InTotoStatement } from '@maf/attestation';
import { needsLcm } from './runFixture.js';
import { attestAndClose, demoFailures } from '../commands/inprocessDemo.js';

// ORACLE: WP-2.10 acceptance, the demo half (BUILD_PLAN §6, D-24, verifier F5) — `maf inprocess-demo`
// runs its coder in-process through the stack goldens and evolve share, its escalated delete is
// refused headless (D-02) and that refusal is in the bundle's approvals with a pending record beside
// it, the security gate reviews the diff, and the run leaves a signed in-toto statement with
// keySource inside the signed predicate and the coder's diff as a subject, under the version the
// packages ship as.

const MAIN = path.join(__dirname, '..', 'main.js');
const KEY = 'demo-signing-key';

test('maf inprocess-demo: in-process coder, security gate, signed in-toto attestation with keySource', needsLcm, async () => {
  const { MAF_SIGNING_KEY: _ignored, ...env } = process.env;
  const result = spawnSync(process.execPath, [MAIN, 'inprocess-demo'], { env: { ...env, MAF_SIGNING_KEY: KEY }, encoding: 'utf8', timeout: 110_000 });
  const fixture = /\[demo\] fixture:\s+(\S+)/.exec(result.stdout)?.[1];
  try {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /\[demo\] OK: in-process role ran end-to-end/);
    assert.match(result.stdout, /adapter:\s+scripted \(inProcessLoop=true\)/);
    assert.match(result.stdout, /gate policy blocked fs\.delete in-loop:\s+true/);
    const file = /attn signed bundle:\s+(\S+)/.exec(result.stdout)?.[1];
    assert.ok(file && fixture, result.stdout);

    const text = await readFile(file, 'utf8');
    const statement = JSON.parse(text) as InTotoStatement<AttestationBundle> & { signature: string };
    assert.equal(statement._type, 'https://in-toto.io/Statement/v0.1');
    assert.equal(statement.predicateType, MAF_RUN_PREDICATE_TYPE);
    const report = Attestor.report(parseBundle(text), { secret: KEY });
    assert.equal(report.valid, true, report.reason);
    assert.equal(report.keySource, 'env');
    const predicate = statement.predicate;
    assert.equal(predicate.keySource, 'env');
    assert.equal(predicate.outcome.status, 'Succeeded');
    assert.equal(predicate.provenance.builder.id, componentId('@maf/inprocess-demo'));
    // The escalated delete: refused headless, recorded in the signed approvals, left as a pending record.
    assert.deepEqual(predicate.approvals.map((a) => [a.decision.status, a.decision.reviewer]), [['Rejected', 'headless']]);
    const refusal = predicate.approvals[0];
    assert.ok(refusal);
    await access(path.join(fixture, '.maf', 'approvals', 'pending', `${refusal.requestId}.json`));

    // The coder's tool calls were made in-process, through the gate: each one is on the record.
    const tools = predicate.toolCalls.map((c) => [String(c.toolId), c.result.metadata['refused'] === true]);
    assert.deepEqual(tools, [['fs.read', false], ['fs.delete', true], ['fs.write', false], ['test.run', false]]);

    // The security gate reviewed the diff the coder left, and that diff is the statement's subject.
    assert.equal(statement.subject.length, 1);
    const subject = statement.subject[0];
    assert.match(subject?.name ?? '', /\.diff$/);
    assert.deepEqual(predicate.securityFindings?.map((f) => [`${f.nodeId}.diff`, f.result.passed]), [[subject?.name, true]]);
  } finally {
    if (fixture) await rm(path.dirname(fixture), { recursive: true, force: true });
  }
});

// ORACLE (F11 of the 0.3.0 release audit): the demo's exit status ignored its redaction and gate lines,
// and a bundle that could not be written was swallowed (`.catch(() => undefined)`) while the result
// block still named it as the signed bundle.

test('the demo fails on any line of its result block that did not hold, the redaction and gate lines included', () => {
  const held = { sumFixed: true, testPassed: true, redacted: true, faithful: true, policyDenied: true };
  assert.deepEqual(demoFailures(held), []);
  assert.deepEqual(demoFailures({ sumFixed: true, testPassed: true }), [], 'live: the scripted-only lines are not checked');
  for (const key of Object.keys(held) as Array<keyof typeof held>) {
    const failures = demoFailures({ ...held, [key]: false });
    assert.equal(failures.length, 1, key);
  }
  assert.match(demoFailures({ ...held, redacted: false })[0] ?? '', /no credential redacted/);
  assert.match(demoFailures({ ...held, policyDenied: false })[0] ?? '', /fs\.delete was not refused/);
});

test('a bundle that cannot be written fails the demo, and the stack is closed either way', async () => {
  let closed = 0;
  const stack = { close: () => { closed++; } };
  const unwritable = async (): Promise<never> => { throw new Error('EACCES: permission denied, open attestations/run.bundle.json'); };

  await assert.rejects(() => attestAndClose(stack, unwritable), /EACCES/);
  assert.equal(closed, 1);

  // A dispatch that already failed is the cause: its error is thrown, the bundle's is reported beside it.
  await assert.rejects(() => attestAndClose(stack, unwritable, new Error('the coder failed')), /the coder failed/);
  assert.equal(closed, 2);

  let attested = 0;
  await attestAndClose(stack, async () => { attested++; });
  await assert.rejects(() => attestAndClose(stack, async () => { attested++; }, new Error('the coder failed')), /the coder failed/);
  assert.equal(attested, 2, 'a failed dispatch is still attested');
  assert.equal(closed, 4);
});
