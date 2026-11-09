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
 *    path itself (WP-3.7b R3-L2). After the first segment the match continues over a
 *    space-separated token that still looks like part of a path, i.e. one that contains a
 *    separator. That masks the whole path in every shape a refusal quotes it; a token with no
 *    separator is prose and ends the path.
 *
 * Covered prefixes: `/…`, `C:\…`, `C:/…` and `\\server\share\…`.
 */
const ABSOLUTE_PATH_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'path', re: /(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'\n]*\1/g },
  {
    label: 'path',
    re: /(?:^|(?<=[\s"'(=:`]))(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s"']*(?:[^\S\r\n]+[^\s"']*[\\/][^\s"']*)*/g,
  },
];

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
  for (const p of ABSOLUTE_PATH_PATTERNS) out = out.replace(p.re, `[REDACTED:${p.label}]`);
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
