import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdapterInvokeOptions, TurnMessage } from '@maf/types';
import { parseSecurityOutput } from '@maf/git-ops';
import {
  ScriptedAdapter, SCRIPTED_JUDGE_RATIONALE, JUDGE_SYSTEM_PROMPT, judgePrompt, parseJudgeVerdict,
  loadScriptedBundle, loadScriptedTasks,
} from '../index.js';
import type { GoldenTask, ScriptedTask } from '../index.js';

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
    // L1-S11: the call is recorded before the effect is applied, so the refused write does not erase
    // the call that asked for it; no answer came back, so the exchange carries no output.
    assert.equal(escape.exchanges.length, 1);
    assert.equal(escape.exchanges[0]?.kind, 'task');
    assert.equal(escape.exchanges[0]?.prompt, 'p');
    assert.equal(escape.exchanges[0]?.output, undefined);
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

test('scripts are written per corpus task id and served by the prompt the model sees', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-scripts-'));
  const task = (id: string, prompt: string): GoldenTask => ({
    id, prompt, repoFixture: `fixtures/${id}`, role: 'coder',
    verifiers: [{ kind: 'diff-match', mustContain: [], mustNotContain: [] }],
    provenance: { source: 'human-decision', ref: 'test' },
  });
  try {
    const corpus = [task('a', 'Do A.'), task('b', 'Do B.')];
    await writeFile(path.join(root, 'scripted.json'), JSON.stringify({ version: 1, tasks: { b: { steps: [], final: 'did B' } } }), 'utf8');
    assert.deepEqual(await loadScriptedTasks(root, corpus), [{ prompt: 'Do B.', steps: [], final: 'did B' }]);

    await writeFile(path.join(root, 'scripted.json'), JSON.stringify({ version: 1, tasks: { zzz: { steps: [], final: 'x' } } }), 'utf8');
    await assert.rejects(() => loadScriptedTasks(root, corpus), /script "zzz" names no task in the corpus/);
    await writeFile(path.join(root, 'scripted.json'), JSON.stringify({ version: 1, tasks: { a: { steps: [{ tool: 1 }], final: 'x' } } }), 'utf8');
    await assert.rejects(() => loadScriptedTasks(root, corpus), /step 0 needs a string "tool"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a task prompt may have a variant per role prompt, and the marked variant wins when it matches', async () => {
  const base: ScriptedTask = { prompt: 'Fix A.', steps: [], final: 'base answer' };
  const thorough: ScriptedTask = { ...base, systemContains: 'thorough', final: 'thorough answer' };
  // Order in the file must not decide it: the default is first here and still loses to a match.
  const adapter = new ScriptedAdapter([base, thorough]);
  const ask = (systemPrompt: string) => adapter.invoke(opts({ prompt: 'Fix A.', systemPrompt }));
  assert.equal((await ask('be terse')).output, 'base answer');
  assert.equal((await ask('be terse and thorough')).output, 'thorough answer');
  assert.equal((await ask('be thorough')).output, 'thorough answer');
  // A marker that does not match falls back to the unmarked script, not to silence.
  assert.equal((await ask('be concise')).output, 'base answer');
  assert.equal((await adapter.sendTurn([{ kind: 'user', text: 'Fix A.' }], opts({ systemPrompt: 'be thorough' }))).text,
    'thorough answer', 'the in-process tier answers the same way');

  // With only a marked variant, a non-matching role prompt is a named error, not a wrong answer.
  const onlyMarked = new ScriptedAdapter([thorough]);
  const res = await onlyMarked.invoke(opts({ prompt: 'Fix A.', systemPrompt: 'be terse' }));
  assert.equal(res.success, false);
  assert.match(res.output, /no script for "Fix A\." matches this role prompt/);
});

test('two scripts for one prompt need distinct markers; a repeated marker is refused', () => {
  const a: ScriptedTask = { prompt: 'Fix A.', steps: [], final: 'x' };
  assert.throws(() => new ScriptedAdapter([a, a]), /two scripts answer the same prompt/);
  assert.throws(() => new ScriptedAdapter([{ ...a, systemContains: 'm' }, { ...a, systemContains: 'm' }]),
    /for the same system-prompt marker "m"/);
  assert.doesNotThrow(() => new ScriptedAdapter([a, { ...a, systemContains: 'm' }]));
});

test('the evolution loop is answered from the file: planner answers in order, the last one repeats', async () => {
  const evolution = { planner: ['plan 1', 'plan 2'], critic: ['verdict'] };
  const adapter = new ScriptedAdapter([], evolution);
  const ask = (systemPrompt: string) =>
    adapter.invoke(opts({ prompt: 'anything', systemPrompt: systemPrompt + ' and the rest of the prompt' }));
  assert.equal((await ask('You are the MAF harness evolution planner.')).output, 'plan 1');
  assert.equal((await ask('You are the MAF harness evolution planner.')).output, 'plan 2');
  assert.equal((await ask('You are the MAF harness evolution planner.')).output, 'plan 2', 'the last answer repeats');
  assert.equal((await ask('You are the MAF harness evolution critic.')).output, 'verdict');
  assert.equal((await ask('You are the MAF harness evolution critic.')).output, 'verdict');
  // The kinds are on the record, so a run can be audited against the file.
  assert.deepEqual(adapter.exchanges.map((e) => e.kind), ['planner', 'planner', 'planner', 'critic', 'critic']);
});

test('an unscripted planner call throws, naming the file section that is missing', async () => {
  const bare = new ScriptedAdapter([]);
  await assert.rejects(
    () => bare.invoke(opts({ prompt: 'x', systemPrompt: 'You are the MAF harness evolution planner. ...' })),
    /no script; add an "evolution\.planner" answer to scripted\.json/,
  );
});

test('the script file carries variants and the evolution answers, and refuses malformed ones', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-scripts-evo-'));
  const task: GoldenTask = {
    id: 'a', prompt: 'Do A.', repoFixture: 'fixtures/a', role: 'coder',
    verifiers: [{ kind: 'diff-match', mustContain: [], mustNotContain: [] }],
    provenance: { source: 'human-decision', ref: 'test' },
  };
  const write = (body: unknown) => writeFile(path.join(root, 'scripted.json'), JSON.stringify(body), 'utf8');
  try {
    await write({ version: 1, tasks: { a: [
      { steps: [], final: 'base' },
      { systemContains: 'thorough', steps: [], final: 'thorough' },
    ] }, evolution: { planner: ['p'], critic: ['c'] } });
    const bundle = await loadScriptedBundle(root, [task]);
    assert.deepEqual(bundle.tasks.map((t) => [t.final, t.systemContains]), [['base', undefined], ['thorough', 'thorough']]);
    assert.deepEqual(bundle.evolution, { planner: ['p'], critic: ['c'] });

    // Without an evolution section the bundle is just the task scripts (goldens run does not evolve).
    await write({ version: 1, tasks: { a: { steps: [], final: 'base' } } });
    assert.equal((await loadScriptedBundle(root, [task])).evolution, undefined);

    await write({ version: 1, tasks: { a: { systemContains: '', steps: [], final: 'x' } } });
    await assert.rejects(() => loadScriptedBundle(root, [task]), /"systemContains" must be a non-empty string/);
    await write({ version: 1, tasks: { a: { steps: [], final: 'x' } }, evolution: { planner: [] } });
    await assert.rejects(() => loadScriptedBundle(root, [task]), /"evolution\.planner" must be a non-empty array/);
    await write({ version: 1, tasks: { a: { steps: [], final: 'x' } }, evolution: { planner: ['p'] } });
    await assert.rejects(() => loadScriptedBundle(root, [task]), /"evolution\.critic" must be a non-empty array/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
