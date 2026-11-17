import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GUARDED_CORPUS_FILES, CorpusChangedError, assertCorpusUnchanged, changedCorpusFiles,
  fingerprintCorpus,
} from '../index.js';

// ORACLE (R7-L1): the three files a held-out verdict rests on — the hidden store, the split and the
// calibration — are fingerprinted when the session opens. Removing the hash, comparing the wrong
// file, or treating an absent file as unchanged would let an agent's own write go unnoticed: the
// held-out counts would then describe a yardstick the session never measured.

async function corpus(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'maf-corpus-guard-'));
}

test('R7-L1: the guarded files are the store, the split and the calibration', () => {
  assert.deepEqual([...GUARDED_CORPUS_FILES], ['hidden-store.json', 'splits.json', 'calibration.json']);
});

test('R7-L1: an unchanged corpus reports no change, and an absent file is not a change', async () => {
  const root = await corpus();
  try {
    const before = await fingerprintCorpus(root);
    assert.deepEqual(before, { 'hidden-store.json': null, 'splits.json': null, 'calibration.json': null });
    assert.deepEqual(await changedCorpusFiles(root, before), []);
    await assertCorpusUnchanged(root, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('R7-L1: a rewritten guarded file is named, and only that one', async () => {
  const root = await corpus();
  try {
    await writeFile(path.join(root, 'splits.json'), '{"version":1}', 'utf8');
    await writeFile(path.join(root, 'calibration.json'), '{}', 'utf8');
    const before = await fingerprintCorpus(root);
    await writeFile(path.join(root, 'splits.json'), '{"version":1,"heldOut":[]}', 'utf8');

    assert.deepEqual(await changedCorpusFiles(root, before), ['splits.json']);
    await assert.rejects(() => assertCorpusUnchanged(root, before), (err: unknown) => {
      assert.ok(err instanceof CorpusChangedError);
      assert.deepEqual([...err.changed], ['splits.json']);
      assert.match(err.message, /splits\.json changed under the corpus root/);
      assert.match(err.message, /re-run from a clean corpus/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('R7-L1: a file that appears mid-session is a change, and so is one that disappears', async () => {
  const root = await corpus();
  try {
    const before = await fingerprintCorpus(root);
    await writeFile(path.join(root, 'hidden-store.json'), '{"version":2}', 'utf8');
    assert.deepEqual(await changedCorpusFiles(root, before), ['hidden-store.json']);

    const present = await fingerprintCorpus(root);
    await rm(path.join(root, 'hidden-store.json'));
    assert.deepEqual(await changedCorpusFiles(root, present), ['hidden-store.json']);

    await writeFile(path.join(root, 'hidden-store.json'), '{"version":2}', 'utf8');
    await writeFile(path.join(root, 'calibration.json'), '{}', 'utf8');
    await assert.rejects(() => assertCorpusUnchanged(root, before), /hidden-store\.json, calibration\.json changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
