import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { AdapterInvokeOptions, AdapterInvokeResult, TurnAdapter } from '@maf/types';
import { TransportError } from '@maf/types';
import { ScriptedAdapter } from '@maf/eval-harness';
import { planGenerator } from '../commands/run.js';
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

test('maf run stops at a failed planner call instead of running its error text as a plan', needsLcm, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maf-planner-fail-'));
  try {
    const repo = await dirtyUserRepo(root);
    const before = await userState(repo);
    // `scripted` for the run's adapter name; its turns would run a node, which must not happen.
    const scripted = new ScriptedAdapter([]);
    const { adapter, calls } = answering(failed('Error: Credit balance is too low'));
    const run = await driveRun(['Fix the failing sum test', '--dir', repo, '--adapter', 'scripted'], {
      adapters: registryOf({ ...adapter, name: scripted.name }),
      io: { stdin: new PassThrough(), isTTY: false, env: { MAF_SIGNING_KEY: 'planner-key' } },
    });
    assert.match(messageOf(run.error), /the planner's call to adapter "scripted" was expected to succeed, but it reported failure \(exit code 1\)/);
    assert.match(messageOf(run.error), /Credit balance is too low/);
    assert.doesNotMatch(run.out, /node .* started/, 'no node ran');
    assert.equal(calls.length, 1, 'the planner was asked once, and nothing else was');
    assert.equal(calls[0]?.nativeTools, false);
    assert.match(run.err, /the run's worktree is kept for inspection/);
    assert.deepEqual(await userState(repo), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
