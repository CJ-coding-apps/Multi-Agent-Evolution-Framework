/**
 * Secret redaction. Two tiers, because the two consumers have different fidelity
 * requirements:
 *
 *  - CREDENTIAL_PATTERNS — unambiguous API/LLM/cloud key & token & private-key
 *    FORMATS. These are redacted from the signed attestation bundle, the memory
 *    graph, and the result returned into history. Because redaction only replaces
 *    the matched credential substrings, the attestation stays BYTE-FAITHFUL to the
 *    raw tool output except for genuine secrets — it is evidence, so nothing else
 *    is touched. `redactCredentials` / `redactSecrets` do exactly this.
 *
 *  - ASSIGNMENT_PATTERNS — broader `api_key = …` / `password: …` heuristics that
 *    can match legitimate reviewed content. These would mangle an evidence record,
 *    so they are applied ONLY to the model-facing history/transcript (via
 *    `redactText`), never to the attestation.
 *
 * Labels are stable ([REDACTED:<label>]).
 */

/** High-confidence credential FORMATS — safe to strip from evidence (attestation). */
export const CREDENTIAL_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'aws-access-key',  re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'anthropic-key',   re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'openai-key',      re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: 'google-api-key',  re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'github-pat',      re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { label: 'slack-token',     re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'bearer',          re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi },
  { label: 'private-key',     re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
];

/** Heuristic secret-assignment patterns — model-facing streams ONLY (not evidence). */
export const ASSIGNMENT_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'generic-secret',  re: /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^\s"']{12,}/gi },
];

/** Back-compat alias: the full pattern list (credentials + assignment heuristics). */
export const DEFAULT_PATTERNS = [...CREDENTIAL_PATTERNS, ...ASSIGNMENT_PATTERNS];

function apply(
  text: string,
  patterns: ReadonlyArray<{ label: string; re: RegExp }>,
  extra: readonly RegExp[],
): string {
  let out = text;
  for (const p of patterns) out = out.replace(p.re, `[REDACTED:${p.label}]`);
  for (const re of extra) out = out.replace(re, '[REDACTED:custom]');
  return out;
}

/**
 * Redact genuine credential FORMATS only. Byte-faithful otherwise — this is what
 * the signed attestation and memory graph use, so the record is evidence-grade.
 */
export function redactCredentials(text: string, extra: readonly RegExp[] = []): string {
  return apply(text, CREDENTIAL_PATTERNS, extra);
}

/** Alias used by non-processor callers (gatedExec) to make intent obvious. */
export const redactSecrets = redactCredentials;

/** Redact credentials AND broader assignment heuristics — model-facing streams only. */
export function redactText(text: string, extra: readonly RegExp[] = []): string {
  return apply(text, DEFAULT_PATTERNS, extra);
}

/**
 * Absolute POSIX, Windows-drive and UNC paths as they occur inside a message.
 *
 * Two shapes:
 *  - **Quoted** — a path an author put between quotes may contain spaces, and the quotes are the
 *    boundary: `"/Users/John Smith/proj/.env"` is one path, not a head and a leaked tail.
 *  - **Unquoted** — from the start of the text, or after whitespace, a quote, an opening bracket,
 *    `=`, a backtick or a colon, running to the next whitespace or quote. A path is required to
 *    have a body. The POSIX form does not take a leading `//`, so a URL after `https:` is not read
 *    as a path.
 *
 *    An unquoted path may contain spaces (`C:\Program Files\…`), and stopping at the first one
 *    leaves the tail behind — a refusal reason is free text, so nothing bounds the path but the
 *    path itself (WP-3.7b R3-L2). The generic pattern continues over a space-separated token that
 *    still carries a separator (`b/secret.txt`, `Files\x\key.pem`). `maskSpacedPaths` covers the
 *    other shape, a spaced filename whose last word carries only an extension
 *    (`/home/u/my secret notes.txt`).
 *
 *    R2-L2: that continuation used to run to the last filename-looking word in the sentence, so
 *    `policy denied /etc/passwd for coder see policy.yaml` masked the prose too. It now crosses at
 *    most three words and ends at the first path-shaped word; and a head that already names a file
 *    (`/home/u/x.js:3`) continues only when a later word carries a separator. A refusal with a path,
 *    then at most two prose words, then a filename is still masked — over-masking, never a leak.
 *
 * Covered prefixes: `/…`, `C:\…`, `C:/…` and `\\server\share\…`.
 */
