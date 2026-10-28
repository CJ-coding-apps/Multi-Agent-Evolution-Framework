import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterInvokeOptions, AdapterInvokeResult, CliAdapter, ModelSurfaceRecord } from '@maf/types';
import { TransportError } from '@maf/types';
import { SecurityReviewGate } from '@maf/git-ops';
import { makeSurfaceRecorder, planGenerator } from '../commands/run.js';

// R3-M1: the surface record is evidence *about* a call; it does not outrank the call. Both call
// sites write it from a `finally`, so a recorder that throws would replace the call's own error —
// or turn a valid result into a throw — with a transcript error. `makeSurfaceRecorder` is the one
// recorder both use, and it reports a failure on stderr instead of letting it escape. These tests
// drive it through the real planner and the real gate with a store that refuses every write.
//
// Both stores are exercised: the bundle's `recordModelSurface` (here, first in the order) and the
// transcript's `append`. A mutant that rethrows in either catch arm turns one of these red.

const NO_WAIT = { maxAttempts: 1, backoffMs: 0, backoffFactor: 1, jitterMs: 0 };
const PLAN = '```json\n{"nodes":[]}\n```';
const DIFF = 'diff --git a/b.ts b/b.ts\n+x\n';
const CLEAN = JSON.stringify({ findings: [], summary: 'clean', passed: true });

/** The recorder, with whichever store the caller says refuses the write. */
function recorderRefusedBy(
  which: 'bundle' | 'transcript',
  warnings: string[],
): (record: ModelSurfaceRecord) => Promise<void> {
  return makeSurfaceRecorder(
    { recordModelSurface() { if (which === 'bundle') throw new Error('the bundle refused the record'); } },
    { async append() { if (which === 'transcript') throw new Error('the transcript refused the record'); } },
    (line) => warnings.push(line),
  );
}

function adapterThat(invoke: (opts: AdapterInvokeOptions) => Promise<AdapterInvokeResult>): CliAdapter {
  return {
    name: 'claude',
    capabilities: () => ({
      supportsStreaming: false, supportsToolCalling: false, supportsWorktrees: false,
      inProcessLoop: false, maxConcurrentTasks: 1, nativePlugins: [],
    }),
    isAvailable: async () => true,
    invoke,
    stream: async function* () { yield ''; },
  };
}

const ok = (output: string): AdapterInvokeResult =>
  ({ success: true, output, toolCallLog: [], exitCode: 0, duration: 1 });

for (const which of ['bundle', 'transcript'] as const) {
  test(`R3-M1: a surface write the ${which} refuses leaves the planner's plan unchanged`, async () => {
    const warnings: string[] = [];
    const generate = planGenerator(adapterThat(async () => ok(PLAN)), {
      workingDir: '/w', timeoutMs: 1, retry: NO_WAIT,
      recordSurface: recorderRefusedBy(which, warnings),
    });

    assert.equal(await generate('system', 'user'), PLAN, 'the plan the call produced survives its unrecorded surface');
    assert.equal(warnings.length, 1, 'the failure is reported, not swallowed silently');
    assert.match(warnings[0] ?? '', /could not record the planner surface \(turn 1\): the /);
  });

  test(`R3-M1: a surface write the ${which} refuses does not replace the planner's own error`, async () => {
    const warnings: string[] = [];
    const generate = planGenerator(adapterThat(async () => { throw new Error('spawn claude ENOENT'); }), {
      workingDir: '/w', timeoutMs: 1, retry: NO_WAIT,
      recordSurface: recorderRefusedBy(which, warnings),
    });

    await assert.rejects(() => generate('system', 'user'), (err: Error) => {
      assert.match(err.message, /spawn claude ENOENT/, 'the call\'s error, not the recorder\'s');
      assert.doesNotMatch(err.message, /refused the record/);
      return true;
    });
    assert.equal(warnings.length, 1, 'the failed write is still reported');
  });

  test(`R3-M1: a surface write the ${which} refuses leaves the gate's verdict unchanged`, async () => {
    const warnings: string[] = [];
    const gate = new SecurityReviewGate({
      adapter: adapterThat(async () => ok(CLEAN)),
      projectRoot: '/tmp',
      securityPrompt: 'You are a security auditor. Respond in strict JSON.',
      recordSurface: recorderRefusedBy(which, warnings),
    });

    const result = await gate.reviewDiff(DIFF, { nodeId: 'n1' });
    assert.equal(result.passed, true, 'a clean review is still a clean review');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /could not record the security-gate surface \(turn 1\): the /);
  });

  test(`R3-M1: a surface write the ${which} refuses does not replace the gate's transport error`, async () => {
    const warnings: string[] = [];
    const failure = new TransportError('"claude" did not finish within 5000 ms and was killed (exit code 124).');
    const gate = new SecurityReviewGate({
      adapter: adapterThat(async () => { throw failure; }),
      projectRoot: '/tmp',
      securityPrompt: 'You are a security auditor. Respond in strict JSON.',
      recordSurface: recorderRefusedBy(which, warnings),
    });

    await assert.rejects(() => gate.reviewDiff(DIFF, { nodeId: 'n1' }), (err: unknown) => {
      assert.equal(err, failure, 'the same retryable error the adapter threw');
      return true;
    });
    assert.equal(warnings.length, 1);
  });
}
