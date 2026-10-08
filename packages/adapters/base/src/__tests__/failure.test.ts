import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransportError } from '@maf/types';
import { FAILURE_TAIL_CHARS, failureTail, turnStdout } from '../index.js';
import type { SpawnResult } from '../index.js';

// ORACLE (F4; D-04, D-06): a turn whose process did not finish cleanly is never parsed as a turn.
// The empty stdout of a timed-out or failed call used to parse to a final answer with no tool calls
// and end the in-process loop as `completed`. Now a timeout or a silent exit rethrows the
// spawner's TransportError (retried), and any other non-zero exit is a plain Error carrying the
// exit code and a masked stderr tail (judged, not retried).

function spawned(overrides: Partial<SpawnResult>): SpawnResult {
  return { stdout: '', stderr: '', exitCode: 0, duration: 1, ...overrides };
}

test('a clean exit hands back stdout unchanged', () => {
  assert.equal(turnStdout('claude', spawned({ stdout: 'done' })), 'done');
});

test('a timed-out turn rethrows the spawner\'s TransportError itself', () => {
  const timeout = new TransportError('"claude" did not finish within 10 ms and was killed (exit code 124).');
  assert.throws(
    () => turnStdout('claude', spawned({ exitCode: 124, transportError: timeout })),
    (err: unknown) => err === timeout,
  );
});

test('a non-zero exit without a transport error is a plain Error naming adapter, code and stderr', () => {
  assert.throws(
    () => turnStdout('codex', spawned({ stdout: 'partial', stderr: 'error: login expired', exitCode: 2 })),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof TransportError), 'a reported failure is judged, not retried');
      assert.match(err.message, /The codex adapter expected its turn to exit with code 0/);
      assert.match(err.message, /exited with code 2/);
      assert.match(err.message, /stderr tail: "error: login expired"/);
      return true;
    },
  );
});

test('failureTail keeps the last characters, marks the cut, and quotes an empty tail', () => {
  const long = `${'a'.repeat(1_000)}THE-END`;
  const tail = failureTail(long);
  assert.equal(tail, JSON.stringify(`…${long.slice(-FAILURE_TAIL_CHARS)}`));
  assert.equal(failureTail(''), '""');
});

test('failureTail masks credentials before the cut, so a key the cut splits is still masked', () => {
  // The cut at -300 falls inside the key: masking after slicing would leak its tail.
  const key = `sk-${'Z'.repeat(40)}`;
  const text = `${'a'.repeat(1_000)} ${key} ${'b'.repeat(280)}`;
  const tail = failureTail(text);
  assert.ok(!tail.includes('ZZZZ'), `the key leaked into the tail: ${tail}`);
  assert.ok(tail.includes('[REDACTED]'));

  const header = failureTail('401: invalid header Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123');
  assert.ok(!header.includes('abcdefghij'), `the bearer token leaked: ${header}`);
});
