import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterInvokeOptions } from '@maf/types';
import { OpenRouterAdapter } from '../index.js';

// ORACLE (audit P0 #9; WP-1.8, D-25).
//
// The adapter used to fall back to a pinned model id when neither the options nor
// OPENROUTER_MODEL named one, so an unconfigured install billed a model nobody chose and kept
// doing so after that id went stale. It now names no model: the first call without one is
// refused before any request exists. Global `fetch` is stubbed in every test, so "nothing was
// sent" is an observation, not an inference, and no test can reach the network.

const ENV_MODEL = 'OPENROUTER_MODEL';
const REPOSITORY_URL = 'https://github.com/CJ-coding-apps/Multi-Agent-Evolution-Framework';

const CALL: AdapterInvokeOptions = { prompt: 'say hi', workingDir: process.cwd(), timeoutMs: 5_000 };

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface SentRequest { url: string; init: FetchInit }

/** A chat-completions reply in the shape `invoke` parses. */
function completion(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Replaces global `fetch` for the duration of `body`, recording every request, and restores it. */
async function withStubFetch(body: (sent: SentRequest[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const sent: SentRequest[] = [];
  globalThis.fetch = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    sent.push({ url: String(input), init });
    return completion();
  };
  try {
    await body(sent);
  } finally {
    globalThis.fetch = original;
  }
}

/** Builds the adapter with OPENROUTER_MODEL set to `value` (or absent), restoring the caller's env. */
function construct(value: string | undefined, opts: { model?: string } = {}): OpenRouterAdapter {
  const previous = process.env[ENV_MODEL];
  if (value === undefined) delete process.env[ENV_MODEL];
  else process.env[ENV_MODEL] = value;
  try {
    return new OpenRouterAdapter({ apiKey: 'test-key', ...opts });
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
  assert.match(err.message, /OPENROUTER_MODEL/);
  assert.match(err.message, /`model` in OpenRouterAdapterOptions/);
  assert.match(err.message, /No request was sent/);
  return true;
}

test('constructing with no model succeeds, so the adapter can be listed without configuration', () => {
  const adapter = construct(undefined);
  assert.equal(adapter.name, 'openrouter');
  assert.equal(adapter.capabilities().inProcessLoop, false);
});

test('invoke with no model in options or OPENROUTER_MODEL is refused, naming both, and sends nothing', async () => {
  const adapter = construct(undefined);
  await withStubFetch(async (sent) => {
    await assert.rejects(adapter.invoke(CALL), namesEnvAndOption);
    assert.equal(sent.length, 0, 'no request may leave the adapter without a model');
  });
});

test('an empty OPENROUTER_MODEL counts as unset', async () => {
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

test('OPENROUTER_MODEL alone is enough, and the request body carries it', async () => {
  const adapter = construct('stub-vendor/env-model');
  await withStubFetch(async (sent) => {
    const result = await adapter.invoke(CALL);
    assert.equal(result.success, true);
    assert.equal(result.output, 'hi');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(sentBody(sent[0]).model, 'stub-vendor/env-model');
  });
});

test('the options model beats OPENROUTER_MODEL, and a per-call model beats both', async () => {
  const adapter = construct('stub-vendor/env-model', { model: 'stub-vendor/options-model' });
  await withStubFetch(async (sent) => {
    await adapter.invoke(CALL);
    await adapter.invoke({ ...CALL, model: 'stub-vendor/call-model' });
    assert.equal(sent.length, 2);
    assert.equal(sentBody(sent[0]).model, 'stub-vendor/options-model');
    assert.equal(sentBody(sent[1]).model, 'stub-vendor/call-model');
  });
});

test('a per-call model is enough when nothing else names one', async () => {
  const adapter = construct(undefined);
  await withStubFetch(async (sent) => {
    await adapter.invoke({ ...CALL, model: 'stub-vendor/call-model' });
    assert.equal(sentBody(sent[0]).model, 'stub-vendor/call-model');
  });
});

test('HTTP-Referer is this repository and X-Title stays MAF', async () => {
  const adapter = construct(undefined, { model: 'stub-vendor/options-model' });
  await withStubFetch(async (sent) => {
    await adapter.invoke(CALL);
    const headers = new Headers(sent[0]?.init?.headers);
    assert.equal(headers.get('HTTP-Referer'), REPOSITORY_URL);
    assert.equal(headers.get('X-Title'), 'MAF');
  });
});
