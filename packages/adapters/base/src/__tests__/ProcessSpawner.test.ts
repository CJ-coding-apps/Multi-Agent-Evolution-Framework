import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransportError } from '@maf/types';
import { spawnAndCollect, spawnStreaming } from '../index.js';

// ORACLE (D-06): the spawner tells a transport failure from an answer. A timeout and a silent
// non-zero exit come back marked with a TransportError — still as a result, so every adapter's
// exitCode/success contract is unchanged — and a process that cannot be started rejects with
// one. A non-zero exit that wrote output is an answer and is not marked.

// The test runner's own binary: present on every machine that can run this file.
const NODE = process.execPath;
const MISSING = 'maf-no-such-binary-for-this-test';

test('a process killed on timeout resolves with exit code 124 and a TransportError', async () => {
  const result = await spawnAndCollect(NODE, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 200 });

  assert.equal(result.exitCode, 124);
  const err = result.transportError;
  assert.ok(err instanceof TransportError, 'a timeout is a transport failure');
  assert.match(err.message, /did not finish within 200 ms and was killed \(exit code 124\)/);
});

test('a non-zero exit with nothing on stdout is a transport failure', async () => {
  // exitCode rather than exit(): let the process flush stderr before it goes.
  const result = await spawnAndCollect(NODE, ['-e', 'process.stderr.write("login expired"); process.exitCode = 3']);

  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /login expired/, 'stderr still reaches the caller');
  const err = result.transportError;
  assert.ok(err instanceof TransportError);
  assert.match(err.message, /exited with code 3 without writing any output/);
});

test('a non-zero exit that wrote output is an answer, not a transport failure', async () => {
  const result = await spawnAndCollect(NODE, ['-e', 'process.stdout.write("error: bad request"); process.exitCode = 1']);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, 'error: bad request');
  assert.equal(result.transportError, undefined);
});

test('a clean exit carries no transport error', async () => {
  const result = await spawnAndCollect(NODE, ['-e', 'process.stdout.write("ok")']);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal('transportError' in result, false, 'absent, not present-and-undefined');
});

test('a binary that cannot be started rejects with a TransportError naming it', async () => {
  await assert.rejects(
    () => spawnAndCollect(MISSING, []),
    (err: unknown) =>
      err instanceof TransportError &&
      err.message.startsWith(`Could not run "${MISSING}": `) &&
      err.cause instanceof Error,
  );
});

test('spawnStreaming rejects with a TransportError for a binary that cannot be started', async () => {
  const chunks: string[] = [];
  await assert.rejects(
    async () => {
      for await (const chunk of spawnStreaming(MISSING, [])) chunks.push(chunk);
    },
    TransportError,
  );
  assert.deepEqual(chunks, []);
});
