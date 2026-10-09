import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AttestationBundle, KeySource, SlsaBuilder, SlsaInvocation } from '@maf/types';
import { makeRunId } from '@maf/types';
import { Attestor, DEV_SIGNING_KEY } from '../Attestor.js';
import { BundleSigner } from '../BundleSigner.js';
import type { SignedRunStatement, SigningOptions } from '../Attestor.js';

// ORACLE: D-13 (part 1) + audit P0 #8 — a bundle says which key signed it, inside the signature,
// and a run on the public development key says so out loud, once.

// Attestor.bundle only touches MemoryGraph via record(), which these tests do not exercise.
const stubGraph = { addNode: async () => undefined } as never;

const BUILDER: SlsaBuilder = { id: 'b@1', modelVersion: 'v' };
const INVOCATION: SlsaInvocation = {
  configSource: { uri: '', digest: { sha256: '' } },
  parameters: {},
  environment: {},
};

/** Signs a bundle with `signing` in a scratch directory and hands it, and the directory, to `body`. */
async function withBundle(
  signing: SigningOptions,
  body: (bundle: AttestationBundle, dir: string) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-key-'));
  try {
    const attestor = new Attestor(makeRunId('r-key'), stubGraph, dir, signing);
    const bundle = await attestor.bundle(BUILDER, INVOCATION, [], { status: 'Succeeded', unscheduled: [] });
    await body(bundle, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What anyone holding the public development key can do: claim a key source, and sign again. */
function resignedWithDevKey(bundle: AttestationBundle, keySource: KeySource): AttestationBundle {
  const { signature: _discarded, ...rest } = bundle;
  const claimed = { ...rest, keySource };
  return { ...claimed, signature: BundleSigner.signStatic(claimed, DEV_SIGNING_KEY) };
}

/** Runs `body` with process.stderr captured; returns its value and every chunk written to stderr. */
function captureStderr<T>(body: () => T): { value: T; written: string[] } {
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  try {
    return { value: body(), written };
  } finally {
    process.stderr.write = original;
  }
}

test('keySource: a bundle signed with a secret says "env", and verify reports it', async () => {
  await withBundle({ secret: 's3cret' }, (bundle) => {
    assert.equal(bundle.keySource, 'env');
    assert.deepEqual(Attestor.inspect(bundle, { secret: 's3cret' }), { valid: true, keySource: 'env', legacy: false });
    assert.equal(Attestor.verify(bundle, { secret: 's3cret' }), true);
  });
});

test('keySource: a bundle signed without a secret says "dev"; verify still passes and reports "dev"', async () => {
  await withBundle({}, async (bundle, dir) => {
    assert.equal(bundle.keySource, 'dev');
    assert.deepEqual(Attestor.inspect(bundle, {}), { valid: true, keySource: 'dev', legacy: false });
    assert.equal(Attestor.verify(bundle, { secret: 's3cret' }), false,
      'a dev-signed bundle does not pass a check against a real secret');

    // The persisted bundle, as a third party would read it, verifies the same way.
    const onDisk = JSON.parse(await readFile(path.join(dir, 'r-key.bundle.json'), 'utf8')) as SignedRunStatement;
    assert.equal(onDisk.predicate.keySource, 'dev');
    assert.deepEqual(Attestor.inspect(onDisk, {}), { valid: true, keySource: 'dev', legacy: false });
  });
});

test('keySource: an empty secret, or the development key itself, signs as "dev"', async () => {
  await withBundle({ secret: '' }, (bundle) => { assert.equal(bundle.keySource, 'dev'); });
  await withBundle({ secret: DEV_SIGNING_KEY }, (bundle) => { assert.equal(bundle.keySource, 'dev'); });
});

test('keySource is inside the signed payload: flipping it breaks the signature', async () => {
  await withBundle({ secret: 's3cret' }, (bundle) => {
    const flipped: AttestationBundle = { ...bundle, keySource: 'dev' };
    assert.equal(Attestor.verify(flipped, { secret: 's3cret' }), false);
    assert.equal(Attestor.verify(flipped, {}), false);
  });
});

test('a bundle re-signed with the public development key cannot pass as "env"', async () => {
  await withBundle({}, (bundle) => {
    // Control: the forger's signing is correct — an honest "dev" claim re-signed this way verifies.
    assert.equal(Attestor.verify(resignedWithDevKey(bundle, 'dev'), {}), true);

    const forged = resignedWithDevKey(bundle, 'env');
    assert.deepEqual(Attestor.inspect(forged, {}), { valid: false, keySource: 'dev', legacy: false },
      'the signature matches the dev key, but the claim does not name it');
    assert.equal(Attestor.verify(forged, { secret: 's3cret' }), false);
  });
});

test('verify answers invalid, rather than throwing, for a truncated signature', async () => {
  await withBundle({ secret: 's3cret' }, (bundle) => {
    const truncated: AttestationBundle = { ...bundle, signature: bundle.signature.slice(0, 10) };
    assert.equal(Attestor.verify(truncated, { secret: 's3cret' }), false);
  });
});

test('resolveSigningSecret: MAF_SIGNING_KEY unset writes exactly one warning line to stderr', () => {
  const { value: signing, written } = captureStderr(() => Attestor.resolveSigningSecret({}));

  assert.deepEqual(signing, {}, 'no secret: the Attestor will use the development key');
  assert.equal(written.length, 1, 'one write');
  const line = written[0] ?? '';
  assert.equal(line.split('\n').length, 2, 'one line, newline-terminated');
  assert.ok(line.endsWith('\n'));
  assert.match(line, /WARNING/);
  assert.match(line, /MAF_SIGNING_KEY/);
  assert.match(line, /public development key/);
  assert.match(line, /forged/);
});

test('resolveSigningSecret: an empty or development-key MAF_SIGNING_KEY warns the same way', () => {
  for (const value of ['', DEV_SIGNING_KEY]) {
    const { value: signing, written } = captureStderr(() => Attestor.resolveSigningSecret({ MAF_SIGNING_KEY: value }));
    assert.deepEqual(signing, {}, `MAF_SIGNING_KEY=${JSON.stringify(value)} is no secret`);
    assert.equal(written.length, 1);
    assert.match(written[0] ?? '', /forged/);
  }
});

test('resolveSigningSecret: MAF_SIGNING_KEY set passes the secret through and writes nothing', () => {
  const { value: signing, written } = captureStderr(() => Attestor.resolveSigningSecret({ MAF_SIGNING_KEY: 's3cret' }));
  assert.deepEqual(signing, { secret: 's3cret' });
  assert.deepEqual(written, []);
});

test('the Attestor itself never warns, so a call site that resolves once prints one line in all', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-key-'));
  try {
    const { written } = captureStderr(() => new Attestor(makeRunId('r-quiet'), stubGraph, dir, {}));
    assert.deepEqual(written, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a 0.2.0 bundle with no keySource verifies against the key supplied, and says it is legacy', async () => {
  await withBundle({ secret: 's3cret' }, (signed) => {
    // What a 0.2.0 Attestor wrote: the same payload without keySource, signed over that payload.
    const { keySource: _k, signature: _s, ...rest } = signed as AttestationBundle & { keySource?: KeySource };
    const legacySig = crypto.createHmac('sha256', 's3cret').update(JSON.stringify(rest)).digest('hex');
    const legacy = { ...rest, signature: legacySig } as unknown as AttestationBundle;

    assert.deepEqual(Attestor.inspect(legacy, { secret: 's3cret' }), { valid: true, keySource: 'env', legacy: true });
    assert.equal(Attestor.verify(legacy, {}), false, 'not the dev key');
    assert.equal(new BundleSigner('s3cret').verify(legacy), true, 'the exported signer agrees');
  });
});

test('the exported BundleSigner applies the keySource rule too', async () => {
  await withBundle({ secret: 's3cret' }, (bundle) => {
    assert.equal(new BundleSigner('s3cret').verify(bundle), true);
    assert.equal(BundleSigner.verifyStatic(bundle, 's3cret'), true);
    // Re-signed with the public key while still claiming "env": the signature matches the dev
    // key, and the claim does not, so it is refused — by both verifiers.
    const forged = resignedWithDevKey(bundle, 'env');
    assert.equal(BundleSigner.verifyStatic(forged, DEV_SIGNING_KEY), false);
    assert.equal(Attestor.verify(forged, {}), false);
  });
});
