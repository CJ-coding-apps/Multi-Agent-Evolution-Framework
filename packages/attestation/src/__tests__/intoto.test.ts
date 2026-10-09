import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AttestationBundle, SlsaBuilder, SlsaInvocation } from '@maf/types';
import { makeAgentId, makeCommitHash, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { Attestor, DEV_SIGNING_KEY, MAF_RUN_PREDICATE_TYPE, parseBundle } from '../Attestor.js';
import type { SignedRunStatement, SigningOptions } from '../Attestor.js';
import { BundleSigner } from '../BundleSigner.js';
import { IN_TOTO_STATEMENT_TYPE } from '../InTotoStatement.js';
import { componentId, mafVersion } from '../version.js';

// ORACLE: D-13 (part 2) + audit P1 "custom JSON; in-toto builder unused; diffHashes always
// empty" and P2 "canonicalize before HMAC", with component ids still naming 0.1.0. The bundle is an
// in-toto Statement whose subjects are the run's diffs, signed over canonical JSON, so a third
// party can reproduce the bytes and a re-serialization does not break it while an edit does.

const stubGraph = { addNode: async () => undefined } as never;

const BUILDER: SlsaBuilder = { id: 'b@1', modelVersion: 'v' };
const INVOCATION: SlsaInvocation = {
  configSource: { uri: 'harness.yaml', digest: { sha256: 'f'.repeat(64) } },
  parameters: { harnessId: 'h' },
  environment: {},
};

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

interface Attested {
  signed: SignedRunStatement;
  view: AttestationBundle;
  /** The file as written to `.maf/attestations/`. */
  fileText: string;
}

/**
 * A run with something in every section a reader cares about: two diffs recorded out of name
 * order, a refused and an executed tool call, an approval, a security review, a failed outcome.
 */
async function attestedRun(signing: SigningOptions, diffs = true): Promise<Attested> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-intoto-'));
  try {
    const runId = makeRunId('r-intoto');
    const attestor = new Attestor(runId, stubGraph, dir, signing);
    const base = {
      toolId: makeToolId('fs.write'), agentId: makeAgentId('a1'), runId, taskId: makeTaskId('t1'),
      // Array-index keys: JS lists them first, in numeric order; RFC 8785 sorts them as strings.
      input: { path: 'src/a.ts', content: 'x', headers: { '2': 'x', '10': 'y', '!': 'z', '1': 'w' } },
      invokedAt: new Date(0), durationMs: 3,
    };
    await attestor.record({
      ...base,
      result: { stdout: '', stderr: 'policy Deny: no', exitCode: 1, duration: 0, metadata: { refused: true, ruleId: 'r-1' } },
      policyDecision: { verdict: 'Deny', reason: 'no', ruleId: 'r-1' },
    });
    await attestor.record({
      ...base,
      result: { stdout: 'wrote src/a.ts', stderr: '', exitCode: 0, duration: 1, metadata: {} },
      policyDecision: { verdict: 'Allow' },
    });
    if (diffs) {
      attestor.recordDiffHash('n2.diff', 'diff --git b');
      attestor.recordDiffHash('n1.diff', 'diff --git a');
    }
    attestor.addApproval({
      requestId: 'req-1',
      decision: { requestId: 'req-1', status: 'Approved', reviewer: 'cj', decidedAt: new Date(1) },
      commitHash: makeCommitHash('c'.repeat(40)), diffHash: sha256('diff --git a'), intotoStmt: '{}',
    });
    attestor.recordSecurityFindings('n1', { findings: [], summary: 'clean', passed: true });

    const outcome = { status: 'Failed' as const, unscheduled: [] };
    const signed = await attestor.finalize(BUILDER, INVOCATION, [], outcome);
    const fileText = await readFile(path.join(dir, 'r-intoto.bundle.json'), 'utf8');
    const view = await attestor.bundle(BUILDER, INVOCATION, [], outcome);
    return { signed, view, fileText };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Canonical JSON written from the description alone — what a third party would write. */
function thirdPartyCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(thirdPartyCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${thirdPartyCanonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The same JSON value with every object's keys in reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).reverse().map((k) => [k, reverseKeys(obj[k])]));
  }
  return value;
}

test('finalize writes an in-toto Statement: the diffs are its subjects and the run is its predicate', async () => {
  const { signed, fileText } = await attestedRun({ secret: 's3cret' });
  const onDisk = JSON.parse(fileText) as SignedRunStatement;

  assert.equal(onDisk._type, 'https://in-toto.io/Statement/v0.1');
  assert.equal(onDisk._type, IN_TOTO_STATEMENT_TYPE);
  assert.equal(onDisk.predicateType, MAF_RUN_PREDICATE_TYPE);
  assert.match(onDisk.predicateType, /maf/);
  assert.deepEqual(onDisk.subject, [
    { name: 'n1.diff', digest: { sha256: sha256('diff --git a') } },
    { name: 'n2.diff', digest: { sha256: sha256('diff --git b') } },
  ], 'one subject per recorded diff, sorted by name whatever order they were recorded in');

  const p = onDisk.predicate;
  assert.equal(p.runId, 'r-intoto');
  assert.equal(p.keySource, 'env', 'keySource is in the predicate, so it is signed');
  assert.deepEqual(p.toolCalls.map((c) => c.policyDecision.verdict), ['Deny', 'Allow'], 'the refusal is in it');
  assert.equal(p.toolCalls[0]?.result.metadata['refused'], true);
  assert.deepEqual(p.approvals.map((a) => a.requestId), ['req-1']);
  assert.equal(p.securityFindings?.[0]?.nodeId, 'n1');
  assert.equal(p.outcome.status, 'Failed');
  assert.deepEqual(p.diffHashes, { 'n1.diff': sha256('diff --git a'), 'n2.diff': sha256('diff --git b') },
    'the predicate keeps the bundle content the subjects are drawn from');
  assert.equal(typeof onDisk.signature, 'string');

  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(signed)), 'finalize returns what it wrote');
  assert.deepEqual(Attestor.inspect(onDisk, { secret: 's3cret' }), { valid: true, keySource: 'env', legacy: false });
  assert.equal(Attestor.verify(onDisk, { secret: 's3cret' }), true);
  assert.equal(Attestor.verify(signed, { secret: 's3cret' }), true, 'the in-memory statement, Dates and all');
});

