import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MemoryGraph } from '@maf/memory-graph';
import { makeRunId } from '@maf/types';
import { Attestor } from '@maf/attestation';
import type { SigningOptions } from '@maf/attestation';
import { attestVerify } from '../commands/attest.js';

// ORACLE: D-13 (part 2) — `maf attest verify <bundle>` says valid, which key checked it, and how
// many subjects the statement names; it exits 1 with the reason on any change to the statement.

const MAIN = path.join(__dirname, '..', 'main.js');

/** A run with one subject, signed with `signing`, written where `run` writes it. Returns the file. */
async function signedBundle(dir: string, signing: SigningOptions): Promise<string> {
  const attestor = new Attestor(makeRunId('r-cli'), { addNode: async () => 'n' } as unknown as MemoryGraph, dir, signing);
  attestor.recordDiffHash('n1.diff', 'diff --git a/x b/x');
  await attestor.finalize(
    { id: 'b', modelVersion: 'v' },
    { configSource: { uri: '', digest: { sha256: '' } }, parameters: {}, environment: {} },
    [],
    { status: 'Succeeded', unscheduled: [] },
  );
  return path.join(dir, 'r-cli.bundle.json');
}

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-attest-cli-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The CLI as a user runs it, with MAF_SIGNING_KEY set to `key` or removed. */
function maf(args: string[], key: string | undefined): { status: number | null; stdout: string; stderr: string } {
  const { MAF_SIGNING_KEY: _inherited, ...env } = process.env;
  const result = spawnSync(process.execPath, [MAIN, ...args], {
    env: key === undefined ? env : { ...env, MAF_SIGNING_KEY: key },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('verify: a bundle signed with MAF_SIGNING_KEY is valid, says env, and counts its subjects', async () => {
  await withDir(async (dir) => {
    const file = await signedBundle(dir, { secret: 's3cret' });
    const outcome = await attestVerify(file, { secret: 's3cret' });
    assert.equal(outcome.failure, undefined);
    assert.deepEqual(outcome.lines, ['valid: true', 'keySource: env (checked against MAF_SIGNING_KEY)', 'subjects: 1']);
  });
});

test('verify: a dev-signed bundle is valid against the dev key, and says what that is worth', async () => {
  await withDir(async (dir) => {
    const outcome = await attestVerify(await signedBundle(dir, {}), {});
    assert.equal(outcome.failure, undefined);
    assert.equal(outcome.lines[0], 'valid: true');
    assert.match(outcome.lines[1] ?? '', /^keySource: dev \(.*public development key.*evidence of nothing\)$/);
  });
});

test('verify: an env bundle checked without the key fails, and the reason says which key to supply', async () => {
  await withDir(async (dir) => {
    const outcome = await attestVerify(await signedBundle(dir, { secret: 's3cret' }), {});
    assert.equal(outcome.lines[0], 'valid: false');
    assert.match(outcome.failure ?? '', /MAF_SIGNING_KEY\) signed it, and this check used the public development key: set MAF_SIGNING_KEY/);
  });
});

test('verify: a 0.2.1 bundle says legacy', async () => {
  await withDir(async (dir) => {
    const body = { runId: 'r-old', keySource: 'env', toolCalls: [], approvals: [], diffHashes: {}, outcome: { status: 'Succeeded', unscheduled: [] } };
    const signature = crypto.createHmac('sha256', 's3cret').update(JSON.stringify(body)).digest('hex');
    const file = path.join(dir, 'old.bundle.json');
    await writeFile(file, JSON.stringify({ ...body, signature }, null, 2), 'utf8');
    const outcome = await attestVerify(file, { secret: 's3cret' });
    assert.equal(outcome.failure, undefined);
    assert.equal(outcome.lines.at(-1), 'legacy: true (a 0.2.x bundle: custom JSON, not an in-toto Statement)');
  });
});

test('verify: a missing file or a file that is not a bundle fails with a sentence and no facts', async () => {
  await withDir(async (dir) => {
    const missing = await attestVerify(path.join(dir, 'nope.json'), {});
    assert.deepEqual(missing.lines, []);
    assert.match(missing.failure ?? '', /^Cannot read the bundle at .*nope\.json: .*ENOENT/);

    const file = path.join(dir, 'x.json');
    await writeFile(file, '{"runId":"r"}', 'utf8');
    const notBundle = await attestVerify(file, {});
    assert.match(notBundle.failure ?? '', /expected a string "signature", found undefined\. \(.*x\.json\)$/);
  });
});

test('maf attest verify: exit 0 on a bundle and on its key-reordered copy; exit 1 on a one-byte change', async () => {
  await withDir(async (dir) => {
    const file = await signedBundle(dir, { secret: 's3cret' });

    const ok = maf(['attest', 'verify', file], 's3cret');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'valid: true\nkeySource: env (checked against MAF_SIGNING_KEY)\nsubjects: 1\n');
    assert.equal(ok.stderr, '', 'a real key: no warning');

    // Re-serialized: the predicate's keys reversed, compact. Canonical JSON makes it the same statement.
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { predicate: Record<string, unknown> };
    const reversed = { ...parsed, predicate: Object.fromEntries(Object.entries(parsed.predicate).reverse()) };
    const reorderedFile = path.join(dir, 'reordered.json');
    await writeFile(reorderedFile, JSON.stringify(reversed), 'utf8');
    assert.equal(maf(['attest', 'verify', reorderedFile], 's3cret').status, 0);

    // One byte of the statement: the subject's digest, last hex digit.
    const text = await readFile(file, 'utf8');
    const at = text.indexOf('"sha256": "') + '"sha256": "'.length + 63;
    const flipped = text.slice(0, at) + (text[at] === '0' ? '1' : '0') + text.slice(at + 1);
    const tamperedFile = path.join(dir, 'tampered.json');
    await writeFile(tamperedFile, flipped, 'utf8');
    const bad = maf(['attest', 'verify', tamperedFile], 's3cret');
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /^valid: false\n/);
    assert.match(bad.stderr, /\[maf\] error: The signature does not match the bundle's content under a key of your own/);
  });
});

test('maf attest verify: with MAF_SIGNING_KEY unset it checks against the dev key and warns as run does', async () => {
  await withDir(async (dir) => {
    const result = maf(['attest', 'verify', await signedBundle(dir, {})], undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^valid: true\nkeySource: dev /);
    assert.equal(result.stderr.split('\n').filter((l) => /WARNING: MAF_SIGNING_KEY/.test(l)).length, 1);
  });
});
