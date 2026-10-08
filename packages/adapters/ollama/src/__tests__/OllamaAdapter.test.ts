import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterInvokeOptions } from '@maf/types';
import { OllamaAdapter } from '../index.js';

// ORACLE (audit P0 #9; WP-1.8, D-25).
//
// The adapter used to fall back to a pinned model id when neither the options nor OLLAMA_MODEL
// named one, so it asked the user's local server for a model they may never have pulled. It now
// names no model: the first call without one is refused before any request exists. Global
// `fetch` is stubbed in every test, so "nothing was sent" is an observation, not an inference,
// and no test needs an Ollama server.

const ENV_MODEL = 'OLLAMA_MODEL';
/** Passed explicitly so OLLAMA_BASE_URL in the caller's env cannot change the URL asserted. */
const BASE_URL = 'http://ollama.invalid:11434';

const CALL: AdapterInvokeOptions = { prompt: 'say hi', workingDir: process.cwd(), timeoutMs: 5_000 };

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface SentRequest { url: string; init: FetchInit }

/** An /api/chat reply in the shape `invoke` parses. */
function chatReply(): Response {
  return new Response(
    JSON.stringify({ message: { role: 'assistant', content: 'hi' }, done: true, eval_count: 2 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Replaces global `fetch` for the duration of `body`, recording every request, and restores it. */
async function withStubFetch(body: (sent: SentRequest[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const sent: SentRequest[] = [];
  globalThis.fetch = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    sent.push({ url: String(input), init });
    return chatReply();
  };
  try {
    await body(sent);
  } finally {
    globalThis.fetch = original;
  }
}

/** Builds the adapter with OLLAMA_MODEL set to `value` (or absent), restoring the caller's env. */
function construct(value: string | undefined, opts: { model?: string } = {}): OllamaAdapter {
  const previous = process.env[ENV_MODEL];
  if (value === undefined) delete process.env[ENV_MODEL];
  else process.env[ENV_MODEL] = value;
  try {
    return new OllamaAdapter({ baseUrl: BASE_URL, ...opts });
  } finally {
    if (previous === undefined) delete process.env[ENV_MODEL];
    else process.env[ENV_MODEL] = previous;
  }
}

/** The JSON body of a recorded request. */
function sentBody(req: SentRequest | undefined): { model?: unknown } {
  const body = req?.init?.body;
  if (typeof body !== 'string') throw new Error(`expected the request body to be a JSON string, found ${typeof body}`);
  return JSON.parse(body) as { model?: unknown };
}

/** The refusal must tell the user both ways to fix it. */
function namesEnvAndOption(err: unknown): boolean {
  assert.ok(err instanceof Error, 'the refusal is an Error');
  assert.match(err.message, /OLLAMA_MODEL/);
  assert.match(err.message, /`model` in OllamaAdapterOptions/);
  assert.match(err.message, /No request was sent/);
  return true;
}

test('constructing with no model succeeds, so the adapter can be listed without configuration', () => {
  const adapter = construct(undefined);
  assert.equal(adapter.name, 'ollama');
  assert.equal(adapter.capabilities().inProcessLoop, false);
});

test('invoke with no model in options or OLLAMA_MODEL is refused, naming both, and sends nothing', async () => {
  const adapter = construct(undefined);
  await withStubFetch(async (sent) => {
    await assert.rejects(adapter.invoke(CALL), namesEnvAndOption);
    assert.equal(sent.length, 0, 'no request may leave the adapter without a model');
  });
});

test('an empty OLLAMA_MODEL counts as unset', async () => {
  const adapter = construct('');
  await withStubFetch(async (sent) => {
    await assert.rejects(adapter.invoke(CALL), namesEnvAndOption);
    assert.equal(sent.length, 0);
  });
});

test('stream with no model is refused the same way and sends nothing', async () => {
  const adapter = construct(undefined);
  await withStubFetch(async (sent) => {
    await assert.rejects(adapter.stream(CALL).next(), namesEnvAndOption);
    assert.equal(sent.length, 0);
  });
});

test('OLLAMA_MODEL alone is enough, and the request body carries it', async () => {
  const adapter = construct('stub-local-model:latest');
  await withStubFetch(async (sent) => {
    const result = await adapter.invoke(CALL);
    assert.equal(result.success, true);
    assert.equal(result.output, 'hi');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.url, `${BASE_URL}/api/chat`);
    assert.equal(sentBody(sent[0]).model, 'stub-local-model:latest');
  });
});

test('the options model beats OLLAMA_MODEL, and a per-call model beats both', async () => {
  const adapter = construct('stub-local-model:env', { model: 'stub-local-model:options' });
  await withStubFetch(async (sent) => {
    await adapter.invoke(CALL);
    await adapter.invoke({ ...CALL, model: 'stub-local-model:call' });
    assert.equal(sent.length, 2);
    assert.equal(sentBody(sent[0]).model, 'stub-local-model:options');
    assert.equal(sentBody(sent[1]).model, 'stub-local-model:call');
  });
});

test('a per-call model is enough when nothing else names one', async () => {
  const adapter = construct(undefined);
  await withStubFetch(async (sent) => {
    await adapter.invoke({ ...CALL, model: 'stub-local-model:call' });
    assert.equal(sentBody(sent[0]).model, 'stub-local-model:call');
  });
});
