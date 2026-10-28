import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CliAdapter, AdapterInvokeOptions, AdapterInvokeResult, ModelSurfaceRecord } from '@maf/types';
import { GateRefused, TransportError, sha256Hex, withModelSurface } from '@maf/types';
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

// L1: the gate's reviewer call is a model call, and the live rows found it outside the record. One
// record per attempt, written before the verdict is parsed — a review that blocked is as much a
// model call as one that passed, and a timed-out one spent tokens too.
test('L1: reviewDiff() records one security-gate surface, naming the reviewed node', async () => {
  const records: ModelSurfaceRecord[] = [];
  const g = gate(fakeAdapter(CLEAN_RESULT), { recordSurface: (record) => records.push(record) });
  const diff = 'diff --git a/db.ts b/db.ts\n+exec(userInput)\n';
  await g.reviewDiff(diff, { nodeId: 'n7' });
  assert.equal(records.length, 1);
  const [record] = records;
  assert.ok(record);
  assert.deepEqual(record, {
    role: 'security', taskId: 'n7', turn: 1,
    systemPromptSha256: sha256Hex('You are a security auditor. Respond in strict JSON.'),
    promptSha256: sha256Hex(`Audit this diff for security issues. Respond with the strict JSON schema in your system prompt.\n\`\`\`diff\n${diff}\n\`\`\``),
    toolCatalog: '', outputSha256: sha256Hex(CLEAN_RESULT), argv: [],
    tier: 'cli', nativeTools: 'none', kind: 'security-gate',
    // R3-S1: this adapter reports no surface, so the gate's own digests are recorded and marked as
    // the fallback — the security role prompt is not the block a composing backend was sent.
    surfaceSource: 'fallback',
  });
});

test('L1: a blocking verdict is recorded too', async () => {
  const records: ModelSurfaceRecord[] = [];
  const blocking = JSON.stringify({ findings: [{ severity: 'critical', category: 'x', file: 'a.ts', line: 1, rationale: 'r', remediation: 'm' }], summary: 'bad', passed: false });
  const g = gate(fakeAdapter(blocking), { recordSurface: (record) => records.push(record) });
  const res = await g.reviewDiff('diff', { nodeId: 'n1' });
  assert.equal(res.passed, false);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.outputSha256, sha256Hex(blocking));
});

test('L1: a transport failure records its attempt before the throw', async () => {
  const records: ModelSurfaceRecord[] = [];
  const failing: CliAdapter = {
    ...fakeAdapter(CLEAN_RESULT),
    invoke: async (): Promise<AdapterInvokeResult> => ({
      success: false, output: '', toolCallLog: [], exitCode: 124, duration: 1,
      transportError: new TransportError('timed out'),
    }),
  };
  const g = gate(failing, { recordSurface: (record) => records.push(record) });
  await assert.rejects(() => g.reviewDiff('diff', { nodeId: 'n2' }), TransportError);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.outputSha256, sha256Hex(''));
});

// L1-S5: an adapter that throws is still a model call MAF made, and the tokens (if any) were
// spent. The record says so: the digests of what was sent, `outputSha256` absent rather than the
// digest of an empty string (Constitution §4: "not recorded" must differ from "recorded as empty"),
// and `error: 'thrown'`.
test('L1-S5: a throwing adapter still records the attempt, with no output digest', async () => {
  const records: ModelSurfaceRecord[] = [];
  const throwing: CliAdapter = {
    ...fakeAdapter(CLEAN_RESULT),
    invoke: async (): Promise<AdapterInvokeResult> => { throw new Error('spawn ENOENT'); },
  };
  const g = gate(throwing, { recordSurface: (record) => records.push(record) });
  const diff = 'diff --git a/b.ts b/b.ts\n+x\n';
  await assert.rejects(() => g.reviewDiff(diff, { nodeId: 'n9' }), /spawn ENOENT/);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.ok(record);
  assert.equal(record.error, 'thrown');
  assert.equal('outputSha256' in record, false, 'no output came back, so no digest is written');
  assert.equal(record.systemPromptSha256, sha256Hex('You are a security auditor. Respond in strict JSON.'));
  assert.equal(record.promptSha256, sha256Hex(
    `Audit this diff for security issues. Respond with the strict JSON schema in your system prompt.\n\`\`\`diff\n${diff}\n\`\`\``,
  ));
  assert.equal(record.taskId, 'n9');
  assert.equal(record.kind, 'security-gate');
});

