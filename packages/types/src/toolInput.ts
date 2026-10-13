import type { ToolInputItems, ToolInputProperty, ToolInputSchema, ToolInputType } from './index.js';

// ─────────────────────────────────────────────────────────────────────────────
// TOOL INPUT SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

/** A field's own type, or its values when it has an enum: `string`, `"npm" | "jest"`. */
function scalarText(field: ToolInputItems | ToolInputProperty): string {
  return field.enum !== undefined && field.enum.length > 0
    ? field.enum.map((v) => JSON.stringify(v)).join(' | ')
    : field.type;
}

/** A field's type as the catalog writes it: `string`, `string[]`, `"npm" | "jest"`. */
function typeText(field: ToolInputProperty): string {
  if (field.type !== 'array') return scalarText(field);
  if (field.items === undefined) return 'array';
  const element = scalarText(field.items);
  return field.items.enum !== undefined && field.items.enum.length > 0 ? `(${element})[]` : `${element}[]`;
}

/**
 * A tool's input in one line, for the catalog and for the error a malformed call gets:
 * `{"diff": string (required), "dryRun": boolean}`. Field names are JSON strings, so the name the
 * model reads is the name it must write.
 */
export function describeToolInput(schema: ToolInputSchema): string {
  const required = new Set(schema.required);
  const fields = Object.entries(schema.properties)
    .map(([name, field]) => `${JSON.stringify(name)}: ${typeText(field)}${required.has(name) ? ' (required)' : ''}`);
  // A required name the schema forgot to declare is still required: shown, so the error that names it
  // as missing is not naming a field the description left out.
  for (const name of schema.required) {
    if (!Object.hasOwn(schema.properties, name)) fields.push(`${JSON.stringify(name)} (required)`);
  }
  return `{${fields.join(', ')}}`;
}

function isType(value: unknown, type: ToolInputType): boolean {
  switch (type) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

const ARTICLED: Record<ToolInputType, string> = {
  string: 'a string', number: 'a number', boolean: 'a boolean', array: 'an array', object: 'an object',
};

/** What a value is, as an error message names it. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  switch (typeof value) {
    case 'string':  return 'a string';
    case 'number':  return 'a number';
    case 'boolean': return 'a boolean';
    case 'object':  return 'an object';
    // undefined, bigint, function, symbol: none of them arrives in JSON, but a direct caller can pass one.
    default:        return typeof value;
  }
}

/** A model-supplied value or name as an error message quotes it: JSON, cut short. */
function quoted(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function inEnum(value: unknown, field: ToolInputItems | ToolInputProperty): boolean {
  return field.enum === undefined || field.enum.length === 0 || field.enum.some((v) => v === value);
}

function oneOf(field: ToolInputItems | ToolInputProperty): string {
  return `one of ${(field.enum ?? []).map((v) => JSON.stringify(v)).join(', ')}`;
}

/** What is wrong with one present field, or `undefined` when nothing is. */
function fieldProblem(name: string, value: unknown, field: ToolInputProperty): string | undefined {
  const label = JSON.stringify(name);
  if (!isType(value, field.type)) {
    const wanted = field.type === 'array' && field.items ? `an array of ${field.items.type}s` : ARTICLED[field.type];
    return `${label} is ${kindOf(value)}, not ${wanted}`;
  }
  if (!inEnum(value, field)) return `${label} is ${quoted(value)}, which is not ${oneOf(field)}`;
  const items = field.type === 'array' ? field.items : undefined;
  if (items === undefined || !Array.isArray(value)) return undefined;
  for (const [at, element] of value.entries()) {
    if (!isType(element, items.type)) return `${label}[${at}] is ${kindOf(element)}, not ${ARTICLED[items.type]}`;
    if (!inEnum(element, items)) return `${label}[${at}] is ${quoted(element)}, which is not ${oneOf(items)}`;
  }
  return undefined;
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function names(list: readonly string[]): string {
  const shown = list.map(quoted);
  return shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
}

/** Problems joined into one clause: `a`, `a and b`, `a; b; and c`. */
function joined(parts: readonly string[]): string {
  if (parts.length <= 2) return parts.join(' and ');
  return `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1] ?? ''}`;
}

/** At most this many unknown field names are quoted; a model that sent fifty is told how many more. */
const UNKNOWN_SHOWN = 8;

export interface ToolInputCheckOptions {
  /**
   * Check only what the schema requires: that each required field is there and has its type. What a
   * tool's own `execute` checks for a caller that never went through the gate — the fields it cannot
   * run without — while the gate checks the whole input.
   */
  requiredOnly?: boolean;
}

/**
 * Why `input` is not an input `toolId` takes, as one sentence that quotes the input the tool expects —
 * `patch.apply expects input {"diff": string (required), "dryRun": boolean}; "diff" is missing and the
 * input has "path", "patch", which it does not take.` — or `undefined` when it is one.
 *
 * Malformed: not an object; a required field missing (absent or `undefined`); a field of the wrong type,
 * outside its enum, or an array with an element that is; and, when the schema sets
 * `additionalProperties: false`, a field the schema does not name. `null` is a value of no type here.
 */
export function toolInputProblem(
  toolId: string,
  schema: ToolInputSchema,
  input: unknown,
  options: ToolInputCheckOptions = {},
): string | undefined {
  const expects = `${toolId} expects input ${describeToolInput(schema)}`;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return `${expects}; the input is ${kindOf(input)}, not an object.`;
  }
  const given = input as Record<string, unknown>;
  const required = new Set(schema.required);
  const present = (name: string): boolean => Object.hasOwn(given, name) && given[name] !== undefined;

  const missing = schema.required.filter((name) => !present(name));
  const mistyped: string[] = [];
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!present(name) || (options.requiredOnly === true && !required.has(name))) continue;
    const problem = fieldProblem(name, given[name], field);
    if (problem !== undefined) mistyped.push(problem);
  }
  const unknown = options.requiredOnly === true || schema.additionalProperties !== false
    ? []
    : Object.keys(given).filter((name) => !Object.hasOwn(schema.properties, name));

  const parts = [...mistyped];
  if (missing.length > 0) parts.unshift(`${names(missing)} ${missing.length === 1 ? 'is' : 'are'} missing`);
  if (unknown.length > 0) {
    const more = unknown.length > UNKNOWN_SHOWN ? ` and ${unknown.length - UNKNOWN_SHOWN} more` : '';
    parts.push(`the input has ${unknown.slice(0, UNKNOWN_SHOWN).map(quoted).join(', ')}${more}, which it does not take`);
  }
  return parts.length === 0 ? undefined : `${expects}; ${joined(parts)}.`;
}