const QUOTED_PATH_PATTERN: { label: string; re: RegExp } = {
  label: 'path', re: /(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'\n]*\1/g,
};

const UNQUOTED_PATH_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  {
    label: 'path',
    re: /(?:^|(?<=[\s"'(=:`]))(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s"']*(?:[^\S\r\n]+[^\s"']*[\\/][^\s"']*)*/g,
  },
];

/**
 * R2-L2: the spaced-path continuation. A head (`/home/u`, `C:\Users\x`) is followed by up to three
 * whitespace-separated words; the run ends at the first word that is itself path-shaped (carries a
 * separator or a file extension) and masks through it. A run that reaches the cap without such a
 * word is prose and masks nothing beyond the head, which the generic pattern handles on its own.
 * When the head already names a file, the continuation is accepted only if it carries a separator
 * — `/home/u/x.js:3 in test.js` names one path and some prose, not a path with spaces.
 */
const SPACED_PATH_HEAD = /(?:^|(?<=[\s"'(=:`]))(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s"'\n]*/g;
const SPACED_WORD = /[^\S\r\n]+([^\s"'\n]+)/y;
const NAMES_FILE = /\.[A-Za-z0-9]{1,8}(?::\d+)?$/;
const MAX_SPACED_WORDS = 3;

function spacedPathTail(text: string, from: number, head: string): number | undefined {
  const headNamesFile = NAMES_FILE.test(head);
  let pos = from;
  let tail: number | undefined;
  let carriesSeparator = false;
  for (let i = 0; i < MAX_SPACED_WORDS; i++) {
    SPACED_WORD.lastIndex = pos;
    const word = SPACED_WORD.exec(text);
    if (word === null) break;
    const end = pos + word[0].length;
    const token = word[1]!;
    if (/[\\/]/.test(token)) carriesSeparator = true;
    if (NAMES_FILE.test(token) || /[\\/]/.test(token)) { tail = end; break; }
    pos = end;
  }
  if (tail === undefined) return undefined;
  return headNamesFile && !carriesSeparator ? undefined : tail;
}

/** Mask each spaced path in `text` from its head through the word that ends it (R2-L2). */
function maskSpacedPaths(text: string): string {
  let out = '';
  let copied = 0;
  for (const match of text.matchAll(SPACED_PATH_HEAD)) {
    const start = match.index ?? 0;
    if (start < copied) continue;
    const tail = spacedPathTail(text, start + match[0].length, match[0]);
    if (tail === undefined) continue;
    out += `${text.slice(copied, start)}[REDACTED:path]`;
    copied = tail;
  }
  return out + text.slice(copied);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace an absolute path that is inside one of `roots` with its repo-relative tail, so the
 * planner keeps the file name it can act on while the machine's layout goes. The root itself
 * becomes `.`. Roots are compared literally; the caller passes the project root and, when it can,
 * its `realpath` — the confinement refusal quotes the resolved one.
 */
function relativizeToRoots(text: string, roots: readonly string[]): string {
  let out = text;
  for (const root of roots) {
    if (root.length <= 1) continue; // `/` would rewrite everything
    const escaped = escapeRegExp(root);
    // `/root/src/a.ts` → `src/a.ts`; the boundary after the root keeps `/root-other` out.
    out = out.replace(new RegExp(`${escaped}(?=[\\\\/])[\\\\/]`, 'g'), '');
    // The root alone, quoting or ending the sentence: `/root` → `.`
    out = out.replace(new RegExp(`${escaped}(?=["'\\s]|$)`, 'g'), '.');
  }
  return out;
}

/**
 * Text that is evidence about a decision and may also be shown to a model: credential formats and
 * assignment heuristics masked (`redactText`'s tier, which is the stricter of the two), and every
 * absolute path replaced with `[REDACTED:path]` — except a path inside `repoRoots`, whose
 * repo-relative tail is kept so the planner can still name the file.
 *
 * The policy engine writes a refusal's `reason` into the memory graph; a confinement refusal quotes
 * the path it refused and the project root it resolved against, and a refusal reason can quote tool
 * input. The evolver's digester reads that node into a planner prompt, which in WP-3.7b goes to a
 * real model. A credential-shaped path segment is a secret wherever it appears, and the machine's
 * layout is not the planner's business. Relativizing runs before path masking (so an in-root tail
 * is not consumed), and path masking before credential masking (so a secret inside a path cannot
 * leave its surroundings behind as a path fragment).
 */
export function redactEvidenceText(text: string, repoRoots: readonly string[] = []): string {
  let out = relativizeToRoots(text, repoRoots);
  // Quoted first: the quotes are the path's boundary, so a quoted path is never handed to the
  // spaced-path reader.
  out = out.replace(QUOTED_PATH_PATTERN.re, `[REDACTED:${QUOTED_PATH_PATTERN.label}]`);
  out = maskSpacedPaths(out);
  for (const p of UNQUOTED_PATH_PATTERNS) out = out.replace(p.re, `[REDACTED:${p.label}]`);
  return redactText(out);
}

/** Shallow-redact string values of a record with credential FORMATS only (evidence-grade). */
export function redactCredentialsRecord(
  obj: Record<string, unknown>,
  extra: readonly RegExp[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? redactCredentials(v, extra) : v;
  }
  return out;
}

/** Shallow-redact string values of a record with the broad set (model-facing only). */
export function redactRecord(
  obj: Record<string, unknown>,
  extra: readonly RegExp[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? redactText(v, extra) : v;
  }
  return out;
}
