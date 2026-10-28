import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { AdapterInvokeOptions, AdapterInvokeResult, ModelSurfaceRecord, TurnAdapter } from '@maf/types';
import { TransportError, sha256Hex } from '@maf/types';
import { ScriptedAdapter } from '@maf/eval-harness';
import { planGenerator } from '../commands/run.js';
import { attestVerify } from '../commands/attest.js';
import { dirtyUserRepo, driveRun, messageOf, needsLcm, registryOf, userState } from './runFixture.js';

// ORACLE (F4 and F6 of the 0.3.0 release audit). The planner's call is a cli-tier `invoke` that needs
// only text, and it kept the backend's own tools (F4): it now asks for none. Its result's `success`
// and `transportError` were never read (F6): a failed call's output — the error text — was parsed as
// a plan, and became one default-role node whose `planText` was the error. A failed call is now an
// error; a transport failure is retried once, as a node's is (D-06).

const NO_WAIT = { maxAttempts: 2, backoffMs: 0, backoffFactor: 1, jitterMs: 0 };
const PLAN = '```json\n{"nodes":[]}\n```';

function answering(...results: AdapterInvokeResult[]): { adapter: TurnAdapter; calls: AdapterInvokeOptions[] } {
  const calls: AdapterInvokeOptions[] = [];
  const adapter: TurnAdapter = {
    name: 'claude',
    capabilities: () => ({
      supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: true,
      inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
    }),
    isAvailable: async () => true,
    invoke: async (opts) => {
      calls.push(opts);
      const next = results[Math.min(calls.length, results.length) - 1];
      assert.ok(next, 'the test scripted an answer for this call');
      return next;
    },
    stream: async function* () { yield ''; },
    sendTurn: async () => { throw new Error('no node should run'); },
  };
  return { adapter, calls };
}

const ok = (output: string): AdapterInvokeResult => ({ success: true, output, toolCallLog: [], exitCode: 0, duration: 1 });
const failed = (output: string, exitCode = 1): AdapterInvokeResult => ({ success: false, output, toolCallLog: [], exitCode, duration: 1 });
const dropped = (): AdapterInvokeResult => ({
  success: false, output: '', toolCallLog: [], exitCode: 124, duration: 1,
  transportError: new TransportError('"claude" did not finish within 5 ms and was killed (exit code 124).'),
});

test('the planner asks for text only: nativeTools is false, and the call is what the run configured', async () => {
  const { adapter, calls } = answering(ok(PLAN));
  const generate = planGenerator(adapter, { workingDir: '/work/tree', timeoutMs: 1234, retry: NO_WAIT, model: 'opus' });
  assert.equal(await generate('system', 'user'), PLAN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.nativeTools, false);
  assert.deepEqual(
    { prompt: calls[0]?.prompt, systemPrompt: calls[0]?.systemPrompt, workingDir: calls[0]?.workingDir, timeoutMs: calls[0]?.timeoutMs, model: calls[0]?.model },
    { prompt: 'user', systemPrompt: 'system', workingDir: '/work/tree', timeoutMs: 1234, model: 'opus' },
  );
});

test('a planner call that reports failure is an error naming the adapter and the output, and is not retried', async () => {
  const { adapter, calls } = answering(failed('Credit balance is too low'));
  const generate = planGenerator(adapter, { workingDir: '/w', timeoutMs: 1, retry: NO_WAIT });
  await assert.rejects(() => generate('s', 'u'), (err: Error) => {
    assert.ok(!(err instanceof TransportError));
    assert.match(err.message, /^the planner's call to adapter "claude" was expected to succeed, but it reported failure \(exit code 1\), so there is no plan to run\. Output tail: "Credit balance is too low"$/);
    return true;
  });
  assert.equal(calls.length, 1, 'a judged failure is not retried');
});

test('a transport failure is retried once; a second one is the error', async () => {
  const recovered = answering(dropped(), ok(PLAN));
  assert.equal(await planGenerator(recovered.adapter, { workingDir: '/w', timeoutMs: 1, retry: NO_WAIT })('s', 'u'), PLAN);
  assert.equal(recovered.calls.length, 2);

  const lost = answering(dropped(), dropped());
  await assert.rejects(() => planGenerator(lost.adapter, { workingDir: '/w', timeoutMs: 1, retry: NO_WAIT })('s', 'u'), TransportError);
  assert.equal(lost.calls.length, 2, 'two attempts, as a node gets');
});

/**
 * Drives `maf run` through a planning failure with `adapter` standing in for `scripted`, and reads
 * back the three things L1-S2 promises: the printed bundle path, the signed statement on disk (which
 * `maf attest verify` — `attestVerify` is that command minus the process — accepts), and the
 * transcript written before the failure.
 */
async function failingPlanningRun(adapter: TurnAdapter, root: string) {
  const repo = await dirtyUserRepo(root);
  const before = await userState(repo);
  const scripted = new ScriptedAdapter([]);
  const run = await driveRun(['Fix the failing sum test', '--dir', repo, '--adapter', 'scripted'], {
    adapters: registryOf({ ...adapter, name: scripted.name }),
    io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'planner-key' } },
  });
  const printed = /Attestation: (.+\.bundle\.json)/.exec(run.out);
  assert.ok(printed?.[1], `a failed planning run prints the path of its bundle; it printed: ${run.out}`);
  const bundlePath = printed[1];
  const statement = JSON.parse(await readFile(bundlePath, 'utf8')) as {
    subject:   unknown[];
    predicate: { outcome: Record<string, unknown>; modelSurfaces?: Array<Record<string, unknown>> };
  };
  const verdict = await attestVerify(bundlePath, { secret: 'planner-key' });
  const logDir = path.join(repo, '.maf', 'transcripts');
  const transcript = (await Promise.all(
    (await readdir(logDir)).map((file) => readFile(path.join(logDir, file), 'utf8')),
  )).join('');
  return { repo, before, run, bundlePath, statement, verdict, transcript };
}

