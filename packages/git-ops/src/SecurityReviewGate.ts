import type {
  CliAdapter, AdapterInvokeOptions,
  SecurityFinding, SecurityReviewResult, SecuritySeverity,
} from '@maf/types';

export interface SecurityReviewGateConfig {
  adapter:        CliAdapter;
  projectRoot:    string;
  securityPrompt: string;
  timeoutMs?:     number;
  model?:         string;
}

const BLOCKING_SEVERITIES: ReadonlySet<SecuritySeverity> = new Set(['critical', 'high']);

export class SecurityReviewGate {
  constructor(private readonly config: SecurityReviewGateConfig) {}

  async reviewDiff(diff: string): Promise<SecurityReviewResult> {
    if (!diff.trim()) {
      return { findings: [], summary: 'No diff to review.', passed: true };
    }
    const userPrompt =
      `Audit this diff for security issues. Respond with the strict JSON schema in your system prompt.\n` +
      `\`\`\`diff\n${diff.slice(0, 16000)}\n\`\`\``;
    return this.invoke(userPrompt);
  }

  async reviewPaths(paths: string[], cwd: string): Promise<SecurityReviewResult> {
    if (paths.length === 0) {
      return { findings: [], summary: 'No paths to review.', passed: true };
    }
    const userPrompt =
      `Audit these files for security issues. Use fs.read and grep to inspect them — do not write. ` +
      `Respond with the strict JSON schema in your system prompt.\n` +
      `Working directory: ${cwd}\n` +
      `Files:\n${paths.map((p) => ` - ${p}`).join('\n')}`;
    return this.invoke(userPrompt);
  }

  private async invoke(prompt: string): Promise<SecurityReviewResult> {
    const opts: AdapterInvokeOptions = {
      prompt,
      systemPrompt: this.config.securityPrompt,
      workingDir:   this.config.projectRoot,
      timeoutMs:    this.config.timeoutMs ?? 120_000,
      ...(this.config.model ? { model: this.config.model } : {}),
    };
    const result = await this.config.adapter.invoke(opts);
    return parseSecurityOutput(result.output);
  }
}

export function parseSecurityOutput(raw: string): SecurityReviewResult {
  const json = extractJsonBlock(raw);
  if (!json) {
    return {
      findings: [],
      summary:  `Could not parse security review output. Raw: ${raw.slice(0, 600)}`,
      passed:   false,
    };
  }
  try {
    const parsed = JSON.parse(json) as Partial<SecurityReviewResult>;
    const findings = sanitizeFindings(parsed.findings);
    const summary  = typeof parsed.summary === 'string' ? parsed.summary : '';
    const passed   = typeof parsed.passed === 'boolean'
      ? parsed.passed
      : !findings.some((f) => BLOCKING_SEVERITIES.has(f.severity));
    return { findings, summary, passed };
  } catch {
    return {
      findings: [],
      summary:  `Security review JSON parse failed. Raw: ${raw.slice(0, 600)}`,
      passed:   false,
    };
  }
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

function sanitizeFindings(raw: unknown): SecurityFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: SecurityFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const severity = normalizeSeverity(f['severity']);
    if (!severity) continue;
    if (typeof f['category'] !== 'string') continue;
    if (typeof f['file']     !== 'string') continue;
    const finding: SecurityFinding = {
      severity,
      category:    f['category'],
      file:        f['file'],
      rationale:   typeof f['rationale']   === 'string' ? f['rationale']   : '',
      remediation: typeof f['remediation'] === 'string' ? f['remediation'] : '',
    };
    if (typeof f['line'] === 'number') finding.line = f['line'];
    out.push(finding);
  }
  return out;
}

function normalizeSeverity(x: unknown): SecuritySeverity | null {
  if (typeof x !== 'string') return null;
  const lower = x.toLowerCase();
  if (lower === 'critical' || lower === 'high' || lower === 'medium' || lower === 'low' || lower === 'info') {
    return lower;
  }
  return null;
}
