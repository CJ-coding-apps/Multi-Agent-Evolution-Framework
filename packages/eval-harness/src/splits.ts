import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '@maf/harness-config';
import { refusePrototypeKey } from '@maf/types';
import type { GoldenTask } from './GoldenTask.js';

/**
 * The corpus split (D-57). The evolver may see the `train` tasks — they are what it measures every
 * candidate on, and their results are written to the graph it digests. The `heldOut` tasks are the
 * yardstick it must not see: no candidate is selected on them, nothing about them enters the
 * evidence graph, and they are scored only after the run, on the harness that survived.
 *
 * The split is a separate committed file rather than a field on `corpus.json`, because
 * `computeCorpusSha` hashes the corpus — adding a field there would change the sha of every task
 * and invalidate the committed `baseline.json` for a change that does not alter a single fixture.
 */

export const SPLITS_FILE = 'splits.json';

export type SplitName = 'train' | 'held-out';

export interface CorpusSplits {
  version: 1;
  /** Task ids the evolver may see and be scored on. */
  train: string[];
  /** Task ids it may not: scored only on the final harness, never recorded as evidence. */
  heldOut: string[];
}

export interface LoadedSplits extends CorpusSplits {
  /** sha256 over the split definition; results from different splits do not compare. */
  sha: string;
}

export class SplitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitsError';
  }
}

/** sha256 over the canonical split definition, independent of key order and whitespace. */
export function computeSplitsSha(splits: CorpusSplits): string {
  return crypto.createHash('sha256')
    .update(canonicalJson({ version: splits.version, train: splits.train, heldOut: splits.heldOut }), 'utf8')
    .digest('hex');
}

/**
 * Read `<corpusRoot>/splits.json` and prove it is a partition of the corpus: every id exists,
 * no id appears twice, and every task is on exactly one side. A split that leaves a task out
 * silently shrinks the yardstick; one that names a task twice makes "held-out" a lie for that
 * task, because the evolver was scored on it during the run too.
 */
export async function loadSplits(
  corpusRoot: string, corpus: readonly GoldenTask[],
): Promise<LoadedSplits> {
  const file = path.join(corpusRoot, SPLITS_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new SplitsError(
      `no ${SPLITS_FILE} at ${corpusRoot}. D-57 needs a committed train/held-out split; ` +
      'every corpus task must appear in exactly one of the two lists.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, refusePrototypeKey);
  } catch (err) {
    throw new SplitsError(`${file} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const o = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  if (o === undefined || o['version'] !== 1)
    throw new SplitsError(`${file}: version must be 1`);
  const known = new Set(corpus.map((t) => t.id));
  const lists: { train: string[]; 'held-out': string[] } = { train: [], 'held-out': [] };
  for (const [key, value] of [['train', o['train']], ['heldOut', o['heldOut']]] as const) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0))
      throw new SplitsError(`${file}: ${key} must be an array of task ids`);
    const ids = value as string[];
    for (const id of ids) {
      if (!known.has(id))
        throw new SplitsError(`${file}: ${key} names "${id}", which is not in the corpus at ${corpusRoot}`);
    }
    lists[key === 'train' ? 'train' : 'held-out'] = ids;
  }
  const both = lists.train.filter((id) => lists['held-out'].includes(id));
  if (both.length > 0)
    throw new SplitsError(`${file}: ${both.join(', ')} ${both.length === 1 ? 'is' : 'are'} on both sides of the split`);
  for (const [name, ids] of [['train', lists.train], ['held-out', lists['held-out']]] as const) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) throw new SplitsError(`${file}: ${name} names ${dupes.join(', ')} more than once`);
  }
  const missing = [...known].filter((id) => !lists.train.includes(id) && !lists['held-out'].includes(id));
  if (missing.length > 0)
    throw new SplitsError(`${file}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} in neither split`);
  if (lists.train.length === 0 || lists['held-out'].length === 0)
    throw new SplitsError(`${file}: both sides need at least one task (train ${lists.train.length}, held-out ${lists['held-out'].length})`);

  const splits: CorpusSplits = { version: 1, train: lists.train, heldOut: lists['held-out'] };
  return { ...splits, sha: computeSplitsSha(splits) };
}
