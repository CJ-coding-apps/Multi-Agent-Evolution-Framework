import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GoldenTask } from './GoldenTask.js';
import { CANARY_PREFIX, hiddenPaths, loadHiddenStore, readHiddenFile } from './hiddenStore.js';
import type { HiddenStoreFile } from './hiddenStore.js';
import type { CorpusSplits } from './splits.js';

/**
 * R6-H2 / R7-M1: round 5 grew the pool with fifteen tasks that were byte-identical copies of
 * fifteen new train tasks, and nothing noticed. A held-out candidate that is a copy of a task the
 * evolver was trained on is not a held-out task at all: it measures memorisation of the train split
 * and calls it generalisation. This module is the guard.
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
 *   * and, for any fixture file pair with enough shared content to mean something, the similarity of
 *     their identifier-normalised token sequences.
 *
 * Hidden files carry a canary whose token is derived from the task id, so the canary line is
 * removed before their text is compared; otherwise two identical references would never match.
 */

/**
 * R7-M1: the round-6 metric compared token *sets* of raw words, so a renamed copy read as a
 * different task. The verifier measured two pool tasks at 0.83 and 0.78 against their train
 * sources, under a 0.9 floor — both missed. The metric is now a sequence comparison on
 * identifier-normalised tokens:
 *
 *   * comments are gone and whitespace is flattened (`normalizeSource`);
 *   * every string literal is `STR`, every number `NUM`, every non-keyword identifier `ID`;
 *     keywords and punctuation stay, because they carry the structure;
 *   * the two token streams are compared by the Dice coefficient of their 4-gram multisets, so
 *     local order matters and a renamed variable does not change a single token.
 *
 * Identifiers are collapsed to one placeholder, not numbered by first appearance. A positional
 * scheme was measured and rejected: renaming a module so that `const { tap } = require('./m')`
 * becomes `const { tax, discount } = require('./m')` adds one binding, shifts every later
 * placeholder, and hides a copy that is otherwise identical (the round-6 `pool-cart-discount/cart.js`,
 * since replaced, scored 0.653 positionally and 0.861 here). Collapsing the name is the
 * rename-invariant half; the 4-gram window is the ordering half.
 */

/** A pair at or above this similarity is a copy with edits, and fails the guard. */
export const NEAR_COPY_THRESHOLD = 0.85;
/** A pair at or above this similarity is worth a person's look, and does not fail. */
export const NEAR_COPY_REVIEW_THRESHOLD = 0.7;
/**
 * The evidence floor: a pair is judged only when it shares at least this many 4-grams (so at least
 * `NEAR_COPY_MIN_SHARED_GRAMS + SHINGLE_SIZE - 1` aligned tokens). Every task in the seed corpus is
 * a tiny function, and a two-line `function f(x) { return x; }` stub is textually identical to
 * every other stub once names are collapsed — those pairs are boilerplate, not a copied solution.
 * The floor is on shared content, not on file size, so a small file that really is a copy (its
 * whole body aligned) is still judged; a small file with nothing to share is not.
 */
export const NEAR_COPY_MIN_SHARED_GRAMS = 20;
/** The shingle width, in tokens. */
export const SHINGLE_SIZE = 4;

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'module', 'new', 'null', 'of', 'return',
  'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var',
  'void', 'while', 'with', 'yield', 'exports', 'require',
]);

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

const TOKEN_RE = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\d+(?:\.\d+)?|[A-Za-z_$][\w$]*|\S/g;

/**
 * The identifier-normalised token sequence of a source file. Strings, numbers and identifiers are
 * replaced by their class; keywords and punctuation are kept verbatim.
 */
export function identifierTokens(text: string): string[] {
  const tokens: string[] = [];
  // A `/g` match yields the matched text, not capture groups: `token` is the whole lexeme.
  for (const token of normalizeSource(text).match(TOKEN_RE) ?? []) {
    if (token.startsWith("'") || token.startsWith('"') || token.startsWith('`')) tokens.push('STR');
    else if (/^\d/.test(token)) tokens.push('NUM');
    else if (/^[A-Za-z_$][\w$]*$/.test(token)) tokens.push(KEYWORDS.has(token) ? token : 'ID');
    else tokens.push(token);
  }
  return tokens;
}

/** The multiset of `size`-token windows in a token sequence, as window text → count. */
export function shingles(tokens: readonly string[], size = SHINGLE_SIZE): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + size <= tokens.length; i += 1) {
    const window = tokens.slice(i, i + size).join(' ');
    counts.set(window, (counts.get(window) ?? 0) + 1);
  }
  return counts;
}

const totalCount = (counts: ReadonlyMap<string, number>): number => {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
};

/** How many 4-grams two multisets share, counting multiplicity. */
export function sharedShingles(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let shared = 0;
  for (const [window, count] of a) {
    const other = b.get(window);
    if (other !== undefined) shared += Math.min(count, other);
  }
  return shared;
}

/**
 * Dice similarity of two token sequences, and the number of shingles they share. 0 when either
 * sequence is too short to carry a single window.
 */
