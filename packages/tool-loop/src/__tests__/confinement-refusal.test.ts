import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  TurnAdapter, TurnMessage, AssistantTurn, AdapterInvokeOptions, AdapterInvokeResult, AdapterCapabilities,
  ToolPlugin, ToolContext, ToolResult, ToolCallRecord, PolicyDecision, PolicyEngineHandle, AttestorHandle,
} from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId, PathConfinementError } from '@maf/types';
import { PolicyViolationError } from '@maf/policy-engine';
import { FsDeleteTool, FsWriteTool, PatchApplyTool } from '@maf/tools';
import { InProcessAgentLoop, executeToolGated } from '../index.js';

// ORACLE (F1 of the 0.3.0 release audit, round 2): a tool's built-in refusal of a path into `.git` is a
// verdict, not a crash. `executeToolGated` turns the tool's `PathConfinementError` — from `declaredPaths`
// before policy, or from `execute` on the resolved path — into a `Deny` under rule id `builtin:git-dir`:
// attested before the throw, thrown as `PolicyViolationError`, so the loop tells the model why and goes
// on to its next step. Any other error from `declaredPaths` still propagates.

const RULE = 'builtin:git-dir';

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
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), 'maf-confinement-refusal-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'config'), '[core]\n', 'utf8');
  return root;
}

const ctxIn = (root: string, attestor: AttestorHandle, policy: PolicyEngineHandle): ToolContext => ({
  cwd: root, projectRoot: root, runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
  sessionId: 's1', policy, attestor,
});

/**
 * Runs the call, and says how many records the attestor held at the moment the error left
 * `executeToolGated` — code after a throw never runs, so a record present then was made before it.
 */
async function refused(call: () => Promise<unknown>, attestor: SpyAttestor): Promise<{ err: PolicyViolationError; recordedWhenThrown: number }> {
  try {
    await call();
  } catch (err: unknown) {
    assert.ok(err instanceof PolicyViolationError, `expected PolicyViolationError, got ${String(err)}`);
    return { err, recordedWhenThrown: attestor.records.length };
  }
  throw new Error('expected the call to be refused');
}

function assertGitDirDeny(record: Omit<ToolCallRecord, 'id'> | undefined, tool: string, message: RegExp): void {
  assert.ok(record, 'the refusal is in the attestation');
  assert.equal(record.toolId, tool);
  assert.equal(record.policyDecision.verdict, 'Deny');
  assert.equal(record.policyDecision.verdict === 'Deny' ? record.policyDecision.ruleId : undefined, RULE);
  assert.match(record.policyDecision.reason, message);
  assert.equal(record.result.metadata['refused'], true, 'marked refused, not a call that ran and failed');
  assert.equal(record.result.metadata['ruleId'], RULE);
  assert.equal(record.result.stdout, '');
  assert.equal(record.result.exitCode, 1);
  assert.match(record.result.stderr, /^policy Deny: /);
}

test('a .git path refused by declaredPaths is a Deny under builtin:git-dir: attested before the throw, policy never asked', async (t) => {
  const root = await project(t);
  const cases: Array<[ToolPlugin, Record<string, unknown>]> = [
    [new FsDeleteTool(), { path: '.git', recursive: true }],
    [new FsWriteTool(), { path: '.git', content: 'gitdir: /home/user/repo/.git\n' }],
    [new PatchApplyTool(), { diff: '--- a/.git/config\n+++ b/.git/config\n@@ -1 +1,2 @@\n [core]\n+\tfsmonitor = ./x\n' }],
  ];
  for (const [tool, input] of cases) {
    const attestor = new SpyAttestor();
    const policy = countingAllow();
    const { err, recordedWhenThrown } = await refused(() => executeToolGated(tool, input, ctxIn(root, attestor, policy), { policy, attestor }), attestor);

    assert.equal(recordedWhenThrown, 1, `${tool.name}: recorded before the error reached the caller`);
    assert.deepEqual(err.decision, attestor.records[0]?.policyDecision, `${tool.name}: the decision thrown is the decision recorded`);
    assertGitDirDeny(attestor.records[0], tool.name, new RegExp(`^${tool.name.replace('.', '\\.')} refuses .*git's own data \\(\\.git\\)`));
    assert.equal(policy.asked(), 0, `${tool.name}: refused before any rule was consulted`);
  }
  assert.equal(await readFile(path.join(root, '.git', 'config'), 'utf8'), '[core]\n', '.git is untouched');
});