test('a run that changed nothing has no subjects, and its statement still verifies', async () => {
  const { fileText } = await attestedRun({ secret: 's3cret' }, false);
  const onDisk = JSON.parse(fileText) as SignedRunStatement;
  assert.deepEqual(onDisk.subject, []);
  assert.equal(Attestor.verify(onDisk, { secret: 's3cret' }), true);
});

test('the signature is HMAC-SHA256 over canonical JSON, reproducible without MAF', async () => {
  const { fileText } = await attestedRun({ secret: 's3cret' });
  const { signature, ...statement } = JSON.parse(fileText) as SignedRunStatement;
  const canonical = thirdPartyCanonical(statement);
  assert.ok(canonical.includes('"headers":{"!":"z","1":"w","10":"y","2":"x"}'), 'RFC 8785 key order, written by hand');
  const reproduced = crypto.createHmac('sha256', 's3cret').update(canonical, 'utf8').digest('hex');
  assert.equal(reproduced, signature);
});

test('a bundle re-serialized with different key order and whitespace still verifies', async () => {
  const { fileText, view } = await attestedRun({ secret: 's3cret' });
  const reordered = JSON.stringify(reverseKeys(JSON.parse(fileText)), null, '\t');
  assert.notEqual(reordered.replace(/\s/g, ''), fileText.replace(/\s/g, ''), 'the bytes did change');
  assert.equal(Attestor.verify(parseBundle(reordered), { secret: 's3cret' }), true);

  // The predicate-shaped value `bundle()` returns is held to the same rule.
  const viewReordered = JSON.parse(JSON.stringify(reverseKeys(JSON.parse(JSON.stringify(view))))) as AttestationBundle;
  assert.deepEqual(Object.keys(view.diffHashes), ['n2.diff', 'n1.diff'], 'recorded order');
  assert.deepEqual(Object.keys(viewReordered.diffHashes), ['n1.diff', 'n2.diff'], 'the other order');
  assert.equal(Attestor.inspect(viewReordered, { secret: 's3cret' }).valid, true);
  assert.equal(Attestor.inspect(view, { secret: 's3cret' }).legacy, false);
});

