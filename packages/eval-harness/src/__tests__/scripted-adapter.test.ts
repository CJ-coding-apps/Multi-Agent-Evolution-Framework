import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdapterInvokeOptions, TurnMessage } from '@maf/types';
import { parseSecurityOutput } from '@maf/git-ops';
import {
  ScriptedAdapter, SCRIPTED_JUDGE_RATIONALE, JUDGE_SYSTEM_PROMPT, judgePrompt, parseJudgeVerdict,
} from '../index.js';
import type { ScriptedTask } from '../index.js';

// ORACLE: D-14 — `goldens run --adapter scripted` needs a model that answers the same way on
// every machine. The demo's adapter drew tool-use ids from crypto.randomUUID(); this one may not
// read a clock, randomness or the environment, and an unscripted task is an error, not silence.

const FIX: ScriptedTask = {
  prompt: 'Fix sum.js so test.js passes.',
  steps: [
    { tool: 'fs.read', input: { path: 'sum.js' } },
    { tool: 'fs.write', input: { path: 'sum.js', content: 'module.exports = (a, b) => a + b;\n' } },
  ],
  final: 'Fixed sum.js.',
};

const opts = (over: Partial<AdapterInvokeOptions> = {}): AdapterInvokeOptions =>
  ({ prompt: '[turn]', workingDir: '/nonexistent', timeoutMs: 1000, ...over });

/** Drives the adapter the way the in-process loop does, executing nothing. */
async function walk(adapter: ScriptedAdapter, prompt: string): Promise<TurnMessage[]> {
  let history: TurnMessage[] = [{ kind: 'user', text: prompt }];
  for (let i = 0; i < 10; i++) {
    const turn = await adapter.sendTurn(history, opts({ systemPrompt: 'sys' }));
    history = [...history, { kind: 'assistant', text: turn.text, toolCalls: turn.toolCalls }];
    if (turn.toolCalls.length === 0) break;
    for (const c of turn.toolCalls) history = [...history, { kind: 'tool', toolUseId: c.toolUseId, toolName: c.toolName, content: `ran ${c.toolName}` }];
  }
  return history;
}

test('the in-process script walks one tool call per turn and is identical on every run', async () => {
  const a = await walk(new ScriptedAdapter([FIX]), FIX.prompt);
  const b = await walk(new ScriptedAdapter([FIX]), FIX.prompt);
  assert.deepEqual(a, b, 'two runs of the same script must produce the same conversation');
  const calls = a.flatMap((m) => (m.kind === 'assistant' ? m.toolCalls : []));
  assert.deepEqual(calls.map((c) => [c.toolUseId, c.toolName]), [['scripted-1', 'fs.read'], ['scripted-2', 'fs.write']]);
  const last = a[a.length - 1];
  assert.deepEqual(last, { kind: 'assistant', text: 'Fixed sum.js.', toolCalls: [] });
});

test('invoked as a CLI agent it applies the script\'s writes and deletes itself, inside the working dir only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-scripted-'));
  try {
    await writeFile(path.join(dir, 'sum.js'), 'module.exports = (a, b) => a - b;\n', 'utf8');
    await writeFile(path.join(dir, 'old.js'), 'x', 'utf8');
    const adapter = new ScriptedAdapter([{ ...FIX, steps: [...FIX.steps, { tool: 'fs.delete', input: { path: 'old.js' } }] }]);
    const res = await adapter.invoke(opts({ prompt: FIX.prompt, workingDir: dir }));
    assert.deepEqual([res.success, res.output, res.exitCode, res.duration], [true, 'Fixed sum.js.', 0, 0]);
    assert.equal(await readFile(path.join(dir, 'sum.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
    await assert.rejects(() => access(path.join(dir, 'old.js')), 'the scripted delete must land');

    const escape = new ScriptedAdapter([{ prompt: 'p', steps: [{ tool: 'fs.write', input: { path: '../outside.js', content: 'x' } }], final: 'f' }]);
    await mkdir(path.join(dir, 'inner'));
    await assert.rejects(() => escape.invoke(opts({ prompt: 'p', workingDir: path.join(dir, 'inner') })), /must stay inside the working directory/);
    await assert.rejects(() => access(path.join(dir, 'outside.js')), 'nothing may be written outside the working dir');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a task with no script fails on both tiers instead of answering', async () => {
  const adapter = new ScriptedAdapter([FIX]);
  const res = await adapter.invoke(opts({ prompt: 'Fix something else.' }));
  assert.equal(res.success, false);
  assert.match(res.output, /no script answers the task "Fix something else\."/);
  await assert.rejects(() => adapter.sendTurn([{ kind: 'user', text: 'Fix something else.' }], opts()), /no script answers/);
  assert.throws(() => new ScriptedAdapter([FIX, FIX]), /two scripts answer the same prompt/);
});

test('it answers the security gate with a clean review and the judge with a fail-closed verdict in the agreed shape', async () => {
  const adapter = new ScriptedAdapter();
  const review = await adapter.invoke(opts({ prompt: 'Audit this diff for security issues. Respond with the strict JSON schema in your system prompt.\n```diff\n+x\n```' }));
  assert.deepEqual(parseSecurityOutput(review.output), { findings: [], summary: 'The scripted adapter reports no findings.', passed: true });

  const judged = await adapter.invoke(opts({ prompt: judgePrompt('rubric', 'subject'), systemPrompt: JUDGE_SYSTEM_PROMPT }));
  assert.deepEqual(parseJudgeVerdict(judged.output), { passed: false, rationale: SCRIPTED_JUDGE_RATIONALE },
    'the judge answer must parse — an unparseable one would also fail, but for the wrong reason');
  assert.deepEqual(adapter.exchanges.map((e) => e.kind), ['security-review', 'judge']);
});
