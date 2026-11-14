import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GoldenTask } from './GoldenTask.js';
import { CANARY_PREFIX, hiddenPaths, loadHiddenStore, readHiddenFile } from './hiddenStore.js';
import type { HiddenStoreFile } from './hiddenStore.js';
import type { CorpusSplits } from './splits.js';

/**
 * R6-H2: round 5 grew the pool with fifteen tasks that were byte-identical copies of fifteen new
 * train tasks, and nothing noticed. A held-out candidate that is a copy of a task the evolver was
 * trained on is not a held-out task at all: it measures memorisation of the train split and calls
 * it generalisation. This module is the guard.
 *
 * It compares every task outside the train split — the held-out set and the pool, because a pool
 * task is a future held-out task — against every train task, on four exact signals and one
 * approximate one:
 *
 *   * a fixture file with the same bytes;
 *   * a fixture file with the same bytes after comments and whitespace are removed, so re-indenting
 *     a copy does not hide it;
 *   * a hidden check with the same text;
 *   * a reference solution with the same text;
 *   * and, for files too large to be boilerplate, token-set similarity at or above
 *     `NEAR_COPY_THRESHOLD`.
 *
 * Hidden files carry a canary whose token is derived from the task id, so the canary line is
 * removed before their text is compared; otherwise two identical references would never match.
 */

/**
 * The stated near-copy floor: a held-out file whose token set overlaps a train file's this heavily
 * is a copy with edits, not a different task. Files with fewer than `SIMILARITY_MIN_TOKENS` tokens
 * are not judged by similarity — a two-line module sharing `module.exports` is boilerplate, and the
 * exact hashes above already catch a byte or comment/whitespace copy.
 */
export const NEAR_COPY_THRESHOLD = 0.9;
export const SIMILARITY_MIN_TOKENS = 12;

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

/** A hidden file's text without its canary line, which differs by design between tasks. */
export function withoutCanary(text: string): string {
  const newline = text.indexOf('\n');
  return newline !== -1 && text.slice(0, newline).includes(CANARY_PREFIX) ? text.slice(newline + 1) : text;
}

/**
 * Source with block and line comments removed and every run of whitespace flattened to one space.
 * Deliberately textual: it does not parse, so a `//` inside a string literal loses its tail too. A
 * guard that is wrong in the cautious direction only flags a pair for a human to look at.
 */
