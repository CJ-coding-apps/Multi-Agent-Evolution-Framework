import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterInvokeOptions, AdapterInvokeResult, CliAdapter } from '@maf/types';
import {
  JUDGE_SYSTEM_PROMPT, judgePrompt, formatJudgeVerdict, parseJudgeVerdict, describeJudge, makeLlmJudge,
} from '../index.js';

// ORACLE: D-14 and the v0.2.0 audit's eval bullets — the judge prompt and its parser must be one
// contract (JSON `{passed}`), and the corpus's rubrics told the judge to "Respond 'PASS'", which
// the parser read as unparseable: every llm-judge task failed whatever the subject said. The
// judge was also the agent's own adapter and model, and nothing recorded that.

const SEED_RUBRICS = path.resolve(__dirname, '../../../../tests/goldens/rubrics');

test('the response shape the judge prompt shows is the shape the parser reads', () => {
  const example = /```json\n([\s\S]*?)\n```/.exec(JUDGE_SYSTEM_PROMPT)?.[1];
  assert.ok(example, 'the judge prompt must show the response shape it wants');
  assert.deepEqual(parseJudgeVerdict(`\`\`\`json\n${example}\n\`\`\``), { passed: false, rationale: 'one concise sentence' });
  for (const v of [{ passed: true, rationale: 'meets all three' }, { passed: false, rationale: 'no remediation' }]) {
    assert.deepEqual(parseJudgeVerdict(formatJudgeVerdict(v)), v);
  }
});

test('the parser takes the verdict as models actually write it, and fails closed on anything else', () => {
  assert.deepEqual(parseJudgeVerdict('Verdict:\n```json\n{"passed": true, "rationale": "ok"}```'), { passed: true, rationale: 'ok' },
    'a closing fence on the same line as the JSON is still the verdict');
  assert.deepEqual(parseJudgeVerdict('{"passed": true, "rationale": "bare"}'), { passed: true, rationale: 'bare' });
  assert.equal(parseJudgeVerdict('```json\n{"passed": false}\n```\nOn reflection:\n```json\n{"passed": true}\n```').passed, true,
    'the last block is the answer');
  for (const bad of ['PASS', '```json\n{"passed": "true"}\n```', '{"rationale": "no verdict"}', '']) {
    const v = parseJudgeVerdict(bad);
    assert.equal(v.passed, false, `${JSON.stringify(bad)} must fail closed`);
    assert.match(v.rationale, /failing closed/);
  }
});

test('no committed rubric asks the judge for a different answer format than the parser reads', async () => {
  const names = (await readdir(SEED_RUBRICS)).filter((n) => n.endsWith('.md'));
  assert.ok(names.length > 0, `expected rubrics under ${SEED_RUBRICS}`);
  for (const name of names) {
    const text = await readFile(path.join(SEED_RUBRICS, name), 'utf8');
    assert.doesNotMatch(text, /\brespond\b|\banswer with\b|\breply\b|^\s*(Rubric:\s*)?PASS\b/im, `${name} must state criteria, not an answer format`);
  }
});

test('the judge disclosure says when the agent judged itself', () => {
  assert.deepEqual(describeJudge({ adapter: 'claude' }, { adapter: 'claude' }), {
    adapter: 'claude', model: 'default', distinct: false,
    note: 'No second model was available: the agent\'s own adapter and model judged its output.',
  });
  assert.deepEqual(describeJudge({ adapter: 'claude', model: 'a' }, { adapter: 'claude', model: 'b' }),
    { adapter: 'claude', model: 'b', distinct: true });
  assert.equal(describeJudge({ adapter: 'claude' }, { adapter: 'gemini' }).distinct, true);
});

test('the judge runs as the judge — its own prompt, no tools — and a failed judge call is a failed verdict', async () => {
  const calls: AdapterInvokeOptions[] = [];
  let reply: Pick<AdapterInvokeResult, 'success' | 'output' | 'exitCode'> = { success: true, output: formatJudgeVerdict({ passed: true, rationale: 'r' }), exitCode: 0 };
  const adapter: CliAdapter = {
    name: 'judge-model',
    capabilities: () => ({ supportsStreaming: false, supportsToolCalling: false, supportsWorktrees: false, inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [] }),
    isAvailable: async () => true,
    invoke: async (o) => { calls.push(o); return { ...reply, toolCallLog: [], duration: 0 }; },
    stream: async function* () { yield ''; },
  };
  const judge = makeLlmJudge({ adapter, model: 'm2' }, '/work');
  assert.deepEqual(await judge('RUB', 'SUBJ'), { passed: true, rationale: 'r' });
  assert.equal(calls[0]?.systemPrompt, JUDGE_SYSTEM_PROMPT);
  assert.equal(calls[0]?.prompt, judgePrompt('RUB', 'SUBJ'));
  assert.equal(calls[0]?.tools, undefined, 'the judge is handed no tools');
  assert.deepEqual([calls[0]?.model, calls[0]?.temperature], ['m2', 0]);

  reply = { success: false, output: formatJudgeVerdict({ passed: true, rationale: 'stale' }), exitCode: 124 };
  const failed = await judge('RUB', 'SUBJ');
  assert.equal(failed.passed, false, 'output from a failed call is not a verdict');
  assert.match(failed.rationale, /exit code 124/);
});