test('any single-byte change in the statement fails verification', async () => {
  const { fileText } = await attestedRun({ secret: 's3cret' });
  const { signature, ...statement } = JSON.parse(fileText) as SignedRunStatement;
  const bytes = Buffer.from(thirdPartyCanonical(statement), 'utf8');

  let stillJson = 0;
  for (let i = 0; i < bytes.length; i++) {
    const mutated = Buffer.from(bytes);
    mutated[i] = (mutated[i] ?? 0) ^ 0x01;
    let parsed: unknown;
    try {
      parsed = JSON.parse(mutated.toString('utf8'));
    } catch {
      continue; // no longer JSON: refused before any signature is checked
    }
    stillJson++;
    const candidate = { ...(parsed as object), signature } as SignedRunStatement;
    assert.equal(Attestor.verify(candidate, { secret: 's3cret' }), false,
      `byte ${i} (${String.fromCharCode(bytes[i] ?? 0)}→${String.fromCharCode(mutated[i] ?? 0)}) changed and still verified`);
  }
  // Not vacuous: most flips (a digit, a letter in a string or a key) leave valid JSON.
  assert.ok(stillJson > bytes.length / 2, `${stillJson} of ${bytes.length} mutations parsed`);
});

test('a signature that is not exactly the lowercase hex digest does not verify', async () => {
  const { signed } = await attestedRun({ secret: 's3cret' });
  for (const signature of [signed.signature.toUpperCase(), signed.signature.slice(0, 10), `${signed.signature}00`, '']) {
    assert.equal(Attestor.verify({ ...signed, signature }, { secret: 's3cret' }), false, signature);
  }
});

test('keySource is inside the signed statement: flipping it breaks the signature', async () => {
  const { signed } = await attestedRun({ secret: 's3cret' });
  const flipped: SignedRunStatement = { ...signed, predicate: { ...signed.predicate, keySource: 'dev' } };
  assert.equal(Attestor.verify(flipped, { secret: 's3cret' }), false);
  assert.equal(Attestor.verify(flipped, {}), false);
});

test('a statement re-signed with the public development key cannot pass as "env"', async () => {
  const { signed } = await attestedRun({});
  assert.equal(signed.predicate.keySource, 'dev');
  assert.deepEqual(Attestor.inspect(signed, {}), { valid: true, keySource: 'dev', legacy: false });

  const { signature: _s, ...statement } = signed;
  const claimEnv = { ...statement, predicate: { ...statement.predicate, keySource: 'env' as const } };
  const forged: SignedRunStatement = {
    ...claimEnv,
    signature: crypto.createHmac('sha256', DEV_SIGNING_KEY)
      .update(thirdPartyCanonical(JSON.parse(JSON.stringify(claimEnv))), 'utf8').digest('hex'),
  };
  const report = Attestor.report(forged, {});
  assert.deepEqual({ valid: report.valid, keySource: report.keySource, legacy: report.legacy },
    { valid: false, keySource: 'dev', legacy: false }, 'the signature matches the dev key; the claim does not');
  assert.match(report.reason ?? '', /claims .*MAF_SIGNING_KEY/);
  assert.equal(Attestor.verify(forged, { secret: 's3cret' }), false);
  assert.equal(new BundleSigner(DEV_SIGNING_KEY).verify(forged), false, 'the exported signer agrees');
});

