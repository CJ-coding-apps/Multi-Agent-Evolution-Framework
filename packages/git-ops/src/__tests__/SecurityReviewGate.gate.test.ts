import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CliAdapter, AdapterInvokeOptions, AdapterInvokeResult } from '@maf/types';
import { SecurityReviewGate } from '../SecurityReviewGate.js';

const CLEAN_RESULT = JSON.stringify({ findings: [], summary: 'clean', passed: true });

function fakeAdapter(
  output: string,
  capture?: { opts?: AdapterInvokeOptions; calls?: number },
): CliAdapter {
  return {
    name: 'claude',
    capabilities: () => ({
      supportsStreaming: false, supportsToolCalling: false, inProcessLoop: false,
      supportsWorktrees: false, maxConcurrentTasks: 1, nativePlugins: [],
    }),
    isAvailable: async () => true,
    invoke: async (opts: AdapterInvokeOptions): Promise<AdapterInvokeResult> => {
      if (capture) {
        capture.opts = opts;
        capture.calls = (capture.calls ?? 0) + 1;
      }
      return { success: true, output, toolCallLog: [], exitCode: 0, duration: 1 };
    },
    stream: async function* () { yield output; },
  };
}

const gate = (adapter: CliAdapter, extra: Partial<ConstructorParameters<typeof SecurityReviewGate>[0]> = {}) =>
  new SecurityReviewGate({
    adapter,
    projectRoot: '/tmp',
    securityPrompt: 'You are a security auditor. Respond in strict JSON.',
    ...extra,
  });

test('reviewDiff() passes an empty diff without invoking the adapter', async () => {
  const capture: { opts?: AdapterInvokeOptions; calls?: number } = {};
  const g = gate(fakeAdapter(CLEAN_RESULT, capture));
  const res = await g.reviewDiff('   \n  ');
  assert.equal(res.passed, true);
  assert.equal(res.findings.length, 0);
  assert.equal(capture.calls ?? 0, 0, 'adapter must not be invoked for empty diff');
});

test('reviewDiff() sends the diff and the configured security system prompt', async () => {
  const capture: { opts?: AdapterInvokeOptions } = {};
  const g = gate(fakeAdapter(CLEAN_RESULT, capture));
  await g.reviewDiff('diff --git a/db.ts b/db.ts\n+exec(userInput)\n');
  assert.match(capture.opts?.prompt ?? '', /\+exec\(userInput\)/);
  assert.match(capture.opts?.systemPrompt ?? '', /security auditor/);
  assert.equal(capture.opts?.timeoutMs, 120_000);
});

test('reviewDiff() truncates oversized diffs to keep the prompt bounded', async () => {
  const capture: { opts?: AdapterInvokeOptions } = {};
  const g = gate(fakeAdapter(CLEAN_RESULT, capture));
  await g.reviewDiff('y'.repeat(100_000));
  const prompt = capture.opts?.prompt ?? '';
  assert.ok(prompt.length < 17_000, `prompt length ${prompt.length} should be bounded to ~16k`);
});

test('reviewDiff() surfaces blocking findings from the adapter output', async () => {
  const output = JSON.stringify({
    findings: [{
      severity: 'critical', category: 'command-injection', file: 'db.ts',
      line: 3, rationale: 'user input reaches exec', remediation: 'sanitize',
    }],
    summary: 'one critical',
    passed: false,
  });
  const g = gate(fakeAdapter(output));
  const res = await g.reviewDiff('diff');
  assert.equal(res.passed, false);
  assert.equal(res.findings[0]?.severity, 'critical');
  assert.equal(res.findings[0]?.line, 3);
});

test('reviewPaths() passes an empty path list without invoking the adapter', async () => {
  const capture: { opts?: AdapterInvokeOptions; calls?: number } = {};
  const g = gate(fakeAdapter(CLEAN_RESULT, capture));
  const res = await g.reviewPaths([], '/repo');
  assert.equal(res.passed, true);
  assert.equal(capture.calls ?? 0, 0);
});

test('reviewPaths() lists every file and the working directory in the prompt', async () => {
  const capture: { opts?: AdapterInvokeOptions } = {};
  const g = gate(fakeAdapter(CLEAN_RESULT, capture));
  await g.reviewPaths(['src/a.ts', 'src/b.ts'], '/repo/root');
  const prompt = capture.opts?.prompt ?? '';
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /src\/b\.ts/);
  assert.match(prompt, /\/repo\/root/);
});

test('model and timeout overrides are forwarded to the adapter', async () => {
  const capture: { opts?: AdapterInvokeOptions } = {};
  const g = gate(fakeAdapter(CLEAN_RESULT, capture), { model: 'claude-sonnet', timeoutMs: 9_000 });
  await g.reviewDiff('diff');
  assert.equal(capture.opts?.model, 'claude-sonnet');
  assert.equal(capture.opts?.timeoutMs, 9_000);
});

test('unparseable adapter output fails closed', async () => {
  const g = gate(fakeAdapter('I refuse to answer in JSON'));
  const res = await g.reviewDiff('diff');
  assert.equal(res.passed, false);
  assert.match(res.summary, /Could not parse/);
});