test('a .git path refused on its resolved path while the tool runs is the same Deny, and nothing is written', async (t) => {
  const root = await project(t);
  // A link inside the root that leads into .git: the spelling passes declaredPaths and policy allows it.
  await symlink(path.join(root, '.git'), path.join(root, 'innocent'));
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const tool = new FsWriteTool();

  const { err, recordedWhenThrown } = await refused(
    () => executeToolGated(tool, { path: 'innocent/config', content: '[core]\n\tfsmonitor = ./x\n' }, ctxIn(root, attestor, policy), { policy, attestor }),
    attestor,
  );

  assert.equal(policy.asked(), 1, 'the spelling went past policy');
  assert.equal(recordedWhenThrown, 1);
  assert.equal(err.decision.verdict, 'Deny');
  assertGitDirDeny(attestor.records[0], 'fs.write', /^fs\.write refuses "innocent\/config": it resolves to "\.git\/config"/);
  assert.equal(await readFile(path.join(root, '.git', 'config'), 'utf8'), '[core]\n', 'nothing was written into .git');
});

test('any other error from declaredPaths still propagates as itself, unrecorded: failing to declare is not a verdict', async () => {
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const broken: ToolPlugin = {
    id: makeToolId('fs.write'), name: 'fs.write', description: 'declares by throwing', permissionLevel: 'write',
    declaredPaths(): string[] { throw new Error('cannot work out my own paths'); },
    async execute(): Promise<ToolResult> { throw new Error('must not run'); },
  };
  await assert.rejects(
    () => executeToolGated(broken, { path: 'a' }, ctxIn(tmpdir(), attestor, policy), { policy, attestor }),
    (err: unknown) => err instanceof Error && !(err instanceof PolicyViolationError) && err.message === 'cannot work out my own paths',
  );
  assert.equal(attestor.records.length, 0);
  assert.equal(policy.asked(), 0);
  // The class is the cue, not the wording: a plain Error saying the same thing is not a refusal.
  assert.ok(new PathConfinementError('x', '.git', 'why') instanceof Error);
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

test('in the loop, the refused fs.delete .git is reported to the model and the next step runs', async (t) => {
  const root = await project(t);
  const attestor = new SpyAttestor();
  const adapter = new ScriptedAdapter([
    { text: 'first, clear git out of the way', toolCalls: [{ toolUseId: 'u1', toolName: 'fs.delete', input: { path: '.git', recursive: true } }] },
    { text: 'then the actual fix', toolCalls: [{ toolUseId: 'u2', toolName: 'fs.write', input: { path: 'sum.js', content: 'fixed\n' } }] },
  ]);
  const loop = new InProcessAgentLoop(
    {
      role: 'coder', harnessSha: 'a'.repeat(64), systemPrompt: 'sys', userPrompt: 'fix it',
      tools: [new FsDeleteTool(), new FsWriteTool()], maxTurns: 5, timeoutMs: 10_000,
      workingDir: root, projectRoot: root, sessionId: 's1',
    },
    { adapter, policy: countingAllow(), attestor, runId: makeRunId('r1'), taskId: makeTaskId('t1') },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'completed', 'the refusal did not end the loop');
  assert.equal(await readFile(path.join(root, 'sum.js'), 'utf8'), 'fixed\n', 'the step after the refusal ran');
  assert.ok(existsSync(path.join(root, '.git', 'config')), '.git is still there');
  const told = adapter.seen[1]?.find((m) => m.kind === 'tool' && m.toolUseId === 'u1');
  assert.ok(told && told.kind === 'tool', 'the model was handed the refusal');
  assert.equal(told.isError, true);
  assert.match(told.content, /^policy Deny: fs\.delete refuses "\.git": the path names git's own data \(\.git\)/);
  assert.deepEqual(attestor.records.map((r) => [r.toolId, r.policyDecision.verdict]), [['fs.delete', 'Deny'], ['fs.write', 'Allow']]);
  assertGitDirDeny(attestor.records[0], 'fs.delete', /^fs\.delete refuses "\.git"/);
});
