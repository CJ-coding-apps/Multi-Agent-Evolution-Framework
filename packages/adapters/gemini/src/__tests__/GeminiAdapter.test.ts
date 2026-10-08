import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransportError } from '@maf/types';
import type { AdapterInvokeOptions } from '@maf/types';
import type { SpawnResult, spawnAndCollect } from '@maf/adapter-base';
import { GeminiAdapter } from '../index.js';

// ORACLE (F8; D-06).
//
// invoke() forwards the spawner's transportError so the dispatcher can retry a timeout or a silent
// exit, and leaves it off an answer, which is judged and never retried. Gemini has no sendTurn, so
// invoke() and stream() are its whole surface. The spawn is injected, so no `gemini` binary runs
// and every failure is exactly the one the case names.

const CALL: AdapterInvokeOptions = { prompt: 'say hi', workingDir: process.cwd(), timeoutMs: 5_000 };

interface SpawnCall { cmd: string; args: string[] }

/** A spawn that records every call and resolves with `result`, standing in for the binary. */
function stubSpawn(result: SpawnResult): { spawn: typeof spawnAndCollect; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: typeof spawnAndCollect = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    return result;
  };
  return { spawn, calls };
}

test('invoke forwards the spawner\'s transportError on a timeout', async () => {
  const result: SpawnResult = {
    stdout: '', stderr: '', exitCode: 124, duration: 5_000,
    transportError: new TransportError('"gemini" did not finish within 5000 ms and was killed (exit code 124).'),
  };
  const { spawn, calls } = stubSpawn(result);
  const out = await new GeminiAdapter({ spawn }).invoke(CALL);

  assert.equal(calls[0]?.cmd, 'gemini');
  assert.equal(out.success, false);
  assert.equal(out.exitCode, 124);
  assert.equal(out.transportError, result.transportError, 'the same error, so its message and class survive');
});

test('invoke forwards the transportError of a silent non-zero exit', async () => {
  const result: SpawnResult = {
    stdout: '', stderr: 'auth required', exitCode: 3, duration: 1,
    transportError: new TransportError('"gemini" exited with code 3 without writing any output.'),
  };
  const { spawn } = stubSpawn(result);
  const out = await new GeminiAdapter({ spawn }).invoke(CALL);

  assert.equal(out.exitCode, 3);
  assert.equal(out.transportError, result.transportError);
});

test('invoke omits transportError when the spawner reports none', async () => {
  const { spawn } = stubSpawn({ stdout: 'hi', stderr: '', exitCode: 0, duration: 1 });
  const out = await new GeminiAdapter({ spawn }).invoke(CALL);

  assert.equal(out.success, true);
  assert.equal(out.output, 'hi');
  assert.equal('transportError' in out, false, 'absent, not present-and-undefined');
});

test('invoke keeps a non-zero exit that wrote output as a judged failure without transportError', async () => {
  const { spawn } = stubSpawn({ stdout: 'error: bad request', stderr: '', exitCode: 1, duration: 1 });
  const out = await new GeminiAdapter({ spawn }).invoke(CALL);

  assert.equal(out.success, false);
  assert.equal(out.exitCode, 1);
  assert.equal('transportError' in out, false);
});

test('stream runs through the injected spawnStreaming', async () => {
  const seen: string[] = [];
  async function* spawnStreaming(cmd: string, args: string[]): AsyncGenerator<string> {
    seen.push(cmd, ...args.slice(-2));
    yield 'a';
    yield 'b';
  }
  const chunks: string[] = [];
  for await (const chunk of new GeminiAdapter({ spawnStreaming }).stream(CALL)) chunks.push(chunk);

  assert.deepEqual(chunks, ['a', 'b']);
  assert.deepEqual(seen, ['gemini', '-p', 'say hi']);
});
