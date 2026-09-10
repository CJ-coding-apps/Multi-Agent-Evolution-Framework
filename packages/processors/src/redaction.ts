/**
 * Secret redaction. Two tiers, because the two consumers have different fidelity
 * requirements (HARNESSX_INTEGRATION_PLAN.md §7.4):
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
