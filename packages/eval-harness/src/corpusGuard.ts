import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CALIBRATION_FILE } from './calibration.js';
import { HIDDEN_STORE_FILE } from './hiddenStore.js';
import { SPLITS_FILE } from './splits.js';

/**
 * R7-L1 (round-6 finding R6-L1): the residual says a determined program can *read* the hidden
 * material; with no sandbox it can also *write* the three files a verdict rests on during a train
 * attempt — `hidden-store.json` (the checks, references and expectations), `splits.json` (which
 * tasks are held out) and `calibration.json` (the measurement the yardstick derives from). The
 * cheap mitigation is not a fence but a tripwire: remember their bytes when the session starts and
 * refuse to score the held-out split if any of them is different when the gate runs.
 *
 * The fingerprints are sha256 over each file's bytes; an absent file is `null`, so a file that
 * appears mid-session is a change too. The guard is deliberately per-session, not per-run: the
 * question is whether the corpus the verdict is about is the one the session began with.
 */
export const GUARDED_CORPUS_FILES = [HIDDEN_STORE_FILE, SPLITS_FILE, CALIBRATION_FILE] as const;

export type GuardedCorpusFile = (typeof GUARDED_CORPUS_FILES)[number];

/** sha256 per guarded file, or `null` where the file is absent. */
export type CorpusFingerprints = Record<GuardedCorpusFile, string | null>;

export class CorpusChangedError extends Error {
  readonly changed: readonly GuardedCorpusFile[];
  constructor(changed: readonly GuardedCorpusFile[]) {
    super(
      `${changed.join(', ')} changed under the corpus root since the session started. A held-out ` +
      'verdict is about the yardstick the session began with, so a corpus edited during it cannot ' +
      'produce one; re-run from a clean corpus.',
    );
    this.name = 'CorpusChangedError';
    this.changed = changed;
  }
}

export async function fingerprintCorpus(corpusRoot: string): Promise<CorpusFingerprints> {
  const out = {} as CorpusFingerprints;
  for (const name of GUARDED_CORPUS_FILES) {
    try {
      out[name] = createHash('sha256')
        .update(await readFile(path.join(corpusRoot, name)))
        .digest('hex');
    } catch {
      out[name] = null;
    }
  }
  return out;
}

/** The guarded files whose bytes differ from `before`, in the order `GUARDED_CORPUS_FILES` names. */
export async function changedCorpusFiles(
  corpusRoot: string, before: CorpusFingerprints,
): Promise<GuardedCorpusFile[]> {
  const after = await fingerprintCorpus(corpusRoot);
  return GUARDED_CORPUS_FILES.filter((name) => before[name] !== after[name]);
}

/** Throws `CorpusChangedError` naming every guarded file that changed since `before`. */
export async function assertCorpusUnchanged(
  corpusRoot: string, before: CorpusFingerprints,
): Promise<void> {
  const changed = await changedCorpusFiles(corpusRoot, before);
  if (changed.length > 0) throw new CorpusChangedError(changed);
}
