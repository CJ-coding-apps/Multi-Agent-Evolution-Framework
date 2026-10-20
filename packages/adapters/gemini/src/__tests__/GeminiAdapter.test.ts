import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

/** The digest and the elision marker the surface uses, recomputed here (WP-3.0c). */
const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const elided = (name: string, value: string): string =>
  `<${name}: ${Buffer.byteLength(value, 'utf8')} bytes, sha256 ${sha256Hex(value)}>`;

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
    seen.push(cmd, ...args.slice(-1));
    yield 'a';
    yield 'b';
  }
  const chunks: string[] = [];
  for await (const chunk of new GeminiAdapter({ spawnStreaming }).stream(CALL)) chunks.push(chunk);

  assert.deepEqual(chunks, ['a', 'b']);
  assert.deepEqual(seen, ['gemini', '--prompt=say hi']);
});

// ORACLE (WP-2.1; cli-tier hardening). A spawned `gemini` connected to every MCP server in the
// user's configuration. Its CLI has no strict switch, only an allowlist, so every spawn passes an
// allowlist naming a server no configuration defines.

test('invoke spawns gemini with an MCP allowlist that admits no configured server', async () => {
  const { spawn, calls } = stubSpawn({ stdout: 'hi', stderr: '', exitCode: 0, duration: 1 });
  await new GeminiAdapter({ spawn }).invoke({ ...CALL, model: 'gemini-2.5-pro' });

  const args = calls[0]?.args ?? [];
  const at = args.indexOf('--allowed-mcp-server-names');
  assert.ok(at >= 0, `the allowlist flag is passed: ${JSON.stringify(args)}`);
  assert.equal(args[at + 1], 'maf-allows-no-mcp-server', 'one name, which no configuration defines; an empty list is not a documented refusal');
  assert.deepEqual(args, ['--model', 'gemini-2.5-pro', '--allowed-mcp-server-names', 'maf-allows-no-mcp-server', '--prompt=say hi']);
});

test('stream spawns gemini with the same MCP allowlist', async () => {
  const seen: string[][] = [];
  async function* spawnStreaming(_cmd: string, args: string[]): AsyncGenerator<string> {
    seen.push([...args]);
    yield 'a';
  }
  for await (const _chunk of new GeminiAdapter({ spawnStreaming }).stream(CALL)) { /* drain */ }
  assert.deepEqual(seen[0], ['--allowed-mcp-server-names', 'maf-allows-no-mcp-server', '--prompt=say hi']);
});

// ORACLE (F5 of the 0.3.0 release audit). The prompt was the argument after `-p`. Gemini's yargs gives
// `-p` `nargs: 1`, which does not take an argument starting with a dash, so a prompt beginning with `-`
// was parsed as options. Joined as `--prompt=<text>` it is the value whatever it holds: yargs splits
// `--key=value` at the first `=` and never parses the value. (`-p -- <text>` would leave `-p` empty,
// and a positional prompt runs interactively in a terminal.) The maintainer checks it on a live `gemini`.

test('a prompt that starts with a dash, or holds = and newlines, is one --prompt= argument', async () => {
  const hostile = '--yolo -s false\nthen a=b';
  const { spawn, calls } = stubSpawn({ stdout: 'hi', stderr: '', exitCode: 0, duration: 1 });
  await new GeminiAdapter({ spawn }).invoke({ ...CALL, prompt: hostile });

  const args = calls[0]?.args ?? [];
  assert.equal(args.at(-1), `--prompt=${hostile}`);
  assert.equal(args.includes('-p'), false);
  assert.equal(args.includes('--yolo'), false, 'no part of the prompt is an argument of its own');
});

// ORACLE (WP-3.0c, D-45). invoke on the cli tier is a model call MAF made, so it belongs in the
// record. Gemini carries its two payloads inside argv — the `--system-instruction` value and the
// value half of the joined `--prompt=` token — so each is elided where the flag stays readable.

test('invoke records the cli-tier model surface, its own argv elided (WP-3.0c)', async () => {
  const { spawn, calls } = stubSpawn({ stdout: 'hi', stderr: '', exitCode: 0, duration: 1 });
  const out = await new GeminiAdapter({ spawn }).invoke({ ...CALL, systemPrompt: 'be brief' });

  const surface = out.modelSurface;
  assert.ok(surface, 'a cli-tier call carries a surface');
  assert.equal(surface.systemPromptSha256, sha256Hex('be brief'));
  assert.equal(surface.promptSha256, sha256Hex('say hi'));
  assert.equal(surface.outputSha256, sha256Hex('hi'));
  assert.equal(surface.toolCatalog, '');
  assert.deepEqual(surface.argv, [
    '--system-instruction', elided('--system-instruction', 'be brief'),
    '--allowed-mcp-server-names', 'maf-allows-no-mcp-server',
    `--prompt=${elided('prompt', 'say hi')}`,
  ], 'the flag stays readable inside the joined token, its value elided');
  assert.equal(
    surface.argv.some((a) => a.includes('be brief') || a.includes('say hi')), false,
    'no payload text in the record',
  );
  assert.equal(calls[0]?.args.at(-1), '--prompt=say hi', 'the binary itself still got the prompt');
});
