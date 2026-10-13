import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CliAdapter, AdapterInvokeOptions, AdapterInvokeResult } from '@maf/types';
import { GateRefused } from '@maf/types';
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

// ORACLE (F4 of the 0.3.0 release audit): the diff the reviewer reads was written by the agent, and
// with claude's own tools the reviewer could edit the tree after the review that passed it. The diff
// review asks for text only; the path review, which tells the reviewer to read the files, keeps them.
test('reviewDiff() asks the adapter for no native tools; reviewPaths() keeps them', async () => {
  const capture: { opts?: AdapterInvokeOptions } = {};
  const g = gate(fakeAdapter(CLEAN_RESULT, capture));
  await g.reviewDiff('diff --git a/db.ts b/db.ts\n+exec(userInput)\n');
  assert.equal(capture.opts?.nativeTools, false);
  await g.reviewPaths(['src/a.ts'], '/repo/root');
  assert.equal(capture.opts?.nativeTools, undefined, 'the default: the backend keeps its tools');
});

// ORACLE: D-07 — the gate used to send `diff.slice(0, 16000)` and attest the whole change as
// reviewed. A diff over the cap is now a refusal, never a slice: no model call, and an error
// that names the size and the cap so the user knows what to change.

/** Asserts a `GateRefused` for an oversized diff, with nothing reviewed. */
function oversizedRefusal(size: number, cap: number) {
  return (err: unknown): boolean => {
    if (!(err instanceof GateRefused)) assert.fail(`expected GateRefused, got ${String(err)}`);
    assert.match(err.message, new RegExp(`refuses a ${size}-character diff`));
    assert.match(err.message, new RegExp(`review cap is ${cap} characters`));
    assert.deepEqual(err.findings, [], 'nothing was reviewed, so nothing was found');
    return true;
  };
}

test('reviewDiff() refuses a diff over the default 60,000-character cap without invoking the model', async () => {
  const capture: { opts?: AdapterInvokeOptions; calls?: number } = {};
  const g = gate(fakeAdapter(CLEAN_RESULT, capture));
  await assert.rejects(() => g.reviewDiff('y'.repeat(60_001)), oversizedRefusal(60_001, 60_000));
  assert.equal(capture.calls ?? 0, 0, 'an oversized diff must never reach the model, sliced or whole');
});

test('reviewDiff() sends a diff exactly at the default cap whole', async () => {
  const capture: { opts?: AdapterInvokeOptions; calls?: number } = {};
  const g = gate(fakeAdapter(CLEAN_RESULT, capture));
  // Distinct head and tail markers, so a slice from either end would be caught.
  const diff = `HEAD-MARKER${'y'.repeat(60_000 - 'HEAD-MARKER'.length - 'TAIL-MARKER'.length)}TAIL-MARKER`;
  assert.equal(diff.length, 60_000);
  const res = await g.reviewDiff(diff);
  assert.equal(res.passed, true);
  assert.equal(capture.calls, 1);
  assert.ok((capture.opts?.prompt ?? '').includes(diff), 'the prompt must carry the diff unsliced');
});

test('reviewDiff() honours a configured cap in both directions', async () => {
  const capture: { opts?: AdapterInvokeOptions; calls?: number } = {};
  const g = gate(fakeAdapter(CLEAN_RESULT, capture), { maxDiffChars: 100 });
  await assert.rejects(() => g.reviewDiff('z'.repeat(101)), oversizedRefusal(101, 100));
  assert.equal(capture.calls ?? 0, 0);

  const atCap = 'z'.repeat(100);
  await g.reviewDiff(atCap);
  assert.equal(capture.calls, 1);
  assert.ok((capture.opts?.prompt ?? '').includes(atCap));
});

test('a cap that is not a positive safe integer is refused at construction', () => {
  // NaN is the dangerous one: `length > NaN` is always false, so the gate would send anything.
  for (const bad of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => gate(fakeAdapter(CLEAN_RESULT), { maxDiffChars: bad }),
      /maxDiffChars must be a positive safe integer/,
      `maxDiffChars ${String(bad)} must be refused`,
    );
  }
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