test('a 0.2.1 bundle (custom JSON with keySource) inspects as legacy and verifies on its own signature', async () => {
  const { view } = await attestedRun({ secret: 's3cret' });
  // What a 0.2.1 Attestor wrote: the bundle fields in insertion order, signed over JSON.stringify.
  const { signature: _s, ...rest } = JSON.parse(JSON.stringify(view)) as AttestationBundle;
  const legacy = (secret: string, body: object): AttestationBundle => ({
    ...(body as AttestationBundle),
    signature: crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex'),
  });

  const old = legacy('s3cret', rest);
  assert.deepEqual(Attestor.inspect(old, { secret: 's3cret' }), { valid: true, keySource: 'env', legacy: true });
  assert.equal(Attestor.verify(old, {}), false, 'not the dev key');
  assert.equal(new BundleSigner('s3cret').verify(old), true);

  // The 0.2.1 keySource rule still holds for 0.2.1 bundles: a dev-signed one cannot claim "env".
  const forged = legacy(DEV_SIGNING_KEY, { ...rest, keySource: 'env' });
  assert.deepEqual(Attestor.inspect(forged, {}), { valid: false, keySource: 'dev', legacy: true });
  assert.equal(Attestor.verify(legacy(DEV_SIGNING_KEY, { ...rest, keySource: 'dev' }), {}), true);

  // Read back from disk the way `maf attest verify` reads it.
  assert.equal(Attestor.inspect(parseBundle(JSON.stringify(old, null, 2)), { secret: 's3cret' }).legacy, true);
});

