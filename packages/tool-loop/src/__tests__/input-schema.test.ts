import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  TurnAdapter, TurnMessage, AssistantTurn, AdapterInvokeOptions, AdapterInvokeResult, AdapterCapabilities,
  ToolPlugin, ToolContext, ToolResult, ToolCallRecord, ToolInputSchema, PolicyDecision, PolicyEngineHandle, AttestorHandle,
} from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId } from '@maf/types';
import { FsWriteTool, PatchApplyTool, TestRunnerTool } from '@maf/tools';
import { InProcessAgentLoop, executeToolGated } from '../index.js';

// ORACLE: WP-2.18, from the maintainer's live proof of 0.3.0 on macOS with the real `claude` adapter.
// `maf run "add a hello function"` ended Failed: the model sent `patch.apply` a `{path, patch}`, the
// tool read an undefined `diff`, policy saw no paths and allowed, and `writeFile(tmp, undefined)` threw
// a TypeError that ended the node. A call whose input does not match the tool's `inputSchema` is now
// answered before `declaredPaths` and before policy: a failed result naming the input the tool takes,
// recorded as `Indeterminate` under `builtin:input-schema`, handed back to the model, and the loop goes on.

const RULE = 'builtin:input-schema';
const PATCH_EXPECTS = 'patch.apply expects input {"diff": string (required), "strip": number, "dryRun": boolean}';
const WRITE_EXPECTS = 'fs.write expects input {"path": string (required), "content": string (required), "createDirs": boolean}';

class SpyAttestor implements AttestorHandle {
  records: Array<Omit<ToolCallRecord, 'id'>> = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> { this.records.push(call); }
}

/** Allows everything and counts how often it was asked. */
function countingAllow(): PolicyEngineHandle & { asked: () => number } {
  let asked = 0;
  return {
    async evaluate(): Promise<PolicyDecision> { asked++; return { verdict: 'Allow' }; },
    asked: () => asked,
  };
}

async function project(t: TestContext): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), 'maf-input-schema-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const ctxIn = (root: string, attestor: AttestorHandle, policy: PolicyEngineHandle): ToolContext => ({
  cwd: root, projectRoot: root, runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
  sessionId: 's1', policy, attestor,
});

/** A tool that counts its declarations and executions, so "nothing was called" is observed. */
function countingTool(inputSchema?: ToolInputSchema): { tool: ToolPlugin; declared: () => number; runs: () => number } {
  let declared = 0;
  let runs = 0;
  const tool: ToolPlugin = {
    id: makeToolId('probe'), name: 'probe', description: 'counts', permissionLevel: 'write',
    declaredPaths(): string[] { declared++; return []; },
    async execute(): Promise<ToolResult> { runs++; return { stdout: 'ran', stderr: '', exitCode: 0, duration: 0, metadata: {} }; },
    ...(inputSchema ? { inputSchema } : {}),
  };
  return { tool, declared: () => declared, runs: () => runs };
}

const PROBE: ToolInputSchema = {
  type: 'object',
  properties: { name: { type: 'string', description: 'a name' } },
  required: ['name'],
  additionalProperties: false,
};

function assertAnswered(result: ToolResult, record: Omit<ToolCallRecord, 'id'> | undefined, toolId: string, stderr: string): void {
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, stderr);
  assert.ok(record, 'the malformed call is in the attestation');
  assert.equal(record.toolId, toolId);
  assert.deepEqual(record.policyDecision, { verdict: 'Indeterminate', reason: stderr, ruleId: RULE });
  assert.deepEqual(record.result, result, 'the result recorded is the result returned');
  assert.equal(record.result.metadata['refused'], true, 'it did not run');
  assert.equal(record.result.metadata['ruleId'], RULE);
}

test('the live call: patch.apply with {path, patch} is answered naming "diff" — nothing runs, policy is not asked', async (t) => {
  const root = await project(t);
  await writeFile(path.join(root, 'hello.js'), 'module.exports = {};\n', 'utf8');
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const input = { path: 'hello.js', patch: '--- a/hello.js\n+++ b/hello.js\n@@ -1 +1,2 @@\n module.exports = {};\n+// hello\n' };

  const result = await executeToolGated(new PatchApplyTool(), input, ctxIn(root, attestor, policy), { policy, attestor });

  assertAnswered(result, attestor.records[0], 'patch.apply',
    `${PATCH_EXPECTS}; "diff" is missing and the input has "path", "patch", which it does not take.`);
  assert.equal(attestor.records.length, 1);
  assert.equal(policy.asked(), 0, 'there was nothing for the policy to judge');
  assert.equal(await readFile(path.join(root, 'hello.js'), 'utf8'), 'module.exports = {};\n');
});

test('a wrong type and an unknown field are answered the same way', async (t) => {
  const root = await project(t);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ path: 'a.txt', content: 5 }, `${WRITE_EXPECTS}; "content" is a number, not a string.`],
    [{ path: 'a.txt', content: 'x', mode: '0644' }, `${WRITE_EXPECTS}; the input has "mode", which it does not take.`],
    [{ file: 'a.txt', text: 'x' }, `${WRITE_EXPECTS}; "path" and "content" are missing and the input has "file", "text", which it does not take.`],
  ];
  for (const [input, stderr] of cases) {
    const attestor = new SpyAttestor();
    const policy = countingAllow();
    const result = await executeToolGated(new FsWriteTool(), input, ctxIn(root, attestor, policy), { policy, attestor });
    assertAnswered(result, attestor.records[0], 'fs.write', stderr);
    assert.equal(policy.asked(), 0, JSON.stringify(input));
  }
  await assert.rejects(readFile(path.join(root, 'a.txt'), 'utf8'), 'no call wrote anything');
});

