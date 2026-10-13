import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolInputSchema } from '../index.js';
import { describeToolInput, toolInputProblem } from '../index.js';

// ORACLE: WP-2.18, from the maintainer's live proof of 0.3.0 — the model sent `patch.apply` a
// `{path, patch}` because the catalog never said the field is `diff`. These pin the one rendering
// the catalog and the error share, and what the check calls malformed.

const PATCH: ToolInputSchema = {
  type: 'object',
  properties: {
    diff:   { type: 'string', description: 'the unified diff' },
    dryRun: { type: 'boolean', description: 'check only' },
  },
  required: ['diff'],
  additionalProperties: false,
};

const RICH: ToolInputSchema = {
  type: 'object',
  properties: {
    paths:  { type: 'array', description: 'files', items: { type: 'string' } },
    runner: { type: 'string', description: 'which runner', enum: ['npm', 'jest'] },
    levels: { type: 'array', description: 'levels', items: { type: 'string', enum: ['a', 'b'] } },
    n:      { type: 'number', description: 'how many' },
    opts:   { type: 'object', description: 'options' },
    any:    { type: 'array', description: 'anything' },
  },
  required: ['paths'],
  additionalProperties: false,
};

test('describeToolInput writes each field as JSON name: type, marking the required ones', () => {
  assert.equal(describeToolInput(PATCH), '{"diff": string (required), "dryRun": boolean}');
  assert.equal(
    describeToolInput(RICH),
    '{"paths": string[] (required), "runner": "npm" | "jest", "levels": ("a" | "b")[], "n": number, "opts": object, "any": array}',
  );
  assert.equal(describeToolInput({ type: 'object', properties: {}, required: [] }), '{}');
  assert.equal(
    describeToolInput({ type: 'object', properties: {}, required: ['x'] }),
    '{"x" (required)}',
    'a required name the schema forgot to declare is still shown',
  );
});

test('the live failure: {path, patch} for patch.apply names the missing diff and the fields it does not take', () => {
  assert.equal(
    toolInputProblem('patch.apply', PATCH, { path: 'hello.js', patch: '--- a/hello.js\n' }),
    'patch.apply expects input {"diff": string (required), "dryRun": boolean}; "diff" is missing and the input has "path", "patch", which it does not take.',
  );
});

test('a well-formed input has no problem, with or without its optional fields', () => {
  assert.equal(toolInputProblem('patch.apply', PATCH, { diff: 'x' }), undefined);
  assert.equal(toolInputProblem('patch.apply', PATCH, { diff: '', dryRun: true }), undefined, 'an empty string is a string');
  assert.equal(toolInputProblem('t', RICH, { paths: [], runner: 'jest', levels: ['b'], n: 0, opts: {}, any: [1, 'x'] }), undefined);
});

test('wrong types are named with what was found and what the field takes', () => {
  const cases: Array<[unknown, string]> = [
    [{ diff: 5 }, '"diff" is a number, not a string'],
    [{ diff: null }, '"diff" is null, not a string'],
    [{ diff: ['x'] }, '"diff" is an array, not a string'],
    [{ diff: 'x', dryRun: 'yes' }, '"dryRun" is a string, not a boolean'],
  ];
  for (const [input, problem] of cases) {
    assert.equal(
      toolInputProblem('patch.apply', PATCH, input),
      `patch.apply expects input {"diff": string (required), "dryRun": boolean}; ${problem}.`,
      JSON.stringify(input),
    );
  }
  const rich = (input: unknown): string | undefined => toolInputProblem('t', RICH, input)?.replace(/^t expects input \{.*?\}; /, '');
  assert.equal(rich({ paths: 'a.ts' }), '"paths" is a string, not an array of strings.');
  assert.equal(rich({ paths: ['a.ts', 7] }), '"paths"[1] is a number, not a string.');
  assert.equal(rich({ paths: [], runner: 'mocha' }), '"runner" is "mocha", which is not one of "npm", "jest".');
  assert.equal(rich({ paths: [], levels: ['a', 'c'] }), '"levels"[1] is "c", which is not one of "a", "b".');
  assert.equal(rich({ paths: [], n: Number.NaN }), '"n" is NaN, not a number.');
  assert.equal(rich({ paths: [], opts: [] }), '"opts" is an array, not an object.');
  assert.equal(rich({ paths: [], opts: null }), '"opts" is null, not an object.');
});

test('an input that is not an object is named as what it is', () => {
  for (const [input, kind] of [[null, 'null'], [['diff'], 'an array'], ['diff', 'a string'], [undefined, 'undefined']] as const) {
    assert.equal(
      toolInputProblem('patch.apply', PATCH, input),
      `patch.apply expects input {"diff": string (required), "dryRun": boolean}; the input is ${kind}, not an object.`,
    );
  }
});

test('several problems are one sentence; an undefined field is missing; unknown names are cut short and counted', () => {
  assert.equal(
    toolInputProblem('patch.apply', PATCH, { diff: undefined, dryRun: 1, strip: 1 }),
    'patch.apply expects input {"diff": string (required), "dryRun": boolean}; "diff" is missing; "dryRun" is a number, not a boolean; and the input has "strip", which it does not take.',
  );
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, i]));
  assert.match(
    toolInputProblem('patch.apply', PATCH, { diff: 'x', ...many }) ?? '',
    /; the input has "f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7" and 2 more, which it does not take\.$/,
  );
  assert.match(
    toolInputProblem('patch.apply', PATCH, { diff: 'x', ['k'.repeat(100)]: 1 }) ?? '',
    /the input has "k{36}\.\.\., which it does not take\.$/,
  );
  const two: ToolInputSchema = { ...PATCH, required: ['diff', 'dryRun'] };
  assert.match(toolInputProblem('patch.apply', two, {}) ?? '', /; "diff" and "dryRun" are missing\.$/);
});

test('unknown fields are malformed only when the schema closes the input', () => {
  const open: ToolInputSchema = { type: 'object', properties: PATCH.properties, required: ['diff'] };
  assert.equal(toolInputProblem('patch.apply', open, { diff: 'x', extra: 1 }), undefined);
  assert.equal(toolInputProblem('patch.apply', { ...open, additionalProperties: true }, { diff: 'x', extra: 1 }), undefined);
  // A name the prototype carries is not a field the schema declares.
  assert.match(toolInputProblem('patch.apply', PATCH, JSON.parse('{"diff":"x","constructor":1,"__proto__":2}')) ?? '',
    /the input has "constructor", "__proto__", which it does not take\.$/);
});

test('requiredOnly checks just the required fields: presence and type, nothing optional, no unknown names', () => {
  const only = { requiredOnly: true };
  assert.equal(toolInputProblem('patch.apply', PATCH, { diff: 'x', dryRun: 'yes', strip: 1 }, only), undefined);
  assert.match(toolInputProblem('patch.apply', PATCH, { path: 'a' }, only) ?? '', /; "diff" is missing\.$/);
  assert.match(toolInputProblem('patch.apply', PATCH, { diff: 3 }, only) ?? '', /; "diff" is a number, not a string\.$/);
  assert.match(toolInputProblem('patch.apply', PATCH, null, only) ?? '', /; the input is null, not an object\.$/);
});