export function sequenceSimilarity(
  a: readonly string[], b: readonly string[], size = SHINGLE_SIZE,
): { similarity: number; shared: number } {
  const left = shingles(a, size);
  const right = shingles(b, size);
  const sizeA = totalCount(left);
  const sizeB = totalCount(right);
  if (sizeA === 0 || sizeB === 0) return { similarity: 0, shared: 0 };
  const shared = sharedShingles(left, right);
  return { similarity: (2 * shared) / (sizeA + sizeB), shared };
}

export type DuplicateKind =
  | 'file' | 'normalized' | 'hidden-check' | 'hidden-reference' | 'near-copy' | 'near-copy-review';

export interface DuplicateFinding {
  kind: DuplicateKind;
  /** The task outside the train split (held-out or pool). */
  heldOut: string;
  /** The train task it duplicates. */
  train: string;
  detail: string;
}

export interface DuplicateReport {
  /** Copies: a non-empty list fails the guard. */
  findings: DuplicateFinding[];
  /**
   * Pairs close enough to be worth a look but below the failure floor. Advisory: the guard passes
   * with a non-empty list, and the CLI prints it.
   */
  reviews: DuplicateFinding[];
  /** How many non-train tasks were compared, and against how many train tasks. */
  heldOutTasks: number;
  trainTasks: number;
  /** The highest token similarity any held-out/train file pair with enough shared content reached. */
  maxSimilarity: number;
  threshold: number;
  reviewThreshold: number;
  minShared: number;
}

interface FixtureFile {
  rel: string;
  text: string;
  hash: string;
  normalized: string;
  normalizedHash: string;
  tokens: string[];
  /** The visible test a task protects is scaffold, not solution: compared for bytes, not similarity. */
  protected: boolean;
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
  const protectedFiles = new Set(task.mustNotModify ?? []);
  // Defensive: a plaintext hidden directory in a fixture is readable by the agent (R6-H1) and is
  // not a fixture file; it is ignored here and reported by the reference proof instead.
  const hiddenSegment = (rel: string): boolean =>
    rel.split('/').some((segment) => segment === '.checks' || segment === '.reference');
  for (const rel of await walkFiles(corpusRoot, fixtureDir)) {
    if (hiddenSegment(rel)) continue;
    const text = await readFile(path.join(corpusRoot, rel), 'utf8');
    const normalized = normalizeSource(text);
    const fileRel = path.relative(fixtureDir, rel);
    files.push({
      rel: fileRel, text, hash: sha256(text), normalized,
      normalizedHash: sha256(normalized), tokens: identifierTokens(text),
      protected: protectedFiles.has(fileRel),
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
 * caller fails on a non-empty `findings`; `reviews` is advisory. The ceiling is reported so the
 * threshold is a number the corpus was measured against, not a guess.
 */
export async function findHeldOutDuplicates(
  corpusRoot: string, corpus: readonly GoldenTask[],
  splits: Pick<CorpusSplits, 'train' | 'heldOut' | 'pool'>,
  opts: { hiddenStore?: string; threshold?: number; reviewThreshold?: number } = {},
): Promise<DuplicateReport> {
  const threshold = opts.threshold ?? NEAR_COPY_THRESHOLD;
  const reviewThreshold = opts.reviewThreshold ?? NEAR_COPY_REVIEW_THRESHOLD;
  const store = await loadHiddenStore(corpusRoot, opts.hiddenStore);
  const byId = new Map(corpus.map((task) => [task.id, task]));
  const train = splits.train.map((id) => byId.get(id)).filter((t): t is GoldenTask => t !== undefined);
  const heldOut = [...splits.heldOut, ...(splits.pool ?? [])]
    .map((id) => byId.get(id)).filter((t): t is GoldenTask => t !== undefined);
  const fingerprints = new Map<string, Fingerprint>();
  for (const task of [...train, ...heldOut])
    fingerprints.set(task.id, await fingerprint(corpusRoot, task, store));

  const findings: DuplicateFinding[] = [];
  const reviews: DuplicateFinding[] = [];
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
          // A protected file is the task's own visible test — scaffold the agent cannot change,
          // and since R7-H2 not what scores the run. Two train/pool tasks may share that template;
          // it is not a leaked solution, so it is compared for bytes above but not for similarity.
          if (a.protected || b.protected) continue;
          const { similarity, shared } = sequenceSimilarity(a.tokens, b.tokens);
          if (shared < NEAR_COPY_MIN_SHARED_GRAMS) continue;
          if (similarity > maxSimilarity) maxSimilarity = similarity;
          const detail = `${a.rel} and ${reference.id}/${b.rel} share ${similarity.toFixed(3)} ` +
            `of their identifier-normalised 4-grams (${shared} shared)`;
          if (similarity >= threshold)
            findings.push({ kind: 'near-copy', heldOut: candidate.id, train: reference.id, detail });
          else if (similarity >= reviewThreshold)
            reviews.push({ kind: 'near-copy-review', heldOut: candidate.id, train: reference.id, detail });
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
    findings, reviews, heldOutTasks: heldOut.length, trainTasks: train.length,
    maxSimilarity, threshold, reviewThreshold, minShared: NEAR_COPY_MIN_SHARED_GRAMS,
  };
}
