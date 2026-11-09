import { assertChangeManifest, ManifestError } from './edits.js';
import type { ChangeManifest } from './edits.js';
import type { Digest } from './digester.js';

/**
 * Planner (plan §6.2 step 2) — the LLM meta-agent proposes ONE change manifest
 * per round as a JSON code block. The output is parsed at the boundary; a
 * malformed or out-of-surface manifest never reaches the gate.
 */

export type MetaGenerate = (systemPrompt: string, userPrompt: string) => Promise<string>;

export interface RoleCatalogEntry {
  role: string;
  description: string;
  allowedTools: string[];
  model?: string;
}

export const PLANNER_SYSTEM_PROMPT = `You are the MAF harness evolution planner. You receive execution evidence
(golden-suite history, failure records, policy events) and the current role catalog.
Propose AT MOST ONE bounded harness edit per round as a single JSON manifest in a fenced code block.

Allowed edit.kind values and their exact fields:
- "edit_role_prompt":      {kind, role, newPrompt, rationale}
- "adjust_tool_allowlist": {kind, role, add: string[], remove: string[]}
- "retarget_model":        {kind, role, model}
- "tune_role_budgets":     {kind, role, maxToolIterations?, tokenBudget?, timeoutMs?}
- "add_processor":         {kind, bundle: {name, config?}}  (name must be a known processor)
- "rebind_planner_recall": {kind, pastFailuresLimit?, lcmGrepBudgetTokens?}

Rules: no other fields. No policy/gate/threshold changes. If no edit is justified by the evidence, respond with the block {"no_op": true}.`;

const JSON_BLOCK_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/** Parse a planner response into a manifest. Returns undefined for explicit no-op. Throws ManifestError otherwise. */
export function parsePlannerResponse(text: string): ChangeManifest | undefined {
  const match = JSON_BLOCK_RE.exec(text);
  const candidate = match ? match[1]! : text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new ManifestError('planner response is not parseable JSON');
  }
  if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>)['no_op'] === true) {
    return undefined;
  }
  assertChangeManifest(parsed);
  return parsed;
}

/**
 * The harness the loop is evolving right now, and what it last measured (WP-3.7a MED-3).
 *
 * The prompt's `Current harness:` line used to be built from the newest golden row, which after a
 * rejected candidate was that candidate: the planner was told the harness in force was
 * `default-r1` at 3/10 while the real base was `default` at 4/10, and a proposal aimed at the
 * wrong baseline. The loop knows which harness is in force — its own `base` — so it says so.
 */
export interface CurrentHarnessStatus {
  id: string;
  sha: string;
  solved: readonly string[];
  total: number;
  failed: readonly string[];
}

function scoreLine(row: { solved: readonly string[]; total: number; failed: readonly string[] }): string {
  return `solved ${row.solved.length}/${row.total}`
    + (row.failed.length > 0 ? `; failed ${row.failed.join(', ')}` : '');
}

/**
 * The planner's user prompt: the digest, then one line naming the harness actually in force, then
 * the runs it is not using, each named a rejected candidate with its own score. `current` is what
 * the loop is evolving; when a caller does not know it (an embedder, a test), the newest row is
 * named as before.
 */
export function buildPlannerUserPrompt(
  evidence: Digest,
  catalog: RoleCatalogEntry[],
  processorNames: string[],
  current?: CurrentHarnessStatus,
): string {
  const rows = evidence.goldenHistory;
  const currentLine = current === undefined
    ? (rows[0]
      ? `${rows[0].harnessId} (${rows[0].harnessSha}): ${scoreLine(rows[0])}`
      : '(no golden history)')
    : `${current.id} (${current.sha}): ${current.total > 0 ? scoreLine(current) : 'not scored yet'}`;
  const rejected = rows.filter((row) => current === undefined ? row !== rows[0] : row.harnessSha !== current.sha);
  const rejectedLines = rejected.length > 0
    ? rejected.map((row) => `- rejected candidate ${row.harnessId} (${row.harnessSha}): ${scoreLine(row)}`)
    : ['- (none)'];
  return [
    '## Evidence digest',
    JSON.stringify(evidence, null, 2),
    '',
    `Current harness: ${currentLine}`,
    '',
    '## Rejected candidates',
    ...rejectedLines,
    '',
    '## Role catalog',
    JSON.stringify(catalog, null, 2),
    '',
    '## Known processors',
    processorNames.join(', ') || '(none)',
    '',
    'Propose one manifest now.',
  ].join('\n');
}