test('L1-S2: a judged planner failure stops the run, keeps the tree, and writes a signed planning_failed bundle', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-planner-fail-'));
  try {
    const { adapter, calls } = answering(failed('Error: Credit balance is too low'));
    const { repo, before, run, statement, verdict, transcript } = await failingPlanningRun(adapter, root);
    assert.match(messageOf(run.error), /the planner's call to adapter "scripted" was expected to succeed, but it reported failure \(exit code 1\)/);
    assert.match(messageOf(run.error), /Credit balance is too low/);
    assert.doesNotMatch(run.out, /node .* started/, 'no node ran');
    assert.equal(calls.length, 1, 'the planner was asked once, and nothing else was');
    assert.equal(calls[0]?.nativeTools, false);
    assert.match(run.err, /the run's worktree is kept for inspection/);
    assert.deepEqual(await userState(repo), before);

    // L1-S2: the run is attested like any other — status, verdict and no subjects, since no node ran.
    assert.deepEqual(statement.predicate.outcome, {
      status: 'Failed', unscheduled: [], failure: { kind: 'planning_failed' },
    });
    assert.deepEqual(statement.subject, [], 'no diff, so no subject: the run had nothing to review');
    assert.deepEqual(verdict.lines, [
      'valid: true',
      'keySource: env (checked against MAF_SIGNING_KEY)',
      'subjects: 0',
    ], '`maf attest verify` accepts a planning-failure bundle, signed with the key the run used');
    assert.equal(verdict.failure, undefined);
    // S9: the surface reached the transcript as the call was made, before the bundle existed.
    assert.match(transcript, /\[surface\] planner turn 1: system sha256 /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('L1-S2: transport failures that exhaust the retries write the same bundle, holding every attempt', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-planner-transport-'));
  try {
    const { adapter, calls } = answering(dropped(), dropped());
    const { run, statement, verdict } = await failingPlanningRun(adapter, root);
    assert.ok(run.error instanceof TransportError, 'the transport failure is what the run reports');
    assert.equal(calls.length, 2, 'the planner was retried once under the default policy');
    assert.deepEqual(statement.predicate.outcome, {
      status: 'Failed', unscheduled: [], failure: { kind: 'planning_failed' },
    });
    assert.equal(statement.predicate.modelSurfaces?.length, 2, 'both attempts are in the bundle');
    assert.deepEqual(statement.predicate.modelSurfaces?.map((s) => s['kind']), ['planner', 'planner']);
    assert.equal(verdict.failure, undefined, 'and the bundle verifies');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('L1-S2: a planner call whose adapter throws writes the same bundle, with no output digest', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-planner-throw-'));
  try {
    const calls: AdapterInvokeOptions[] = [];
    const throwing: TurnAdapter = {
      name: 'claude',
      capabilities: () => ({
        supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: true,
        inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
      }),
      isAvailable: async () => true,
      invoke: async (opts) => { calls.push(opts); throw new Error('spawn claude ENOENT'); },
      stream: async function* () { yield ''; },
      sendTurn: async () => { throw new Error('no node should run'); },
    };
    const { run, statement, verdict } = await failingPlanningRun(throwing, root);
    assert.match(messageOf(run.error), /spawn claude ENOENT/);
    assert.equal(calls.length, 1, 'a throw is not a transport failure, so it is not retried');
    assert.deepEqual(statement.predicate.outcome, {
      status: 'Failed', unscheduled: [], failure: { kind: 'planning_failed' },
    });
    const [surface] = statement.predicate.modelSurfaces ?? [];
    assert.ok(surface, 'the attempt is in the bundle');
    assert.equal(surface['kind'], 'planner');
    assert.equal(surface['error'], 'thrown');
    assert.equal('outputSha256' in surface, false, 'no output came back, so none is claimed');
    assert.equal(verdict.failure, undefined, 'and the bundle verifies');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// L1: the planner's call is a model call MAF makes on every run, and it was the one the live rows
// found outside the record. Every attempt records one surface, including the attempts that fail —
// a call that spent tokens and returned an error is exactly as worth accounting for as one that
// planned the DAG.
test('L1: a successful planner call records one surface with the call\'s digests', async () => {
  const records: ModelSurfaceRecord[] = [];
  const { adapter } = answering(ok(PLAN));
  const generate = planGenerator(adapter, {
    workingDir: '/w', timeoutMs: 1, retry: NO_WAIT, model: 'opus',
    recordSurface: (record) => records.push(record),
  });
  assert.equal(await generate('system text', 'user text'), PLAN);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    role: 'planner', taskId: 'planner', turn: 1,
    systemPromptSha256: sha256Hex('system text'),
    promptSha256: sha256Hex('user text'),
    toolCatalog: '', outputSha256: sha256Hex(PLAN), argv: [],
    tier: 'cli', nativeTools: 'none', kind: 'planner',
    // R3-S1: this adapter reports no surface, so the call site's digests are recorded and marked
    // as the fallback — the planner's role prompt is not the block a composing backend was sent.
    surfaceSource: 'fallback',
    model: 'opus',
  });
});

test('L1: a failed planner call records its surface before the error, once', async () => {
  const records: ModelSurfaceRecord[] = [];
  const { adapter, calls } = answering(failed('Credit balance is too low'));
  const generate = planGenerator(adapter, {
    workingDir: '/w', timeoutMs: 1, retry: NO_WAIT,
    recordSurface: (record) => records.push(record),
  });
  await assert.rejects(() => generate('s', 'u'), /Credit balance is too low/);
  assert.equal(calls.length, 1);
  assert.equal(records.length, 1, 'the one attempt is in the record');
  assert.equal(records[0]?.kind, 'planner');
  assert.equal(records[0]?.outputSha256, sha256Hex('Credit balance is too low'));
  assert.equal('model' in (records[0] ?? {}), false, 'the call named no model');
});

test('L1: a transport failure records each attempt, then propagates', async () => {
  const records: ModelSurfaceRecord[] = [];
  const { adapter } = answering(dropped(), dropped());
  await assert.rejects(
    () => planGenerator(adapter, {
      workingDir: '/w', timeoutMs: 1, retry: NO_WAIT,
      recordSurface: (record) => records.push(record),
    })('s', 'u'),
    TransportError,
  );
  assert.equal(records.length, 2, 'two attempts, two records');
});

// L1-S5: an adapter that throws (a missing binary, a permission error) is still a planning call
// MAF made. Its prompt digests are known, no output came back — so `outputSha256` is absent, not the
// digest of an empty string — and the record says why with `error: 'thrown'`.
test('L1-S5: a planner call whose adapter throws still records the attempt, with no output digest', async () => {
  const records: ModelSurfaceRecord[] = [];
  const calls: AdapterInvokeOptions[] = [];
  const throwing: TurnAdapter = {
    name: 'claude',
    capabilities: () => ({
      supportsStreaming: false, supportsToolCalling: true, supportsWorktrees: true,
      inProcessLoop: true, maxConcurrentTasks: 1, nativePlugins: [],
    }),
    isAvailable: async () => true,
    invoke: async (opts) => { calls.push(opts); throw new Error('spawn claude ENOENT'); },
    stream: async function* () { yield ''; },
    sendTurn: async () => { throw new Error('no node should run'); },
  };
  await assert.rejects(
    () => planGenerator(throwing, {
      workingDir: '/w', timeoutMs: 1, retry: NO_WAIT,
      recordSurface: (record) => records.push(record),
    })('system text', 'user text'),
    /spawn claude ENOENT/,
  );
  assert.equal(calls.length, 1, 'a throw is not a transport failure, so it is not retried');
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    role: 'planner', taskId: 'planner', turn: 1,
    systemPromptSha256: sha256Hex('system text'),
    promptSha256: sha256Hex('user text'),
    toolCatalog: '', argv: [],
    tier: 'cli', nativeTools: 'none', kind: 'planner', error: 'thrown',
    // R3-S1: this adapter attached no surface to its error, so the call site's own digests are
    // recorded and marked as the fallback — they are the planner's role prompt, not a block a
    // backend composed.
    surfaceSource: 'fallback',
  });
});

test('L1: a surface the adapter reports is kept rather than reconstructed', async () => {
  const records: ModelSurfaceRecord[] = [];
  const surface = {
    systemPromptSha256: 'sys', promptSha256: 'prompt', toolCatalog: '',
    outputSha256: 'out', argv: ['claude', '--tools', ''],
  };
  const { adapter } = answering({ ...ok(PLAN), modelSurface: surface });
  await planGenerator(adapter, {
    workingDir: '/w', timeoutMs: 1, retry: NO_WAIT,
    recordSurface: (record) => records.push(record),
  })('s', 'u');
  assert.deepEqual(records[0], {
    role: 'planner', taskId: 'planner', turn: 1, ...surface,
    tier: 'cli', nativeTools: 'none', kind: 'planner',
  });
});
