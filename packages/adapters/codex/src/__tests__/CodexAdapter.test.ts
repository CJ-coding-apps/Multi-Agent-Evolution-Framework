import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TransportError, attachedModelSurface, modelSurfaceWasSent } from '@maf/types';
import { serializeHistory } from '@maf/adapter-base';
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

/** The digest the surface records, computed here rather than through the code under test (WP-3.0c). */
const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

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

// ORACLE (WP-2.1; cli-tier hardening). Codex's CLI has no verified way to ignore the MCP servers
// in ~/.codex/config.toml (see the comment at the top of CodexAdapter.ts), so no isolation flag is
// passed. Pinned so that adding one is a deliberate change, verified against a live binary first.

test('invoke and sendTurn pass codex no MCP flag: there is no verified one to pass', async () => {
  const { spawn, calls } = stubSpawn({ stdout: 'done', stderr: '', exitCode: 0, duration: 1 });
  const adapter = new CodexAdapter({ spawn });
  await adapter.invoke({ ...CALL, model: 'o4' });
  await adapter.sendTurn(HISTORY, { ...CALL, model: 'o4' });

  assert.deepEqual(calls[0]?.args, ['--full-auto', '--model', 'o4']);
  assert.deepEqual(calls[1]?.args, ['--model', 'o4']);
});

// ORACLE (WP-3.0c, D-45). invoke on the cli tier is a model call MAF made, so it belongs in the
// record. Codex takes the prompt on stdin, so its argv carries no payload to elide — the digest of
// the composed prompt is what records the text, and the argv is kept verbatim.

test('invoke records the cli-tier model surface; codex\'s prompt is on stdin, not in argv (WP-3.0c)', async () => {
  const { spawn } = stubSpawn({ stdout: 'hi', stderr: '', exitCode: 0, duration: 1 });
  const out = await new CodexAdapter({ spawn }).invoke({ ...CALL, systemPrompt: 'be brief', model: 'o4' });

  const surface = out.modelSurface;
  assert.ok(surface, 'a cli-tier call carries a surface');
  assert.equal(surface.systemPromptSha256, sha256Hex('be brief'));
  assert.equal(surface.promptSha256, sha256Hex('say hi'));
  assert.equal(surface.outputSha256, sha256Hex('hi'));
  assert.equal(surface.toolCatalog, '');
  assert.deepEqual(
    surface.argv, ['--full-auto', '--model', 'o4'],
    'no payload positional: the prompt travels on stdin, so the argv is verbatim',
  );
  // F7: codex writes one blob to stdin joining the system block and the prompt, and digests the two
  // parts separately — so neither part digest alone says what codex was actually written. This is
  // that blob's digest, and it is the only field that ties `argv` (which carries no prompt at all)
  // to the text that reached the child.
  assert.equal(surface.stdinSha256, sha256Hex('be brief\n\nsay hi'),
    'the stdin digest is of the joined blob, not of either part');
  assert.notEqual(surface.stdinSha256, surface.promptSha256,
    'and it is distinct from the prompt digest, so it is not a second copy of it');
});

// R4-M1/R4-L2: the attach path on this adapter's two call shapes. The surface must equal what the
// child was actually given — argv and the blob written to stdin — and the record must distinguish a
// turn that ran and failed (sent) from a binary that never started (not sent).

interface RecordedSpawn { cmd: string; args: string[]; input: string | undefined }

/** A spawn that records argv and stdin and resolves with `result`. */
function recordingSpawn(result: SpawnResult): { spawn: typeof spawnAndCollect; calls: RecordedSpawn[] } {
  const calls: RecordedSpawn[] = [];
  const spawn: typeof spawnAndCollect = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], input: opts?.input });
    return result;
  };
  return { spawn, calls };
}

test('R4-M1: a sendTurn that ran and failed attaches the argv and stdin it was given, and is sent', async () => {
  const { spawn, calls } = recordingSpawn(timedOut());
  let err: unknown;
  try {
    await new CodexAdapter({ spawn }).sendTurn(HISTORY, { ...CALL, systemPrompt: 'be brief', model: 'o4' });
    assert.fail('the turn was expected to throw');
  } catch (thrown: unknown) {
    err = thrown;
  }

  const surface = attachedModelSurface(err);
  assert.ok(surface, 'the failed turn says what it was written');
  const call = calls[0];
  assert.ok(call?.input, 'the child was given a stdin blob');
  assert.equal(surface.stdinSha256, sha256Hex(call.input), 'the digest is of the blob the child received');
  assert.equal(surface.promptSha256, sha256Hex(serializeHistory(HISTORY)), 'the digest is of the history text written to stdin');
  assert.deepEqual(surface.argv, call.args, 'the argv the child received');
  assert.equal('outputSha256' in surface, false, 'nothing came back, so there is no output digest');
  assert.equal(modelSurfaceWasSent(err), true, 'the binary ran, so the attempt was sent');
});

test('R4-L2: a sendTurn whose binary cannot start attaches its surface and is marked not-sent', async () => {
  const failure = new TransportError('Could not run "codex": spawn codex ENOENT');
  const spawn: typeof spawnAndCollect = async () => { throw failure; };
  let err: unknown;
  try {
    await new CodexAdapter({ spawn }).sendTurn(HISTORY, { ...CALL, systemPrompt: 'be brief' });
    assert.fail('the turn was expected to throw');
  } catch (thrown: unknown) {
    err = thrown;
  }

  assert.equal(err, failure, 'the same error object, so its class and message survive');
  const surface = attachedModelSurface(err);
  assert.ok(surface, 'the failed turn says what it was asked to send');
  assert.equal(modelSurfaceWasSent(err), false, 'the binary never ran');
});

test('R4-M1: an invoke whose binary cannot start attaches its argv and is not-sent', async () => {
  const failure = new TransportError('Could not run "codex": spawn codex ENOENT');
  const spawn: typeof spawnAndCollect = async () => { throw failure; };
  let err: unknown;
  try {
    await new CodexAdapter({ spawn }).invoke({ ...CALL, systemPrompt: 'be brief', model: 'o4' });
    assert.fail('the call was expected to throw');
  } catch (thrown: unknown) {
    err = thrown;
  }

  assert.equal(err, failure);
  const surface = attachedModelSurface(err);
  assert.ok(surface);
  assert.equal(surface.systemPromptSha256, sha256Hex('be brief'));
  assert.equal(surface.promptSha256, sha256Hex('say hi'));
  assert.equal(surface.stdinSha256, sha256Hex('be brief\n\nsay hi'));
  assert.deepEqual(surface.argv, ['--full-auto', '--model', 'o4']);
  assert.equal('outputSha256' in surface, false);
  assert.equal(modelSurfaceWasSent(err), false);
});
