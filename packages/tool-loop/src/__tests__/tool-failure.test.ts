import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  TurnAdapter, TurnMessage, AssistantTurn, AdapterInvokeOptions, AdapterInvokeResult, AdapterCapabilities,
  ToolPlugin, ToolContext, ToolResult, ToolCallRecord, PolicyDecision, PolicyEngineHandle, AttestorHandle,
} from '@maf/types';
import { makeAgentId, makeRunId, makeTaskId, makeToolId, PathConfinementError } from '@maf/types';
import { PolicyViolationError } from '@maf/policy-engine';
import { FsReadTool, FsWriteTool } from '@maf/tools';
import { InProcessAgentLoop, executeToolGated } from '../index.js';

// ORACLE: WP-2.18, round 2 — the failure round one predicted. `fs.read` of a file that is not there threw
// ENOENT out of `execute`; `executeToolGated` rethrew everything but a confinement refusal and the loop
// everything but a `PolicyViolationError`, so a model checking whether `hello.js` existed before writing
// it ended the node. A tool that throws while running is now answered: a failed result,
// `<tool id> failed: <message>`, recorded with the verdict that let it run, and the loop goes on. A
// confinement refusal and a `PolicyViolationError` raised inside a tool keep their own paths.

class SpyAttestor implements AttestorHandle {
  records: Array<Omit<ToolCallRecord, 'id'>> = [];
  async record(call: Omit<ToolCallRecord, 'id'>): Promise<void> { this.records.push(call); }
}

function countingAllow(): PolicyEngineHandle & { asked: () => number } {
  let asked = 0;
  return {
    async evaluate(): Promise<PolicyDecision> { asked++; return { verdict: 'Allow' }; },
    asked: () => asked,
  };
}

async function project(t: TestContext): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), 'maf-tool-failure-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const ctxIn = (root: string, attestor: AttestorHandle, policy: PolicyEngineHandle): ToolContext => ({
  cwd: root, projectRoot: root, runId: makeRunId('r1'), taskId: makeTaskId('t1'), agentId: makeAgentId('a1'),
  sessionId: 's1', policy, attestor,
});

/** A tool whose `execute` is `run`, with nothing between it and the gate. */
function throwing(run: (ctx: ToolContext) => Promise<ToolResult>): ToolPlugin {
  return {
    id: makeToolId('probe'), name: 'probe', description: 'throws as it is told', permissionLevel: 'read',
    declaredPaths(): string[] { return []; },
    async execute(_input, ctx): Promise<ToolResult> { return run(ctx); },
  };
}

const OK: ToolResult = { stdout: 'ok', stderr: '', exitCode: 0, duration: 0, metadata: {} };

test('a tool that throws ENOENT is answered with "<id> failed: <message>" and recorded under the Allow that let it run', async (t) => {
  const root = await project(t);
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  // Reads without catching, as fs.read did before it caught its own errors: the gate is what answers.
  const tool = throwing(async (ctx) => ({ ...OK, stdout: await readFile(path.join(ctx.cwd, 'hello.js'), 'utf8') }));

  const result = await executeToolGated(tool, {}, ctxIn(root, attestor, policy), { policy, attestor });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `probe failed: ENOENT: no such file or directory, open '${path.join(root, 'hello.js')}'`);
  assert.equal(result.metadata['threw'], true);
  assert.equal(policy.asked(), 1, 'policy ran');
  assert.equal(attestor.records.length, 1);
  assert.deepEqual(attestor.records[0]?.policyDecision, { verdict: 'Allow' });
  assert.deepEqual(attestor.records[0]?.result, result, 'the result recorded is the result returned');
  assert.equal(attestor.records[0]?.result.metadata['refused'], undefined, 'it ran, and failed: not a refusal');
});

