import type {
  CliAdapter, AdapterInvokeOptions, AdapterInvokeResult, ModelSurfaceRecord,
  SecurityFinding, SecurityReviewResult, SecuritySeverity,
} from '@maf/types';
import { GateRefused, callModelSurface, makeTaskId, redactCredentials } from '@maf/types';

/** L1: what a review is about, when the caller knows it: the node whose change the gate read. */
export interface ReviewedNode {
  nodeId: string;
}

export interface SecurityReviewGateConfig {
  adapter:        CliAdapter;
  projectRoot:    string;
  securityPrompt: string;
  timeoutMs?:     number;
  model?:         string;
  /** Longest diff, in characters, the gate will send for review. Default 60,000. */
  maxDiffChars?:  number;
  /**
   * L1: where each reviewer call's surface goes — one record per attempt, written before the
   * verdict is parsed, so a call that passed, blocked, timed out or threw (S5) is accounted for.
   * Not called when no model call was made (an empty diff, no paths, or a diff over the cap).
   */
  recordSurface?: (record: ModelSurfaceRecord) => unknown;
}

const BLOCKING_SEVERITIES: ReadonlySet<SecuritySeverity> = new Set(['critical', 'high']);
const DEFAULT_MAX_DIFF_CHARS = 60_000;
/** Stands in for a category or file the model left out of a finding the verdict still needs. */
const UNSPECIFIED = '(unspecified)';

export class SecurityReviewGate {
  private readonly maxDiffChars: number;

  constructor(private readonly config: SecurityReviewGateConfig) {
    // Checked here because a NaN cap would make every `length > cap` false, and the gate
    // would send diffs of any size.
    const cap = config.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
    if (!Number.isSafeInteger(cap) || cap < 1) {
      throw new Error(
        `SecurityReviewGate maxDiffChars must be a positive safe integer; got ${String(cap)}.`,
      );
    }
    this.maxDiffChars = cap;
  }

  /**
   * Reviews the whole diff or refuses it (D-07). A slice would be reviewed as if it were the
   * change, and the part that was cut would be attested as reviewed — so a diff over the cap
   * throws `GateRefused` before any model call.
   */
  async reviewDiff(diff: string, reviewed?: ReviewedNode): Promise<SecurityReviewResult> {
    if (!diff.trim()) {
      return { findings: [], summary: 'No diff to review.', passed: true };
    }
    if (diff.length > this.maxDiffChars) {
      throw new GateRefused(
        `The security gate refuses a ${diff.length}-character diff: its review cap is ` +
        `${this.maxDiffChars} characters, and a diff is reviewed whole or not at all, so nothing ` +
        `was sent to the reviewer. Split the change into smaller tasks, or raise maxDiffChars ` +
        `where the SecurityReviewGate is constructed.`,
        [],
      );
    }
    const userPrompt =
      `Audit this diff for security issues. Respond with the strict JSON schema in your system prompt.\n` +
      `\`\`\`diff\n${diff}\n\`\`\``;
    // Everything the reviewer needs is in the prompt. With its own tools it could edit the tree it
    // is reviewing, and that edit would reach the branch after the review that passed it.
    return this.invoke(userPrompt, false, reviewed);
  }

  async reviewPaths(paths: string[], cwd: string, reviewed?: ReviewedNode): Promise<SecurityReviewResult> {
    if (paths.length === 0) {
      return { findings: [], summary: 'No paths to review.', passed: true };
    }
    const userPrompt =
      `Audit these files for security issues. Use fs.read and grep to inspect them — do not write. ` +
      `Respond with the strict JSON schema in your system prompt.\n` +
      `Working directory: ${cwd}\n` +
      `Files:\n${paths.map((p) => ` - ${p}`).join('\n')}`;
    // This review reads the files itself, so the reviewer keeps its tools.
    return this.invoke(userPrompt, true, reviewed);
  }

  private async invoke(
    prompt: string,
    nativeTools: boolean,
    reviewed?: ReviewedNode,
  ): Promise<SecurityReviewResult> {
    const opts: AdapterInvokeOptions = {
      prompt,
      systemPrompt: this.config.securityPrompt,
      workingDir:   this.config.projectRoot,
      timeoutMs:    this.config.timeoutMs ?? 120_000,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(nativeTools ? {} : { nativeTools: false }),
    };
    let result: AdapterInvokeResult | undefined;
    try {
      result = await this.config.adapter.invoke(opts);
    } finally {
      // L1: this is a model call whether or not it judged anything, so its surface is recorded
      // before the transport check below can throw, and whether or not the adapter returned (S5).
      // `taskId` is the reviewed node's, exactly as the dispatcher mints it (`makeTaskId(node.id)`),
      // so a reader joins the gate's call to that node's role records; reviewing outside a node
      // names the gate itself. A throw leaves `outputSha256` absent and says `error: 'thrown'`.
      await this.config.recordSurface?.({
        role: 'security', taskId: makeTaskId(reviewed?.nodeId ?? 'security-gate'), turn: 1,
        ...(result?.modelSurface ?? callModelSurface(opts.systemPrompt, prompt, result?.output)),
        tier: 'cli', nativeTools: nativeTools ? 'full' : 'none', kind: 'security-gate',
        ...(result === undefined ? { error: 'thrown' as const } : {}),
        ...(this.config.model !== undefined ? { model: this.config.model } : {}),
      });
    }
    // A reviewer that timed out or never started has not judged anything: that is a transport
    // failure the node may be retried on (D-06), not a refusal to carry as a verdict.
    if (result.transportError !== undefined) throw result.transportError;
    return parseSecurityOutput(result.output);
  }
}

