import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { refusePrototypeKey } from '@maf/types';
import type { AssertOp, CheckExpectation, SerializedValue } from './hiddenCheck.js';

/**
 * R6-H1 (D-57): the hidden checks and the reference solutions are the two things a golden run must
 * not let the agent read. A plain file under the fixture directory is readable by any code the
 * agent runs — the verifier demonstrated exactly that with `test.run` and `/proc/<pid>/cwd` — and
 * there is no sandbox yet to stop it. So they are not stored as plain files at all: one file in
 * the corpus root holds each of them gzip-compressed and base64-encoded, and the runner decodes a
 * task's checks into a private directory only after the agent's session has ended.
 *
 * This is cheap prevention, not prevention. The store is still a file the agent's code can read
 * and decode; the canary tokens below are what make such a read visible. See `docs/SECURITY.md`
 * and the D-57 entry in `docs/changes/WP-3.7b.md` for the limit, stated plainly.
 */
export const HIDDEN_STORE_FILE = 'hidden-store.json';
/**
 * R7-H2: version 2 adds the `expectations` section. A check's expected values are held by the
 * checker process and compared there; they cannot travel with the check into the child process
 * that loads the solution. A version-1 store has none, so it cannot score a task through the
 * boundary and is refused rather than read as one that can.
 */
export const HIDDEN_STORE_VERSION = 2;
export const HIDDEN_STORE_ENCODING = 'gzip+base64';

/**
 * Every hidden file carries a line beginning with this prefix. The token is derived from the task
 * id and the file's fixture-relative path, so it is stable across rebuilds and unique per file.
 * A run that records one of these (in its output, a tool call or the worktree it leaves) read a
 * hidden file, and the attempt is voided.
 */
export const CANARY_PREFIX = 'maf-hidden-canary-';

/** The comment syntax each supported hidden-file extension is injected with. */
const COMMENT_PREFIX: Record<string, string> = {
  '.js': '//', '.mjs': '//', '.cjs': '//', '.ts': '//', '.mts': '//', '.cts': '//',
  '.py': '#', '.sh': '#', '.rb': '#',
};

export interface HiddenStoreFile {
  version: 2;
  encoding: 'gzip+base64';
  /** task id → fixture-relative path (`.checks/…`) → base64(gzip(bytes)). */
  checks: Record<string, Record<string, string>>;
  /** task id → fixture-relative path (`.reference/…`) → base64(gzip(bytes)). */
  references: Record<string, Record<string, string>>;
  /**
   * R7-H2: task id → the check or protected test it scores → base64(gzip(JSON expectations)).
   * The key is the check's store path (`.checks/test.js`) for a held-out task and the visible
   * test's fixture path (`test.js`) for a train task.
   */
  expectations: Record<string, Record<string, string>>;
}

export function hiddenStorePath(corpusRoot: string, file: string = HIDDEN_STORE_FILE): string {
  return path.isAbsolute(file) ? file : path.join(corpusRoot, file);
}