export function normalizeSource(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(normalized: string): Set<string> {
  return new Set(normalized.toLowerCase().match(/[a-z0-9_$]+/g) ?? []);
}

/** Jaccard similarity of two token sets: |A∩B| / |A∪B|, 0 when either is empty. */
export function tokenSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export type DuplicateKind = 'file' | 'normalized' | 'hidden-check' | 'hidden-reference' | 'near-copy';

export interface DuplicateFinding {
  kind: DuplicateKind;
  /** The task outside the train split (held-out or pool). */
  heldOut: string;
  /** The train task it duplicates. */
  train: string;
  detail: string;
}

export interface DuplicateReport {
  findings: DuplicateFinding[];
  /** How many non-train tasks were compared, and against how many train tasks. */
  heldOutTasks: number;
  trainTasks: number;
  /** The highest token similarity any held-out/train file pair reached. */
  maxSimilarity: number;
  threshold: number;
}

interface FixtureFile {
  rel: string;
  text: string;
  hash: string;
  normalized: string;
  normalizedHash: string;
  tokens: Set<string>;
}

interface HiddenFile {
  section: 'checks' | 'references';
  rel: string;
  hash: string;
}

interface Fingerprint {
  files: FixtureFile[];
  hidden: HiddenFile[];
}

async function walkFiles(corpusRoot: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(path.join(corpusRoot, rel), { withFileTypes: true });
  for (const entry of entries) {
    const next = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(corpusRoot, next));
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

async function fingerprint(corpusRoot: string, task: GoldenTask, store: HiddenStoreFile): Promise<Fingerprint> {
  const files: FixtureFile[] = [];
  const fixtureDir = path.posix.normalize(task.repoFixture);
  // Defensive: a plaintext hidden directory in a fixture is readable by the agent (R6-H1) and is
  // not a fixture file; it is ignored here and reported by the reference proof instead.
  const hiddenSegment = (rel: string): boolean =>
    rel.split('/').some((segment) => segment === '.checks' || segment === '.reference');
  for (const rel of await walkFiles(corpusRoot, fixtureDir)) {
    if (hiddenSegment(rel)) continue;
    const text = await readFile(path.join(corpusRoot, rel), 'utf8');
    const normalized = normalizeSource(text);
    files.push({
      rel: path.relative(fixtureDir, rel), text, hash: sha256(text), normalized,
      normalizedHash: sha256(normalized), tokens: tokensOf(normalized),
    });
  }
  const hidden: HiddenFile[] = [];
  for (const section of ['checks', 'references'] as const) {
    for (const rel of hiddenPaths(store, section, task.id)) {
      hidden.push({ section, rel, hash: sha256(withoutCanary(readHiddenFile(store, section, task.id, rel))) });
    }
  }
  return { files, hidden };
}

/**
 * Every way a non-train task duplicates a train task, with the similarity ceiling observed. The
 * caller fails on a non-empty `findings`; the ceiling is reported so the threshold is a number the
 * corpus was measured against, not a guess.
 */
export async function findHeldOutDuplicates(
  corpusRoot: string, corpus: readonly GoldenTask[],
  splits: Pick<CorpusSplits, 'train' | 'heldOut' | 'pool'>,
  opts: { hiddenStore?: string; threshold?: number } = {},
): Promise<DuplicateReport> {
  const threshold = opts.threshold ?? NEAR_COPY_THRESHOLD;
  const store = await loadHiddenStore(corpusRoot, opts.hiddenStore);
  const byId = new Map(corpus.map((task) => [task.id, task]));
  const train = splits.train.map((id) => byId.get(id)).filter((t): t is GoldenTask => t !== undefined);
  const heldOut = [...splits.heldOut, ...(splits.pool ?? [])]
    .map((id) => byId.get(id)).filter((t): t is GoldenTask => t !== undefined);
  const fingerprints = new Map<string, Fingerprint>();
  for (const task of [...train, ...heldOut])
    fingerprints.set(task.id, await fingerprint(corpusRoot, task, store));

  const findings: DuplicateFinding[] = [];
  let maxSimilarity = 0;
  for (const candidate of heldOut) {
    const left = fingerprints.get(candidate.id);
    if (left === undefined) continue;
    for (const reference of train) {
      const right = fingerprints.get(reference.id);
      if (right === undefined) continue;
      for (const a of left.files) {
        for (const b of right.files) {
          if (a.hash === b.hash)
            findings.push({
              kind: 'file', heldOut: candidate.id, train: reference.id,
              detail: `${a.rel} is byte-identical to ${reference.id}/${b.rel}`,
            });
          else if (a.normalizedHash === b.normalizedHash && a.normalized !== '')
            findings.push({
              kind: 'normalized', heldOut: candidate.id, train: reference.id,
              detail: `${a.rel} is ${reference.id}/${b.rel} with comments or whitespace changed`,
            });
          if (a.tokens.size >= SIMILARITY_MIN_TOKENS && b.tokens.size >= SIMILARITY_MIN_TOKENS) {
            const similarity = tokenSimilarity(a.tokens, b.tokens);
            if (similarity > maxSimilarity) maxSimilarity = similarity;
            if (similarity >= threshold)
              findings.push({
                kind: 'near-copy', heldOut: candidate.id, train: reference.id,
                detail: `${a.rel} and ${reference.id}/${b.rel} share ${similarity.toFixed(3)} of their tokens`,
              });
          }
        }
      }
      for (const a of left.hidden) {
        for (const b of right.hidden) {
          if (a.section !== b.section || a.hash !== b.hash) continue;
          findings.push({
            kind: a.section === 'checks' ? 'hidden-check' : 'hidden-reference',
            heldOut: candidate.id, train: reference.id,
            detail: `${a.rel} is the same ${a.section === 'checks' ? 'check' : 'reference'} as ${reference.id}/${b.rel}`,
          });
        }
      }
    }
  }
  return {
    findings, heldOutTasks: heldOut.length, trainTasks: train.length,
    maxSimilarity, threshold,
  };
}
