import crypto from 'node:crypto';
import type { TurnMessage, AssistantTurn, ToolCallRequest, ToolPlugin } from '@maf/types';
import { describeToolInput } from '@maf/types';

/**
 * MAF's in-process tool-call wire protocol, shared by every TurnAdapter
 * (Claude, Codex, …). The model requests tools by emitting fenced `tool_call`
 * blocks and receives results as fenced `tool_result` blocks, so MAF's policy
 * engine + processor pipeline intercept every call — unlike the legacy opaque
 * invoke() path. Kept in @maf/adapter-base (depends only on @maf/types) so no
 * adapter duplicates the format and no cycle through @maf/roles is introduced.
 *
 * D-46(i): the first paragraph names what the turn does *not* have. A governed turn runs the backend
 * with `--tools ''` (CLAUDE_TURN_ISOLATION_ARGS), so the host's native Read/Write/Bash/Glob/Grep are
 * gone — but the backend's own system prompt still advertises them, and this block used only to say
 * the model "MAY request tools" by fenced block. Live row 2b of the 3.0c pass: the model reached for
 * a native tool, was refused, and gave up. Saying which tools exist is the turn saying what it has.
 */
export const TOOL_PROTOCOL = [
  "The host's own tools — Read, Write, Edit, Bash, Glob, Grep, WebFetch, or any other tool you may believe you have — are not available in this turn, and a request for one is refused. The only tools you have are the ones listed below; request one with a fenced block exactly as described, by its id.",
  'You MAY request tools. To request a tool, emit exactly one fenced block per call:',
  '```tool_call',
  '{"toolName":"<tool-id>","input":{...}}',
  '```',
  'Use the exact tool id from the AVAILABLE TOOLS list as "toolName".',
  '"input" must be an object with exactly the fields its AVAILABLE TOOLS entry lists, under those names and with those types, and with every field marked (required).',
  'A call whose input does not match is answered with an error and not run.',
  'Wait for the tool_result block before continuing. Do NOT claim effects you did not observe.',
].join('\n');

/**
 * Render the allowlisted tool catalog for the system prompt. The loop resolves
 * calls by tool *id* (toolByName = Map(tools.map(t => [t.id, t]))), so the id is
 * what the model must emit — advertise the id, with name/description/permission
 * as context. Without this the model is blind to which tools exist.
 *
 * Each entry also states the tool's input, field by field, and under it one line per field
 * saying what it means (a `timeout` in milliseconds, an `offset` in lines). Without them the
 * model guessed field names: the live proof of 0.3.0 sent `patch.apply` a `{path, patch}`.
 * The input is rendered by `describeToolInput`, as the error for a malformed call quotes it.
 * A tool that declares no `inputSchema` is listed without one.
 */
export function serializeTools(tools: ReadonlyArray<ToolPlugin> | undefined): string {
  if (!tools || tools.length === 0) return 'AVAILABLE TOOLS: (none)';
  const lines = tools.flatMap((t) => {
    const entry = `- ${String(t.id)} [${t.permissionLevel}]: ${t.description}`;
    if (t.inputSchema === undefined) return [entry];
    const fields = Object.entries(t.inputSchema.properties)
      .map(([name, field]) => `    ${JSON.stringify(name)}: ${field.description}`);
    return [`${entry} — input: ${describeToolInput(t.inputSchema)}`, ...fields];
  });
  return ['AVAILABLE TOOLS (use the id as "toolName"):', ...lines].join('\n');
}

/** Compose the full system block a TurnAdapter presents to the model. */
export function buildTurnSystemPrompt(
  systemPrompt: string | undefined,
  tools: ReadonlyArray<ToolPlugin> | undefined,
): string {
  return [systemPrompt, TOOL_PROTOCOL, serializeTools(tools)]
    .filter((s): s is string => Boolean(s))
    .join('\n\n');
}

export function serializeHistory(history: TurnMessage[]): string {
  return history.map((m) => {
    if (m.kind === 'user') return `[user]\n${m.text}`;
    if (m.kind === 'assistant') {
      const calls = m.toolCalls.map((c) =>
        ['```tool_call', JSON.stringify({ toolName: c.toolName, input: c.input }), '```'].join('\n'));
      return [`[assistant]`, m.text, ...calls].filter(Boolean).join('\n');
    }
    return [
      `[tool]`,
      '```tool_result',
      JSON.stringify({ toolUseId: m.toolUseId, toolName: m.toolName, content: m.content, isError: m.isError ?? false }),
      '```',
    ].join('\n');
  }).join('\n\n');
}

const TOOL_CALL_RE = /```tool_call\s*\n([\s\S]*?)\n```/g;

function snippet(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}

export function parseTurn(stdout: string): AssistantTurn {
  const toolCalls: ToolCallRequest[] = [];
  const parseErrors: string[] = [];
  for (const match of stdout.matchAll(TOOL_CALL_RE)) {
    const body = match[1] ?? '';
    let parsed: { toolName?: unknown; input?: unknown };
    try {
      parsed = JSON.parse(body) as { toolName?: unknown; input?: unknown };
    } catch {
      // A fenced tool_call block the model clearly intended as a call, but whose
      // body is not valid JSON. Surface it so the loop can ask for a correction
      // instead of silently dropping the call.
      parseErrors.push(`tool_call block is not valid JSON: "${snippet(body)}"`);
      continue;
    }
    if (typeof parsed.toolName !== 'string' || parsed.toolName.length === 0) {
      parseErrors.push(`tool_call block is missing a string "toolName": "${snippet(body)}"`);
      continue;
    }
    toolCalls.push({
      toolUseId: crypto.randomUUID(),
      toolName: parsed.toolName,
      input: (parsed.input && typeof parsed.input === 'object' ? parsed.input : {}) as Record<string, unknown>,
    });
  }
  const text = stdout.replace(TOOL_CALL_RE, '').trim();
  return { text, toolCalls, raw: stdout, ...(parseErrors.length ? { parseErrors } : {}) };
}
