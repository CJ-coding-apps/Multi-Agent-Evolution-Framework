import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolPlugin, ToolId, ToolContext, ToolResult, ToolInputSchema } from '@maf/types';
import { serializeTools, parseTurn, buildTurnSystemPrompt, serializeHistory } from '../index.js';

function fakeTool(id: string, name: string, description: string): ToolPlugin {
  return {
    id: id as ToolId,
    name,
    description,
    permissionLevel: 'read',
    async execute(_i: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
      return { stdout: '', stderr: '', exitCode: 0, duration: 0, metadata: {} };
    },
    declaredPaths(): string[] { return []; },
  };
}

test('serializeTools advertises the tool id the loop matches on (not just name)', () => {
  const tools = [fakeTool('fs.read', 'Read File', 'Read a file from disk.')];
  const rendered = serializeTools(tools);
  // The loop resolves calls via tool.id — the id MUST appear verbatim so the
  // model emits it as "toolName". Regression guard for H1.
  assert.match(rendered, /fs\.read/);
  assert.match(rendered, /Read a file from disk\./);
  assert.match(rendered, /\[read\]/);
});

test('serializeTools handles the empty/undefined allowlist', () => {
  assert.match(serializeTools([]), /none/);
  assert.match(serializeTools(undefined), /none/);
});

test('buildTurnSystemPrompt includes the base prompt, protocol, and catalog', () => {
  const out = buildTurnSystemPrompt('BASE', [fakeTool('grep', 'grep', 'search')]);
  assert.match(out, /BASE/);
  assert.match(out, /tool_call/);      // protocol present
  assert.match(out, /grep/);           // catalog present
});

test('parseTurn round-trips a fenced tool_call and strips it from the text', () => {
  const stdout = [
    'Let me read that file.',
    '```tool_call',
    '{"toolName":"fs.read","input":{"path":"a.txt"}}',
    '```',
  ].join('\n');
  const turn = parseTurn(stdout);
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0]?.toolName, 'fs.read');
  assert.deepEqual(turn.toolCalls[0]?.input, { path: 'a.txt' });
  assert.ok(turn.toolCalls[0]?.toolUseId);
  assert.equal(turn.text, 'Let me read that file.');
});

test('parseTurn reports a malformed (non-JSON) tool_call block as a parse error', () => {
  const turn = parseTurn('```tool_call\nnot json\n```');
  assert.equal(turn.toolCalls.length, 0);
  assert.equal(turn.parseErrors?.length, 1);
  assert.match(turn.parseErrors?.[0] ?? '', /not valid JSON/);
});

test('parseTurn reports a tool_call block missing a string toolName', () => {
  const turn = parseTurn('```tool_call\n{"input":{"x":1}}\n```');
  assert.equal(turn.toolCalls.length, 0);
  assert.match(turn.parseErrors?.[0] ?? '', /missing a string "toolName"/);
});

test('parseTurn: a valid block alongside a malformed one yields one call and one error', () => {
  const turn = parseTurn([
    '```tool_call', '{"toolName":"fs.read","input":{"path":"a"}}', '```',
    '```tool_call', 'oops not json', '```',
  ].join('\n'));
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.parseErrors?.length, 1);
});

test('parseTurn: a clean response has no parseErrors field', () => {
  const turn = parseTurn('just text, no tools');
  assert.equal(turn.parseErrors, undefined);
});

test('serializeHistory emits [user]/[assistant]/[tool] blocks', () => {
  const text = serializeHistory([
    { kind: 'user', text: 'hi' },
    { kind: 'assistant', text: 'ok', toolCalls: [{ toolUseId: 'x', toolName: 'grep', input: { q: 'a' } }] },
    { kind: 'tool', toolUseId: 'x', toolName: 'grep', content: 'match', isError: false },
  ]);
  assert.match(text, /\[user\]/);
  assert.match(text, /\[assistant\]/);
  assert.match(text, /\[tool\]/);
  assert.match(text, /tool_result/);
});

// ── WP-2.18: the catalog carries each tool's input ───────────────────────────────────────────
// The maintainer's live proof of 0.3.0: told only `patch.apply [write]: Apply a unified diff…`, the
// model sent `{path, patch}`; the field is `diff`. Each entry now states the input, field by field.

function schemaTool(id: string, description: string, inputSchema?: ToolInputSchema): ToolPlugin {
  return { ...fakeTool(id, id, description), permissionLevel: 'write', ...(inputSchema ? { inputSchema } : {}) };
}

const PATCH_INPUT: ToolInputSchema = {
  type: 'object',
  properties: {
    diff:   { type: 'string', description: 'the unified diff to apply, with ---/+++ file headers' },
    dryRun: { type: 'boolean', description: 'check that it applies without changing anything' },
  },
  required: ['diff'],
  additionalProperties: false,
};

test('serializeTools renders each tool with its input on its own line, then what each field means', () => {
  const rendered = serializeTools([schemaTool('patch.apply', 'Apply a unified diff patch to the working tree.', PATCH_INPUT)]);
  const lines = rendered.split('\n');
  assert.equal(
    lines[1],
    '- patch.apply [write]: Apply a unified diff patch to the working tree. — input: {"diff": string (required), "dryRun": boolean}',
  );
  assert.equal(lines[2], '    "diff": the unified diff to apply, with ---/+++ file headers');
  assert.equal(lines[3], '    "dryRun": check that it applies without changing anything');
  assert.equal(lines.length, 4);
});

test('a tool with an empty input says so; a tool with no schema is listed as before, without one', () => {
  const rendered = serializeTools([
    schemaTool('git.status', 'Show the working tree status.', { type: 'object', properties: {}, required: [], additionalProperties: false }),
    schemaTool('third.party', 'Declares no input.'),
  ]);
  assert.deepEqual(rendered.split('\n').slice(1), [
    '- git.status [write]: Show the working tree status. — input: {}',
    '- third.party [write]: Declares no input.',
  ]);
});

test('the protocol says the input must use exactly the catalog\'s field names, and that a call that does not is not run', () => {
  const out = buildTurnSystemPrompt('BASE', [schemaTool('patch.apply', 'Apply a diff.', PATCH_INPUT)]);
  assert.match(out, /"input" must be an object with exactly the fields its AVAILABLE TOOLS entry lists/);
  assert.match(out, /every field marked \(required\)/);
  assert.match(out, /answered with an error and not run/);
  assert.match(out, /"diff": string \(required\)/);
});

// ── D-46(i): the governed turn says what it has, before it lists anything ─────────────────────
// A governed turn runs `claude --tools ''` (CLAUDE_TURN_ISOLATION_ARGS), so the host's native tools
// are gone — but Claude Code's own system prompt still advertises Read/Write/Bash/Glob/Grep. Live row
// 2b of the 3.0c pass: the model tried the host's tools, was refused ("No such tool available", not
// MAF's string), and gave up. The protocol now names the tools it has and the ones it does not, and
// does so before the catalogue it points at.

test('the protocol tells the model its host tools are off, and says it before the catalogue (D-46)', () => {
  const out = buildTurnSystemPrompt('BASE', [fakeTool('fs.read', 'Read File', 'read a file')]);

  assert.match(
    out,
    /The host's own tools — Read, Write, Edit, Bash, Glob, Grep, WebFetch, or any other tool you may believe you have — are not available in this turn, and a request for one is refused\./,
  );
  assert.match(
    out,
    /The only tools you have are the ones listed below; request one with a fenced block exactly as described, by its id\./,
  );
  assert.ok(
    out.indexOf("The host's own tools") < out.indexOf('AVAILABLE TOOLS'),
    'the sentence must precede the catalogue it names',
  );
});
