import { lstat, readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { GraphQueryRunner, PolicyAction, PolicyPredicate, PolicyRule } from '@maf/types';
import { makeToolId } from '@maf/types';
import { PolicyEngine } from './PolicyEngine.js';

/**
 * Reads a policy file into rules, and refuses a file it cannot read in full (D-08).
 *
 * The parser this replaces answered every failure with "no rules": a file written in YAML — the
 * format it is named for — a JSON typo, or an action kind the engine does not know each removed
 * every Deny and Escalate rule, and the run carried on as if the file had said nothing. One case
 * may still produce zero rules, the file not being there, and that case says so.
 */
export class PolicyLoader {
  /**
   * The validated rules in `policyPath`.
   *
   * A missing file logs one warning line and yields no rules: running without a policy is a
   * posture MAF supports, and path confinement does not depend on a rule. Everything else that
   * stops the file being read in full — unreadable, not YAML, or failing validation — throws,
   * because a policy that exists and is ignored is exactly the fail-open this loader closes.
   */
  static async load(policyPath: string): Promise<PolicyRule[]> {
    let text: string;
    try {
      text = await readFile(policyPath, 'utf8');
    } catch (err) {
      // A dangling symlink also reads as ENOENT, but its name exists: whatever policy it was meant
      // to point at has gone, which is not the same as the user having no policy.
      if (isNotFound(err) && !(await nameExists(policyPath))) {
        // JSON-quoted so the warning stays one line whatever the path contains.
        console.warn(
          `[maf] policy: no policy file at ${JSON.stringify(policyPath)}; ` +
          'running with no policy rules (path confinement still applies).',
        );
        return [];
      }
      throw new Error(
        `Policy file ${JSON.stringify(policyPath)} exists but could not be read, and a policy ` +
        `that exists is never skipped: ${messageOf(err)}`,
      );
    }
    return parsePolicy(text, policyPath);
  }

  /** A `PolicyEngine` holding the rules `load` returns, so a call site cannot load one without the other. */
  static async loadEngine(policyPath: string, graph: GraphQueryRunner): Promise<PolicyEngine> {
    const engine = new PolicyEngine(graph);
    engine.loadRules(await PolicyLoader.load(policyPath));
    return engine;
  }

  /** Every way `rules` departs from the rule schema, one sentence each; `[]` when it is valid. */
  static validate(rules: unknown): string[] {
    if (!Array.isArray(rules)) return [`Expected a list of rules; found ${found(rules)}.`];
    const errors: string[] = [];
    readRules(rules, errors);
    return errors;
  }
}

function parsePolicy(text: string, source: string): PolicyRule[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new Error(
      `Policy file ${JSON.stringify(source)} is not valid YAML, so none of its rules were ` +
      `loaded and the run cannot start: ${messageOf(err)}`,
    );
  }
  const errors: string[] = [];
  const rules = readDocument(doc, errors);
  if (errors.length > 0) {
    throw new Error(
      `Policy file ${JSON.stringify(source)} failed validation, so none of its rules were ` +
      `loaded and the run cannot start:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return rules;
}

// Keyed by the types' own field names, so a field added to a policy type does not compile until
// the loader knows it — rather than being refused at run time as unknown.
const DOCUMENT_FIELDS = { rules: true } as const;
const RULE_FIELDS: Record<keyof PolicyRule, true> = {
  id: true, description: true, priority: true, predicate: true, action: true,
};
const PREDICATE_FIELDS: Record<keyof PolicyPredicate, true> = {
  toolId: true, pathGlob: true, allowedPathGlobs: true, agentRole: true,
  memoryPattern: true, minFailureCount: true,
};
const MEMORY_PATTERN_FIELDS = { cypher: true } as const;
const ACTION_FIELDS: { [K in PolicyAction['kind']]: Record<string, true> } = {
  Allow:    { kind: true },
  Deny:     { kind: true, reason: true, alternative: true },
  Escalate: { kind: true, requiresApproval: true },
};
const ACTION_KINDS = '"Allow", "Deny" or "Escalate"';

type Mapping = Record<string, unknown>;

function readDocument(doc: unknown, errors: string[]): PolicyRule[] {
  if (doc === null || doc === undefined) {
    errors.push(
      'The policy file is empty or holds only comments: expected a mapping with a "rules" list ' +
      '(write "rules: []" to run with no rules on purpose).',
    );
    return [];
  }
  if (!isMapping(doc)) {
    errors.push(`The policy must be a mapping with a "rules" list; found ${found(doc)}.`);
    return [];
  }
  unknownFields(doc, DOCUMENT_FIELDS, 'The policy', errors);
  const rules = doc['rules'];
  if (!Array.isArray(rules)) {
    errors.push(problem('The policy', 'rules', 'a list of rules ("rules: []" for none)', rules));
    return [];
  }
  return readRules(rules, errors);
}

function readRules(list: readonly unknown[], errors: string[]): PolicyRule[] {
  const rules: PolicyRule[] = [];
  const firstIndexOf = new Map<string, number>();
  list.forEach((entry, i) => {
    const rule = readRule(entry, `rules[${i}]`, errors);
    // Checked on the raw id, so a duplicate is reported alongside whatever else is wrong with
    // either rule rather than only once both are otherwise valid.
    const id = isMapping(entry) ? nonEmptyString(entry['id']) : undefined;
    if (id !== undefined) {
      const earlier = firstIndexOf.get(id);
      if (earlier !== undefined) {
        // A verdict names the rule that produced it; two rules answering to one id make that
        // name useless in an attestation or an approval request.
        errors.push(
          `rules[${i}] (${JSON.stringify(id)}): id is already used by rules[${earlier}]; ` +
          'expected every rule id to be unique.',
        );
        return;
      }
      firstIndexOf.set(id, i);
    }
    if (rule !== undefined) rules.push(rule);
  });
  return rules;
}

function readRule(raw: unknown, at: string, errors: string[]): PolicyRule | undefined {
  if (!isMapping(raw)) {
    errors.push(`${at} must be a mapping with id, priority, predicate and action; found ${found(raw)}.`);
    return undefined;
  }
  const before = errors.length;
  const id = nonEmptyString(raw['id']);
  const label = id === undefined ? at : `${at} (${JSON.stringify(id)})`;
  unknownFields(raw, RULE_FIELDS, label, errors);
  if (id === undefined) errors.push(problem(label, 'id', 'a non-empty string', raw['id']));
  // Optional: it explains the rule to a reader and never changes a verdict.
  const description = raw['description'];
  if (description !== undefined && typeof description !== 'string') {
    errors.push(problem(label, 'description', 'a string', description));
  }
  const priority = finiteNumber(raw['priority']);
  // `.nan` and `.inf` are YAML numbers; either one would make the priority sort meaningless.
  if (priority === undefined) errors.push(problem(label, 'priority', 'a finite number', raw['priority']));
  const predicate = readPredicate(raw['predicate'], label, errors);
  const action = readAction(raw['action'], label, errors);
  if (
    errors.length > before ||
    id === undefined || priority === undefined || predicate === undefined || action === undefined
  ) {
    return undefined;
  }
  return { id, description: typeof description === 'string' ? description : '', priority, predicate, action };
}

function readPredicate(raw: unknown, label: string, errors: string[]): PolicyPredicate | undefined {
  if (!isMapping(raw)) {
    errors.push(problem(label, 'predicate', 'a mapping ({} matches every call)', raw));
    return undefined;
  }
  // An unknown field is refused rather than ignored: `agentrole: tester` on an Allow rule would
  // otherwise allow every role, and `pathglob` on a Deny rule would deny every path.
  unknownFields(raw, PREDICATE_FIELDS, `${label} predicate`, errors);
  const predicate: PolicyPredicate = {};

  const toolId = oneOrMany(raw['toolId'], label, 'predicate.toolId', 'tool id', errors);
  if (toolId !== undefined) {
    predicate.toolId = typeof toolId === 'string' ? makeToolId(toolId) : toolId.map((t) => makeToolId(t));
  }

  // The engine treats an empty glob as "no path condition", so `''` would widen the rule to
  // every path rather than narrow it to none.
  const pathGlob = raw['pathGlob'];
  if (pathGlob !== undefined) {
    const glob = nonEmptyString(pathGlob);
    if (glob === undefined) errors.push(problem(label, 'predicate.pathGlob', 'a non-empty glob', pathGlob));
    else predicate.pathGlob = glob;
  }

  // Likewise `[]`: the engine reads an empty list as "no allow-list", not "nothing allowed".
  const allowed = raw['allowedPathGlobs'];
  if (allowed !== undefined) {
    const globs = nonEmptyStrings(allowed);
    if (globs === undefined) {
      errors.push(problem(label, 'predicate.allowedPathGlobs', 'a non-empty list of non-empty globs', allowed));
    } else {
      predicate.allowedPathGlobs = globs;
    }
  }

  const agentRole = oneOrMany(raw['agentRole'], label, 'predicate.agentRole', 'role name', errors);
  if (agentRole !== undefined) predicate.agentRole = agentRole;

  const memoryPattern = raw['memoryPattern'];
  if (memoryPattern !== undefined) {
    if (!isMapping(memoryPattern)) {
      errors.push(problem(label, 'predicate.memoryPattern', 'a mapping with a "cypher" template', memoryPattern));
    } else {
      unknownFields(memoryPattern, MEMORY_PATTERN_FIELDS, `${label} predicate.memoryPattern`, errors);
      const cypher = nonEmptyString(memoryPattern['cypher']);
      if (cypher === undefined) {
        errors.push(problem(label, 'predicate.memoryPattern.cypher', 'a non-empty Cypher template', memoryPattern['cypher']));
      } else {
        predicate.memoryPattern = { cypher };
      }
    }
  }

  const minFailureCount = raw['minFailureCount'];
  if (minFailureCount !== undefined) {
    if (typeof minFailureCount !== 'number' || !Number.isInteger(minFailureCount) || minFailureCount < 0) {
      errors.push(problem(label, 'predicate.minFailureCount', 'a non-negative integer', minFailureCount));
    } else {
      predicate.minFailureCount = minFailureCount;
    }
  }

  return predicate;
}

function readAction(raw: unknown, label: string, errors: string[]): PolicyAction | undefined {
  if (!isMapping(raw)) {
    errors.push(problem(label, 'action', `a mapping whose kind is ${ACTION_KINDS}`, raw));
    return undefined;
  }
  const kind = raw['kind'];
  switch (kind) {
    case 'Allow':
      unknownFields(raw, ACTION_FIELDS.Allow, `${label} action`, errors);
      return { kind: 'Allow' };
    case 'Deny': {
      unknownFields(raw, ACTION_FIELDS.Deny, `${label} action`, errors);
      const reason = nonEmptyString(raw['reason']);
      if (reason === undefined) {
        errors.push(problem(label, 'action.reason', 'a non-empty string, which the agent is shown', raw['reason']));
        return undefined;
      }
      const alternative = raw['alternative'];
      if (alternative === undefined) return { kind: 'Deny', reason };
      const toolId = nonEmptyString(alternative);
      if (toolId === undefined) {
        errors.push(problem(label, 'action.alternative', 'a tool id', alternative));
        return undefined;
      }
      return { kind: 'Deny', reason, alternative: makeToolId(toolId) };
    }
    case 'Escalate': {
      unknownFields(raw, ACTION_FIELDS.Escalate, `${label} action`, errors);
      const requiresApproval = raw['requiresApproval'];
      if (typeof requiresApproval !== 'boolean') {
        errors.push(problem(label, 'action.requiresApproval', 'true or false', requiresApproval));
        return undefined;
      }
      return { kind: 'Escalate', requiresApproval };
    }
    default:
      errors.push(problem(label, 'action.kind', `one of ${ACTION_KINDS}`, kind));
      return undefined;
  }
}

function unknownFields(
  raw: Mapping,
  known: Readonly<Record<string, true>>,
  label: string,
  errors: string[],
): void {
  for (const key of Object.keys(raw)) {
    // `hasOwn`, not `in`: `toString` and `constructor` are on every object's prototype.
    if (!Object.hasOwn(known, key)) {
      errors.push(
        `${label} has unknown field ${JSON.stringify(key)}: expected only ${Object.keys(known).join(', ')}.`,
      );
    }
  }
}

function problem(label: string, field: string, expected: string, value: unknown): string {
  return value === undefined
    ? `${label} is missing ${field}: expected ${expected}.`
    : `${label}: ${field} must be ${expected}; found ${found(value)}.`;
}

function found(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? 'an empty list' : 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string') return value.trim() === '' ? 'an empty string' : JSON.stringify(value);
  return String(value);
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function nonEmptyStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items: readonly unknown[] = value;
  const strings: string[] = [];
  for (const item of items) {
    const s = nonEmptyString(item);
    if (s === undefined) return undefined;
    strings.push(s);
  }
  return strings;
}

/** One non-empty string, or a non-empty list of them. An empty list would make the rule unmatchable. */
function oneOrMany(
  value: unknown,
  label: string,
  field: string,
  noun: string,
  errors: string[],
): string | string[] | undefined {
  if (value === undefined) return undefined;
  const one = nonEmptyString(value);
  if (one !== undefined) return one;
  const many = nonEmptyStrings(value);
  if (many !== undefined) return many;
  errors.push(problem(label, field, `a ${noun} or a non-empty list of them`, value));
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

async function nameExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