test('a statement of another type or predicate does not verify, and the report says why', async () => {
  const { signed } = await attestedRun({ secret: 's3cret' });
  const resign = (s: Omit<SignedRunStatement, 'signature'>): SignedRunStatement => ({
    ...s, signature: new BundleSigner('s3cret').sign(s),
  });
  const { signature: _s, ...statement } = signed;

  const otherType = Attestor.report(resign({ ...statement, _type: 'https://in-toto.io/Statement/v1' }), { secret: 's3cret' });
  assert.equal(otherType.valid, false);
  assert.match(otherType.reason ?? '', /_type is "https:\/\/in-toto\.io\/Statement\/v1"/);

  const otherPredicate = Attestor.report(resign({ ...statement, predicateType: 'https://slsa.dev/provenance/v0.2' }), { secret: 's3cret' });
  assert.equal(otherPredicate.valid, false);
  assert.match(otherPredicate.reason ?? '', /predicateType is "https:\/\/slsa\.dev\/provenance\/v0\.2"/);

  const tampered = Attestor.report({ ...signed, subject: [] }, { secret: 's3cret' });
  assert.match(tampered.reason ?? '', /does not match the bundle's content/);
});

test('a 0.3.0 statement with no keySource does not verify, in either shape, though its signature matches', async () => {
  // Verifier F3: only a 0.2.0 bundle may lack keySource, and that is the legacy layout.
  for (const signing of [{ secret: 's3cret' }, {}] satisfies SigningOptions[]) {
    const { signed } = await attestedRun(signing);
    const { signature: _s, ...statement } = signed;
    const { keySource: _k, ...unlabelled } = statement.predicate;
    const bare = { ...statement, predicate: unlabelled as SignedRunStatement['predicate'] };
    const resigned: SignedRunStatement = { ...bare, signature: new BundleSigner(signing.secret ?? '').sign(bare) };
    const report = Attestor.report(resigned, signing);
    assert.deepEqual({ valid: report.valid, legacy: report.legacy }, { valid: false, legacy: false });
    assert.match(report.reason ?? '', /names no keySource/);

    // The `bundle()` shape: the predicate, with the signature of the statement that wraps it.
    const view = { ...unlabelled, signature: resigned.signature } as AttestationBundle;
    const viewReport = Attestor.report(view, signing);
    assert.deepEqual({ valid: viewReport.valid, legacy: viewReport.legacy }, { valid: false, legacy: false });
    assert.match(viewReport.reason ?? '', /names no keySource/);
  }
});

test('legacy is reported only when the 0.2.x signature matched', async () => {
  // Verifier F6: a bundle-shaped object that matches neither signature is not known to be 0.2.x.
  const { view } = await attestedRun({ secret: 's3cret' });
  const bad = Attestor.report({ ...view, signature: 'f'.repeat(64) }, { secret: 's3cret' });
  assert.deepEqual({ valid: bad.valid, legacy: bad.legacy }, { valid: false, legacy: false });
  assert.match(bad.reason ?? '', /does not match the bundle's content/);
  assert.equal(Attestor.inspect(view, {}).legacy, false, 'the wrong key: neither signature matched');

  const { signature: _s, ...rest } = JSON.parse(JSON.stringify(view)) as AttestationBundle;
  const old = { ...rest, signature: crypto.createHmac('sha256', 's3cret').update(JSON.stringify(rest)).digest('hex') };
  assert.equal(Attestor.inspect(old, { secret: 's3cret' }).legacy, true);
  assert.deepEqual(Attestor.inspect(old, { secret: 'other' }), { valid: false, keySource: 'env', legacy: false });
});

test("a signed statement whose subjects are not its predicate's diffHashes does not verify, and says why", async () => {
  // Verifier F6: the subject count `maf attest verify` prints must be the diffs the run recorded.
  const { signed } = await attestedRun({ secret: 's3cret' });
  const { signature: _s, ...statement } = signed;
  const [first, second] = statement.subject;
  assert.ok(first && second);
  const check = (subject: unknown, diffHashes: unknown = statement.predicate.diffHashes): string => {
    const body = { ...statement, subject, predicate: { ...statement.predicate, diffHashes } } as Omit<SignedRunStatement, 'signature'>;
    const report = Attestor.report({ ...body, signature: new BundleSigner('s3cret').sign(body) }, { secret: 's3cret' });
    assert.equal(report.valid, false, JSON.stringify(subject));
    return report.reason ?? '';
  };
  assert.match(check([first, first, second]), /names the subject "n1\.diff" twice/);
  assert.match(check([first]), /diffHashes records "n2\.diff", which the statement does not name as a subject/);
  assert.match(check([first, second, { name: 'n3.diff', digest: { sha256: 'a'.repeat(64) } }]),
    /subject "n3\.diff" is not in its predicate's diffHashes/);
  assert.match(check([first, { name: second.name, digest: { sha256: 'a'.repeat(64) } }]),
    /subject "n2\.diff" has sha256 a{64}, and its predicate's diffHashes records "[0-9a-f]{64}"/);
  assert.match(check([first, { name: 'n2.diff' }]), /a subject that is not \{name, digest: \{sha256\}\}/);
  assert.match(check('n1.diff'), /subject is "n1\.diff", not a list/);
  assert.match(check([], null), /diffHashes is null; expected an object/);
  assert.equal(Attestor.verify(signed, { secret: 's3cret' }), true, 'the statement as written is consistent');
});

test('parseBundle refuses what is not a bundle, with a sentence saying what it found', () => {
  assert.throws(() => parseBundle('{not json'), /is not JSON/);
  assert.throws(() => parseBundle('[1,2]'), /expected a JSON object, found an array/);
  assert.throws(() => parseBundle('{"runId":"r"}'), /expected a string "signature", found undefined/);
});

test('component ids carry the version the package ships as, not 0.1.0', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(mafVersion(), pkg.version);
  assert.notEqual(mafVersion(), '0.1.0');
  assert.equal(componentId('@maf/adapter-claude'), `@maf/adapter-claude@${pkg.version}`);
});