test('L1: reviewPaths() records nativeTools full; no model call records nothing', async () => {
  const records: ModelSurfaceRecord[] = [];
  const g = gate(fakeAdapter(CLEAN_RESULT), { recordSurface: (record) => records.push(record) });
  await g.reviewDiff('   ');
  await g.reviewPaths([], '/repo');
  assert.equal(records.length, 0, 'a short-circuit made no model call');
  await g.reviewPaths(['src/a.ts'], '/repo', { nodeId: 'n3' });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.nativeTools, 'full');
  assert.equal(records[0]?.taskId, 'n3');
});

test('L1: a review outside a node names the gate, not a node', async () => {
  const records: ModelSurfaceRecord[] = [];
  const g = gate(fakeAdapter(CLEAN_RESULT), { recordSurface: (record) => records.push(record) });
  await g.reviewDiff('diff');
  assert.equal(records[0]?.taskId, 'security-gate');
});

test('L1: the model the gate was configured with is on the record', async () => {
  const records: ModelSurfaceRecord[] = [];
  const g = gate(fakeAdapter(CLEAN_RESULT), { model: 'claude-sonnet', recordSurface: (record) => records.push(record) });
  await g.reviewDiff('diff', { nodeId: 'n4' });
  assert.equal(records[0]?.model, 'claude-sonnet');
});

// R4-M1: the gate's thrown path prefers the surface the adapter attached — the reviewer's own
// account of the call — and only falls back to what the gate asked for. R4-L1: a foreign surface
// that does not validate is ignored, the fallback is recorded and marked, and the defect is warned
// about rather than silently dropped.

test('R4-M1: a throwing adapter\'s attached surface is what the gate records, not its fallback', async () => {
  const records: ModelSurfaceRecord[] = [];
  const surface = {
    systemPromptSha256: 'reviewer-sys', promptSha256: 'reviewer-prompt', toolCatalog: '',
    argv: ['claude', '--print', '--system-prompt', '<--system-prompt: 9 bytes, sha256 abc>'],
  };
  const throwing: CliAdapter = {
    ...fakeAdapter(CLEAN_RESULT),
    invoke: async (): Promise<AdapterInvokeResult> => {
      throw withModelSurface(new Error('the reviewer failed'), surface);
    },
  };
  const g = gate(throwing, { recordSurface: (record) => records.push(record) });
  await assert.rejects(() => g.reviewDiff('diff --git a/b.ts b/b.ts\n+x\n', { nodeId: 'n9' }), /the reviewer failed/);
  assert.deepEqual(records[0], {
    role: 'security', taskId: 'n9', turn: 1, ...surface,
    tier: 'cli', nativeTools: 'none', kind: 'security-gate', error: 'thrown',
  });
  assert.equal('surfaceSource' in (records[0] ?? {}), false, 'the adapter described the call');
});

test('R4-L1: a malformed attached surface is ignored, the fallback is recorded, and a warning is emitted', async () => {
  const records: ModelSurfaceRecord[] = [];
  const warnings: string[] = [];
  const malformed = Object.assign(new Error('the reviewer failed'), {
    modelSurface: { systemPromptSha256: 'sys', toolCatalog: '', argv: 'not-an-array' },
  });
  const throwing: CliAdapter = {
    ...fakeAdapter(CLEAN_RESULT),
    invoke: async (): Promise<AdapterInvokeResult> => { throw malformed; },
  };
  const g = gate(throwing, {
    recordSurface: (record) => records.push(record),
    warn: (line) => warnings.push(line),
  });
  await assert.rejects(() => g.reviewDiff('diff --git a/b.ts b/b.ts\n+x\n'), /the reviewer failed/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /not a valid model surface/);
  assert.equal(records[0]?.surfaceSource, 'fallback');
  assert.equal(records[0]?.error, 'thrown');
  assert.equal(records[0]?.systemPromptSha256, sha256Hex('You are a security auditor. Respond in strict JSON.'));
});

test('R4-L2: a gate call that never left the adapter is recorded as not-sent', async () => {
  const records: ModelSurfaceRecord[] = [];
  const unsent = new Error('no model configured; no request was sent');
  const throwing: CliAdapter = {
    ...fakeAdapter(CLEAN_RESULT),
    invoke: async (): Promise<AdapterInvokeResult> => { throw withModelSurface(unsent, {
      systemPromptSha256: 'sys', promptSha256: 'prompt', toolCatalog: '', argv: [],
    }, false); },
  };
  const g = gate(throwing, { recordSurface: (record) => records.push(record) });
  await assert.rejects(() => g.reviewDiff('diff --git a/b.ts b/b.ts\n+x\n'), /no model configured/);
  assert.equal(records[0]?.error, 'not-sent');
  assert.equal('outputSha256' in (records[0] ?? {}), false);
});