test('the check comes before declaredPaths and before policy: neither is called for a malformed input', async () => {
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const { tool, declared, runs } = countingTool(PROBE);
  const result = await executeToolGated(tool, { nme: 'x' }, ctxIn(tmpdir(), attestor, policy), { policy, attestor });
  assertAnswered(result, attestor.records[0], 'probe',
    'probe expects input {"name": string (required)}; "name" is missing and the input has "nme", which it does not take.');
  assert.deepEqual([declared(), policy.asked(), runs()], [0, 0, 0]);
});

test('a valid call is unaffected: declared, asked, run and recorded as Allow', async (t) => {
  const root = await project(t);
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const result = await executeToolGated(new FsWriteTool(), { path: 'a.txt', content: 'hi\n' }, ctxIn(root, attestor, policy), { policy, attestor });
  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'hi\n');
  assert.equal(policy.asked(), 1);
  assert.deepEqual(attestor.records.map((r) => r.policyDecision), [{ verdict: 'Allow' }]);
  assert.equal(attestor.records[0]?.result.metadata['refused'], undefined);

  const probe = countingTool(PROBE);
  const ok = await executeToolGated(probe.tool, { name: 'x' }, ctxIn(root, attestor, policy), { policy, attestor });
  assert.equal(ok.stdout, 'ran');
  assert.deepEqual([probe.declared(), probe.runs()], [1, 1]);
});

test('a tool with no inputSchema is checked against nothing, as before', async () => {
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const { tool, runs } = countingTool();
  const result = await executeToolGated(tool, { anything: [1, null], at: 'all' }, ctxIn(tmpdir(), attestor, policy), { policy, attestor });
  assert.equal(result.stdout, 'ran');
  assert.equal(runs(), 1);
  assert.equal(policy.asked(), 1);
});

test('a credential the model put where a value is quoted is redacted in the answer and the record', async () => {
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const key = 'AKIAIOSFODNN7EXAMPLE';
  const result = await executeToolGated(new TestRunnerTool(), { runner: key }, ctxIn(tmpdir(), attestor, policy), { policy, attestor });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /^test\.run expects input \{"runner": "auto" \| /);
  assert.match(result.stderr, /"runner" is "\[REDACTED[^"]*\]", which is not one of "auto", /);
  assert.doesNotMatch(JSON.stringify(attestor.records), new RegExp(key), 'nowhere in the record');
  assert.equal(policy.asked(), 0);
});

// ── the loop goes on ─────────────────────────────────────────────────────────────────────────────

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
};

/** Replays fixed turns and keeps the history it was handed each time. */
class ScriptedAdapter implements TurnAdapter {
  readonly name = 'scripted';
  readonly seen: TurnMessage[][] = [];
  constructor(private readonly turns: AssistantTurn[]) {}
  capabilities(): AdapterCapabilities { return CAPS; }
  async isAvailable(): Promise<boolean> { return true; }
  async invoke(_o: AdapterInvokeOptions): Promise<AdapterInvokeResult> {
    return { success: true, output: '', toolCallLog: [], exitCode: 0, duration: 1 };
  }
  async *stream(_o: AdapterInvokeOptions): AsyncGenerator<string> { yield ''; }
  async sendTurn(history: TurnMessage[], _o: AdapterInvokeOptions): Promise<AssistantTurn> {
    this.seen.push([...history]);
    return this.turns.shift() ?? { text: 'done', toolCalls: [] };
  }
}

test('in the loop, the malformed patch.apply is handed back as an error, and the corrected call on the next turn applies', async (t) => {
  const root = await project(t);
  await writeFile(path.join(root, 'hello.js'), 'module.exports = {};\n', 'utf8');
  const diff = '--- a/hello.js\n+++ b/hello.js\n@@ -1 +1,2 @@\n module.exports = {};\n+module.exports.hello = () => \'hello\';\n';
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const adapter = new ScriptedAdapter([
    { text: 'add the function', toolCalls: [{ toolUseId: 'u1', toolName: 'patch.apply', input: { path: 'hello.js', patch: diff } }] },
    { text: 'with the right field', toolCalls: [{ toolUseId: 'u2', toolName: 'patch.apply', input: { diff } }] },
  ]);
  const loop = new InProcessAgentLoop(
    {
      role: 'coder', harnessSha: 'a'.repeat(64), systemPrompt: 'sys', userPrompt: 'add a hello function',
      tools: [new PatchApplyTool()], maxTurns: 5, timeoutMs: 10_000,
      workingDir: root, projectRoot: root, sessionId: 's1',
    },
    { adapter, policy, attestor, runId: makeRunId('r1'), taskId: makeTaskId('t1') },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'completed', 'the malformed call did not end the loop');
  assert.equal(result.error, undefined);
  assert.equal(await readFile(path.join(root, 'hello.js'), 'utf8'), 'module.exports = {};\nmodule.exports.hello = () => \'hello\';\n');
  const told = adapter.seen[1]?.find((m) => m.kind === 'tool' && m.toolUseId === 'u1');
  assert.ok(told && told.kind === 'tool', 'the model was handed the answer');
  assert.equal(told.isError, true);
  assert.equal(told.content, `${PATCH_EXPECTS}; "diff" is missing and the input has "path", "patch", which it does not take.`);
  assert.deepEqual(attestor.records.map((r) => [r.toolId, r.policyDecision.verdict, r.result.exitCode]),
    [['patch.apply', 'Indeterminate', 1], ['patch.apply', 'Allow', 0]]);
  assert.equal(policy.asked(), 1, 'only the corrected call was put to the policy');
});
