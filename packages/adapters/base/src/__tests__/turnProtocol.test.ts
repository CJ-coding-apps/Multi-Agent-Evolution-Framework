import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolPlugin, ToolId, ToolContext, ToolResult } from '@maf/types';
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