/** The unique marker for one hidden file: `maf-hidden-canary-<16 hex of sha256(task id, path)>`. */
export function canaryToken(taskId: string, rel: string): string {
  return CANARY_PREFIX + crypto.createHash('sha256').update(`${taskId}\u0000${rel}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Prepends the canary as a comment line. The file's extension decides the comment syntax, and an
 * extension this build does not know is refused rather than encoded without its marker: a hidden
 * file with no canary is a file whose leak nothing would detect.
 */
export function injectCanary(text: string, taskId: string, rel: string): string {
  const lead = COMMENT_PREFIX[path.extname(rel).toLowerCase()];
  if (lead === undefined)
    throw new Error(
      `hidden store: ${rel} has no known comment syntax, so its canary cannot be injected; ` +
      `add the extension to COMMENT_PREFIX before encoding it.`,
    );
  if (text.includes(CANARY_PREFIX))
    throw new Error(`hidden store: ${rel} already carries a canary; encode the original, not an encoded copy.`);
  return `${lead} ${canaryToken(taskId, rel)}\n${text}`;
}

export function encodeHidden(text: string): string {
  return gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64');
}

export function decodeHidden(encoded: string): Buffer {
  return gunzipSync(Buffer.from(encoded, 'base64'));
}

function assertEntryMap(value: unknown, section: string): asserts value is Record<string, Record<string, string>> {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`hidden store: "${section}" must be an object of task id to paths, not ${typeof value}.`);
  for (const [taskId, files] of Object.entries(value as Record<string, unknown>)) {
    if (files === null || typeof files !== 'object' || Array.isArray(files))
      throw new Error(`hidden store: ${section}.${taskId} must be an object of path to encoded bytes.`);
    for (const [rel, encoded] of Object.entries(files as Record<string, unknown>)) {
      if (typeof encoded !== 'string' || encoded === '')
        throw new Error(`hidden store: ${section}.${taskId}.${rel} is not a non-empty encoded string.`);
    }
  }
}

/**
 * The store for a corpus. An absent file is an empty store — a corpus with no hidden checks needs
 * none — but a malformed one is refused: a corrupt store that silently decodes to nothing would
 * score every task against no checks at all.
 */
export async function loadHiddenStore(corpusRoot: string, file?: string): Promise<HiddenStoreFile> {
  const storePath = hiddenStorePath(corpusRoot, file);
  let text: string;
  try {
    text = await readFile(storePath, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT')
      return { version: HIDDEN_STORE_VERSION, encoding: HIDDEN_STORE_ENCODING, checks: {}, references: {}, expectations: {} };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, refusePrototypeKey);
  } catch (err) {
    throw new Error(`hidden store: ${storePath} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const o = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  if (o === undefined || o['version'] !== HIDDEN_STORE_VERSION)
    throw new Error(`hidden store: ${storePath} must be version ${HIDDEN_STORE_VERSION}.`);
  if (o['encoding'] !== HIDDEN_STORE_ENCODING)
    throw new Error(
      `hidden store: ${storePath} declares encoding ${JSON.stringify(o['encoding'])}; this build reads ` +
      `${JSON.stringify(HIDDEN_STORE_ENCODING)}.`,
    );
  assertEntryMap(o['checks'], 'checks');
  assertEntryMap(o['references'], 'references');
  assertEntryMap(o['expectations'], 'expectations');
  return {
    version: HIDDEN_STORE_VERSION, encoding: HIDDEN_STORE_ENCODING,
    checks: (o['checks'] ?? {}) as Record<string, Record<string, string>>,
    references: (o['references'] ?? {}) as Record<string, Record<string, string>>,
    expectations: (o['expectations'] ?? {}) as Record<string, Record<string, string>>,
  };
}

/** One hidden file's decoded text, or a sentence when the store does not hold it. */
export function readHiddenFile(
  store: HiddenStoreFile, section: 'checks' | 'references', taskId: string, rel: string,
): string {
  const encoded = store[section][taskId]?.[rel];
  if (encoded === undefined)
    throw new Error(
      `hidden store: ${section} for ${taskId} has no ${JSON.stringify(rel)}; the store and the corpus disagree.`,
    );
  const bytes = decodeHidden(encoded);
  const text = bytes.toString('utf8');
  if (!text.includes(canaryToken(taskId, rel)))
    throw new Error(
      `hidden store: ${section} for ${taskId} at ${JSON.stringify(rel)} carries no canary; ` +
      'an unmarked hidden file is one whose leak nothing would detect.',
    );
  return text;
}

/** The paths a task's store section holds, sorted, so callers can compare without ordering. */
export function hiddenPaths(store: HiddenStoreFile, section: 'checks' | 'references', taskId: string): string[] {
  return Object.keys(store[section][taskId] ?? {}).sort();
}

/** The expectations a task holds, keyed by the check or protected test they score. */
export function expectationPaths(store: HiddenStoreFile, taskId: string): string[] {
  return Object.keys(store.expectations[taskId] ?? {}).sort();
}

/**
 * R7-H2: the expected values for one check. They never leave the checker process: the child that
 * loads the solution is sent the check's source alone. A store entry that is not an array of
 * well-formed expectations is refused — a malformed one would compare a run against nothing.
 */
export function readExpectations(
  store: HiddenStoreFile, taskId: string, rel: string,
): CheckExpectation[] {
  const encoded = store.expectations[taskId]?.[rel];
  if (encoded === undefined)
    throw new Error(
      `hidden store: expectations for ${taskId} at ${JSON.stringify(rel)} are missing; ` +
      'a task scored through the process boundary needs them.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeHidden(encoded).toString('utf8'), refusePrototypeKey);
  } catch (err) {
    throw new Error(`hidden store: expectations for ${taskId} at ${JSON.stringify(rel)} are not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed))
    throw new Error(`hidden store: expectations for ${taskId} at ${JSON.stringify(rel)} must be an array.`);
  const out: CheckExpectation[] = [];
  for (const [i, raw] of parsed.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`hidden store: expectation ${i} for ${taskId} is not an object.`);
    const o = raw as Record<string, unknown>;
    if (typeof o['op'] !== 'string' || !KNOWN_ASSERT_OPS.has(o['op']))
      throw new Error(`hidden store: expectation ${i} for ${taskId} names an unknown assertion ${JSON.stringify(o['op'])}.`);
    if (typeof o['loose'] !== 'boolean')
      throw new Error(`hidden store: expectation ${i} for ${taskId} must say whether the assertion was loose.`);
    const rec: CheckExpectation = { op: o['op'] as AssertOp, loose: o['loose'] };
    if (o['e'] !== undefined) rec.e = o['e'] as SerializedValue;
    out.push(rec);
  }
  return out;
}

const KNOWN_ASSERT_OPS = new Set(['equal', 'notEqual', 'deepEqual', 'notDeepEqual', 'ok', 'throws', 'rejects']);

/**
 * The strings whose presence in anything a run recorded means it saw the hidden material: any
 * canary, and the store's own file name (a read that stops at listing or opening it still leaves
 * the name in the record).
 */
export function hiddenStoreMarkers(): readonly string[] {
  return [CANARY_PREFIX, HIDDEN_STORE_FILE, ...HIDDEN_DIRS];
}

/**
 * R7-H2b: the two directory names the hidden material is written under, as they appear in a path.
 * A run that names one of them is looking for the checks or the references; no fixture ships
 * either directory, so the only way such a string reaches the record is from code that went after
 * them. The trailing separator keeps an ordinary identifier like `checks` out of the scan.
 */
const HIDDEN_DIRS = ['.checks/', '.reference/'] as const;

/** Every marker that appears in `text`, with the label of the surface it was found in. */
export function findHiddenMarkers(text: string, label: string): string[] {
  return hiddenStoreMarkers().filter((m) => text.includes(m)).map((m) => `${m} in ${label}`);
}