/**
 * The verdict is derived from finding severities alone (D-07); the model's own `passed` is
 * ignored, because it has said `true` beside its own critical finding. Anything that leaves the
 * severities unknowable — no JSON, bad JSON, no findings array, an entry with no readable
 * severity — fails closed.
 */
export function parseSecurityOutput(raw: string): SecurityReviewResult {
  // The raw output is the reviewer's own text; on any failure below a slice of it is quoted into
  // `summary`, which becomes node state and the record. Mask credential-shaped substrings BEFORE
  // the 600-char slice, so the head of a key the slice would cut is not preserved as evidence.
  const safeRaw = redactCredentials(raw);
  const json = extractJsonBlock(raw);
  if (!json) {
    return {
      findings: [],
      summary:  `Could not parse security review output. Raw: ${safeRaw.slice(0, 600)}`,
      passed:   false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      findings: [],
      summary:  `Security review JSON parse failed. Raw: ${safeRaw.slice(0, 600)}`,
      passed:   false,
    };
  }
  const obj: Record<string, unknown> =
    parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const rawFindings = obj['findings'];
  if (!Array.isArray(rawFindings)) {
    return {
      findings: [],
      summary:  `Security review output has no findings array, so there are no severities to ` +
                `derive a verdict from. Raw: ${safeRaw.slice(0, 600)}`,
      passed:   false,
    };
  }
  const { findings, unclassified } = sanitizeFindings(rawFindings);
  // The summary and the findings are the reviewer's own words, and they reach the `GateRefused`
  // message, the outcome, the bundle, the memory graph and `<past-failures>` — the realistic case
  // being a reviewer that quotes the key it just found. Every string the parse keeps is masked
  // before it is kept, so nothing downstream has to remember to.
  let summary = typeof obj['summary'] === 'string' ? redactCredentials(obj['summary']) : '';
  if (unclassified > 0) {
    const note =
      `${unclassified} finding(s) had no recognisable severity (expected critical, high, ` +
      `medium, low or info), so the review fails closed.`;
    summary = summary ? `${summary} ${note}` : note;
  }
  const passed = unclassified === 0 && !findings.some((f) => BLOCKING_SEVERITIES.has(f.severity));
  return { findings, summary, passed };
}

function extractJsonBlock(raw: string): string | null {
  const fenced = /```json\s*([\s\S]+?)```/i.exec(raw);
  if (fenced?.[1]) return fenced[1].trim();
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const braceStart = trimmed.indexOf('{');
  const braceEnd   = trimmed.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }
  return null;
}

/**
 * An entry is dropped only when dropping it cannot change the verdict. A blocking finding with
 * no category or file is kept, since dropping it would pass the diff; an entry whose severity
 * cannot be read is counted as `unclassified`, since it may have been critical.
 *
 * Every string a kept finding carries is masked first (see `parseSecurityOutput`): a finding is
 * reviewer-authored text that becomes node state and the record, so the same reason the summary
 * is masked applies to it field by field.
 */
function sanitizeFindings(raw: readonly unknown[]): { findings: SecurityFinding[]; unclassified: number } {
  const out: SecurityFinding[] = [];
  let unclassified = 0;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? redactCredentials(v) : undefined);
  for (const item of raw) {
    if (!item || typeof item !== 'object') { unclassified++; continue; }
    const f = item as Record<string, unknown>;
    const severity = normalizeSeverity(f['severity']);
    if (!severity) { unclassified++; continue; }
    const category = str(f['category']);
    const file     = str(f['file']);
    if ((category === undefined || file === undefined) && !BLOCKING_SEVERITIES.has(severity)) continue;
    const finding: SecurityFinding = {
      severity,
      category:    category ?? UNSPECIFIED,
      file:        file     ?? UNSPECIFIED,
      rationale:   str(f['rationale'])   ?? '',
      remediation: str(f['remediation']) ?? '',
    };
    if (typeof f['line'] === 'number') finding.line = f['line'];
    out.push(finding);
  }
  return { findings: out, unclassified };
}

function normalizeSeverity(x: unknown): SecuritySeverity | null {
  if (typeof x !== 'string') return null;
  const lower = x.toLowerCase();
  if (lower === 'critical' || lower === 'high' || lower === 'medium' || lower === 'low' || lower === 'info') {
    return lower;
  }
  return null;
}
