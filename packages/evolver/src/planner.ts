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

export function buildPlannerUserPrompt(evidence: Digest, catalog: RoleCatalogEntry[], processorNames: string[]): string {
  const lastGolden = evidence.goldenHistory[0];
  return [
    '## Evidence digest',
    JSON.stringify(evidence, null, 2),
    '',
    `Current harness: ${lastGolden ? `${lastGolden.harnessId} solved ${lastGolden.solved.length}/${lastGolden.total}` : '(no golden history)'}`,
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