test('a plain Error, a non-Error and a credential in the message are answered the same way, the credential redacted', async () => {
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const key = 'AKIAIOSFODNN7EXAMPLE';
  const cases: Array<[unknown, RegExp]> = [
    [new Error('the probe has a bug'), /^probe failed: the probe has a bug$/],
    ['a bare string', /^probe failed: a bare string$/],
    [new Error(`signing with ${key} failed`), /^probe failed: signing with \[REDACTED:aws-access-key\] failed$/],
  ];
  for (const [thrown, stderr] of cases) {
    const result = await executeToolGated(throwing(async () => { throw thrown; }), {}, ctxIn(tmpdir(), attestor, policy), { policy, attestor });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, stderr);
  }
  assert.equal(attestor.records.length, 3, 'each is recorded');
  assert.doesNotMatch(JSON.stringify(attestor.records), new RegExp(key));
});

test('a confinement refusal from execute is still a Deny under builtin:git-dir, thrown as PolicyViolationError', async () => {
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const tool = throwing(async () => { throw new PathConfinementError('probe refuses ".git": it is git\'s own data.', '.git', 'it is git\'s own data'); });
  await assert.rejects(
    () => executeToolGated(tool, {}, ctxIn(tmpdir(), attestor, policy), { policy, attestor }),
    (err: unknown) => err instanceof PolicyViolationError && err.decision.verdict === 'Deny'
      && err.decision.ruleId === 'builtin:git-dir',
  );
  assert.equal(attestor.records[0]?.result.metadata['refused'], true);
  assert.equal(attestor.records[0]?.result.metadata['threw'], undefined, 'a refusal, not a failure');
});

test('a PolicyViolationError from execute is rethrown as itself, not answered as a failure', async () => {
  const attestor = new SpyAttestor();
  const policy = countingAllow();
  const refusal = new PolicyViolationError({ verdict: 'Deny', reason: 'refused from inside the tool' });
  const tool = throwing(async () => { throw refusal; });
  await assert.rejects(() => executeToolGated(tool, {}, ctxIn(tmpdir(), attestor, policy), { policy, attestor }), (err: unknown) => err === refusal);
  assert.equal(attestor.records.length, 0, 'it took the refusal\'s path, which is not this one');
});

// ── round 3: a path that escapes the root as the tool runs is a refusal, not a failure ──────────
// Policy confines the spelling it is handed; a symlink swapped in after that, and before the tool
// resolves the path, leads out of the root. The tool's `resolveInside` throws PathEscapeError. Answered
// as a failed call it would sit in the bundle under the `Allow` the spelling earned; it is a `Deny`
// under `builtin:path-escape`, attested and thrown as PolicyViolationError, as `builtin:git-dir` is.

