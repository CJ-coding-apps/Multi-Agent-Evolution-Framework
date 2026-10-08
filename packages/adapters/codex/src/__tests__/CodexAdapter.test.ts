import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransportError } from '@maf/types';
import type { AdapterInvokeOptions, TurnMessage } from '@maf/types';
import type { SpawnResult, spawnAndCollect } from '@maf/adapter-base';
import { CodexAdapter } from '../index.js';

// ORACLE (F4, F8; D-04, D-06).
//
// invoke() forwards the spawner's transportError so the dispatcher can retry a timeout or a silent
// exit, and sendTurn() no longer parses the stdout of a turn that did not finish: a timed-out turn
// used to parse to an empty final answer and end the in-process loop as `completed`. The spawn is
// injected, so no `codex` binary runs and every failure is exactly the one the case names.

const CALL: AdapterInvokeOptions = { prompt: 'say hi', workingDir: process.cwd(), timeoutMs: 5_000 };
const HISTORY: TurnMessage[] = [{ kind: 'user', text: 'say hi' }];

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

/** What the spawner resolves with when the process is killed on its timeout. */
function timedOut(): SpawnResult {
  return {
    stdout: '', stderr: '', exitCode: 124, duration: 5_000,
    transportError: new TransportError('"codex" did not finish within 5000 ms and was killed (exit code 124).'),
  };
}

test('invoke forwards the spawner\'s transportError on a timeout', async () => {
  const result = timedOut();
  const { spawn, calls } = stubSpawn(result);
  const out = await new CodexAdapter({ spawn }).invoke(CALL);

  assert.equal(calls[0]?.cmd, 'codex');
  assert.equal(out.success, false);
  assert.equal(out.exitCode, 124);
  assert.equal(out.transportError, result.transportError, 'the same error, so its message and class survive');
});

test('invoke omits transportError when the spawner reports none', async () => {
  const { spawn } = stubSpawn({ stdout: 'hi', stderr: '', exitCode: 0, duration: 1 });
  const out = await new CodexAdapter({ spawn }).invoke(CALL);

  assert.equal(out.success, true);
  assert.equal(out.output, 'hi');
  assert.equal('transportError' in out, false, 'absent, not present-and-undefined');
});

test('invoke keeps a non-zero exit that wrote output as a judged failure without transportError', async () => {
  const { spawn } = stubSpawn({ stdout: 'error: bad request', stderr: '', exitCode: 1, duration: 1 });
  const out = await new CodexAdapter({ spawn }).invoke(CALL);

  assert.equal(out.success, false);
  assert.equal(out.exitCode, 1);
  assert.equal('transportError' in out, false);
});

test('sendTurn throws the TransportError of a timed-out turn instead of parsing it', async () => {
  const result = timedOut();
  const { spawn } = stubSpawn(result);
  await assert.rejects(
    new CodexAdapter({ spawn }).sendTurn(HISTORY, CALL),
    (err: unknown) => err === result.transportError,
  );
});

test('sendTurn throws a non-transport Error on a non-zero exit without transportError', async () => {
  const { spawn } = stubSpawn({ stdout: 'partial', stderr: 'error: session expired', exitCode: 1, duration: 1 });
  await assert.rejects(
    new CodexAdapter({ spawn }).sendTurn(HISTORY, CALL),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof TransportError), 'a reported failure is judged, not retried');
      assert.match(err.message, /The codex adapter expected its turn to exit with code 0/);
      assert.match(err.message, /exited with code 1/);
      assert.match(err.message, /session expired/);
      return true;
    },
  );
});

test('sendTurn still parses a turn that exited cleanly', async () => {
  const stdout = 'Reading it.\n```tool_call\n{"toolName":"fs.read","input":{"path":"a.ts"}}\n```';
  const { spawn, calls } = stubSpawn({ stdout, stderr: '', exitCode: 0, duration: 1 });
  const turn = await new CodexAdapter({ spawn }).sendTurn(HISTORY, CALL);

  assert.equal(calls[0]?.cmd, 'codex');
  assert.ok(!calls[0]?.args.includes('--full-auto'), 'on the turn path MAF runs the tools, not Codex');
  assert.equal(turn.text, 'Reading it.');
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0]?.toolName, 'fs.read');
  assert.deepEqual(turn.toolCalls[0]?.input, { path: 'a.ts' });
});

test('stream runs through the injected spawnStreaming', async () => {
  const seen: string[] = [];
  async function* spawnStreaming(cmd: string, args: string[]): AsyncGenerator<string> {
    seen.push(cmd, ...args.slice(-1));
    yield 'a';
    yield 'b';
  }
  const chunks: string[] = [];
  for await (const chunk of new CodexAdapter({ spawnStreaming }).stream(CALL)) chunks.push(chunk);

  assert.deepEqual(chunks, ['a', 'b']);
  assert.deepEqual(seen, ['codex', '--stream']);
});