/** A root with `notes.txt` and an empty `out/` inside it, and a secret beside it. */
async function racyProject(t: TestContext): Promise<{ root: string; outside: string }> {
  const parent = realpathSync(await mkdtemp(path.join(tmpdir(), 'maf-path-escape-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');
  await mkdir(path.join(root, 'out'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, 'notes.txt'), 'inside\n', 'utf8');
  await writeFile(path.join(outside, 'secret.txt'), 'the secret\n', 'utf8');
  return { root, outside };
}

/** Allows, and while it is being asked, replaces `rel` in the root with a link to `target`. */
function swappingAllow(root: string, rel: string, target: string): PolicyEngineHandle & { asked: () => number } {
  let asked = 0;
  return {
    async evaluate(): Promise<PolicyDecision> {
      asked++;
      await rm(path.join(root, rel), { recursive: true, force: true });
      await symlink(target, path.join(root, rel));
      return { verdict: 'Allow' };
    },
    asked: () => asked,
  };
}

function assertEscapeDeny(record: Omit<ToolCallRecord, 'id'> | undefined, toolId: string): void {
  assert.ok(record, 'the refusal is in the attestation');
  assert.equal(record.toolId, toolId);
  assert.equal(record.policyDecision.verdict, 'Deny');
  assert.equal(record.policyDecision.verdict === 'Deny' ? record.policyDecision.ruleId : undefined, 'builtin:path-escape');
  assert.match(record.policyDecision.reason, /is outside the project root/);
  assert.deepEqual([record.result.metadata['refused'], record.result.metadata['ruleId']], [true, 'builtin:path-escape']);
  assert.equal(record.result.metadata['threw'], undefined, 'a refusal, not a failed call');
  assert.match(record.result.stderr, /^policy Deny: Path "/);
}

test('a symlink swapped in after policy ran: fs.read and fs.write are refused as a Deny under builtin:path-escape', async (t) => {
  const { root, outside } = await racyProject(t);
  const cases: Array<[ToolPlugin, Record<string, unknown>, string, string]> = [
    [new FsReadTool(), { path: 'notes.txt' }, 'notes.txt', path.join(outside, 'secret.txt')],
    [new FsWriteTool(), { path: 'out/planted.txt', content: 'planted\n' }, 'out', outside],
  ];
  for (const [tool, input, swapped, target] of cases) {
    const attestor = new SpyAttestor();
    const policy = swappingAllow(root, swapped, target);
    let recordedWhenThrown = -1;
    await assert.rejects(
      async () => {
        try {
          await executeToolGated(tool, input, ctxIn(root, attestor, policy), { policy, attestor });
        } finally {
          recordedWhenThrown = attestor.records.length;
        }
      },
      (err: unknown) => err instanceof PolicyViolationError && err.decision.verdict === 'Deny'
        && err.decision.ruleId === 'builtin:path-escape',
      String(tool.id),
    );
    assert.equal(policy.asked(), 1, 'the spelling went past policy');
    assert.equal(recordedWhenThrown, 1, 'recorded before the refusal reached the caller');
    assertEscapeDeny(attestor.records[0], String(tool.id));
    assert.doesNotMatch(JSON.stringify(attestor.records), /the secret/, 'nothing outside the root was read');
  }
  assert.deepEqual(await readdir(outside), ['secret.txt'], 'nothing was written outside the root');
});

test('in the loop, the path-escape refusal is reported as a policy Deny and the next step runs', async (t) => {
  const { root, outside } = await racyProject(t);
  const attestor = new SpyAttestor();
  let first = true;
  const policy: PolicyEngineHandle = {
    async evaluate(): Promise<PolicyDecision> {
      if (first) {
        first = false;
        await rm(path.join(root, 'notes.txt'));
        await symlink(path.join(outside, 'secret.txt'), path.join(root, 'notes.txt'));
      }
      return { verdict: 'Allow' };
    },
  };
  const adapter = new ScriptedAdapter([
    call('u1', 'fs.read', { path: 'notes.txt' }),
    call('u2', 'fs.write', { path: 'hello.js', content: 'hi\n' }),
  ]);
  const loop = new InProcessAgentLoop(
    {
      role: 'coder', harnessSha: 'a'.repeat(64), systemPrompt: 'sys', userPrompt: 'read the notes',
      tools: [new FsReadTool(), new FsWriteTool()], maxTurns: 5, timeoutMs: 10_000,
      workingDir: root, projectRoot: root, sessionId: 's1',
    },
    { adapter, policy, attestor, runId: makeRunId('r1'), taskId: makeTaskId('t1') },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'completed');
  const refused = told(adapter, 'u1');
  assert.ok(refused && refused.kind === 'tool');
  assert.equal(refused.isError, true);
  assert.match(refused.content, /^policy Deny: Path "notes\.txt" is outside the project root /);
  assert.equal(await readFile(path.join(root, 'hello.js'), 'utf8'), 'hi\n', 'the step after the refusal ran');
  assertEscapeDeny(attestor.records[0], 'fs.read');
});

// ── the loop goes on ─────────────────────────────────────────────────────────────────────────────

const CAPS: AdapterCapabilities = {
  supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: false,
  inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
};

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

const call = (toolUseId: string, toolName: string, input: Record<string, unknown>): AssistantTurn =>
  ({ text: toolUseId, toolCalls: [{ toolUseId, toolName, input }] });

function told(adapter: ScriptedAdapter, toolUseId: string): TurnMessage | undefined {
  return adapter.seen.flat().find((m) => m.kind === 'tool' && m.toolUseId === toolUseId);
}

test('in the loop: fs.read of a missing file and fs.write into a missing directory are answered, and the corrected write lands', async (t) => {
  const root = await project(t);
  const attestor = new SpyAttestor();
  const adapter = new ScriptedAdapter([
    call('u1', 'fs.read', { path: 'hello.js' }),
    call('u2', 'fs.write', { path: 'src/hello.js', content: 'hi\n' }),
    call('u3', 'fs.write', { path: 'src/hello.js', content: 'hi\n', createDirs: true }),
  ]);
  const loop = new InProcessAgentLoop(
    {
      role: 'coder', harnessSha: 'a'.repeat(64), systemPrompt: 'sys', userPrompt: 'add a hello function',
      tools: [new FsReadTool(), new FsWriteTool()], maxTurns: 6, timeoutMs: 10_000,
      workingDir: root, projectRoot: root, sessionId: 's1',
    },
    { adapter, policy: countingAllow(), attestor, runId: makeRunId('r1'), taskId: makeTaskId('t1') },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'completed', 'neither failure ended the loop');
  assert.equal(await readFile(path.join(root, 'src', 'hello.js'), 'utf8'), 'hi\n');
  const read = told(adapter, 'u1');
  assert.ok(read && read.kind === 'tool' && read.isError === true);
  assert.equal(read.content, `fs.read failed: ENOENT: no such file or directory, open '${path.join(root, 'hello.js')}'`);
  const write = told(adapter, 'u2');
  assert.ok(write && write.kind === 'tool' && write.isError === true);
  assert.match(write.content, /^fs\.write failed: ENOENT: no such file or directory, open '.*src\/hello\.js'$/);
  assert.deepEqual(attestor.records.map((r) => [r.toolId, r.policyDecision.verdict, r.result.exitCode]),
    [['fs.read', 'Allow', 1], ['fs.write', 'Allow', 1], ['fs.write', 'Allow', 0]]);
});

test('in the loop: a tool that throws a plain Error is answered, and its corrected call on the next turn succeeds', async () => {
  const attestor = new SpyAttestor();
  let calls = 0;
  const flaky: ToolPlugin = {
    id: makeToolId('probe'), name: 'probe', description: 'fails on bad input', permissionLevel: 'read',
    declaredPaths(): string[] { return []; },
    async execute(input): Promise<ToolResult> {
      calls++;
      if (input['mode'] !== 'right') throw new Error(`mode ${JSON.stringify(input['mode'])} is not supported`);
      return OK;
    },
  };
  const adapter = new ScriptedAdapter([call('u1', 'probe', { mode: 'wrong' }), call('u2', 'probe', { mode: 'right' })]);
  const loop = new InProcessAgentLoop(
    {
      role: 'coder', harnessSha: 'a'.repeat(64), systemPrompt: 'sys', userPrompt: 'probe',
      tools: [flaky], maxTurns: 5, timeoutMs: 10_000, workingDir: tmpdir(), projectRoot: tmpdir(), sessionId: 's1',
    },
    { adapter, policy: countingAllow(), attestor, runId: makeRunId('r1'), taskId: makeTaskId('t1') },
  );

  const result = await loop.run();

  assert.equal(result.outcome, 'completed');
  assert.equal(calls, 2);
  const first = told(adapter, 'u1');
  assert.ok(first && first.kind === 'tool');
  assert.deepEqual([first.isError, first.content], [true, 'probe failed: mode "wrong" is not supported']);
  const second = told(adapter, 'u2');
  assert.ok(second && second.kind === 'tool');
  assert.deepEqual([second.isError, second.content], [false, 'ok']);
  assert.deepEqual(attestor.records.map((r) => [r.policyDecision.verdict, r.result.exitCode]), [['Allow', 1], ['Allow', 0]]);
});
