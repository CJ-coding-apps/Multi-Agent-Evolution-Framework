import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransportError } from '@maf/types';
import type { AdapterInvokeOptions } from '@maf/types';
import { OllamaAdapter } from '../index.js';

// ORACLE (F5; D-06).
//
// A request that got no answer — no server on the port, the deadline passed, the server failing
// with a 5xx — says nothing about the request, so it is a TransportError and the node may be
// retried. It used to surface as fetch's raw rejection (an abort was an AbortError, a dead server
// a TypeError) or, for a 5xx, as `success: false`, which the dispatcher judges and never retries.
// A 4xx is the server judging the request and stays `success: false` until D-05 classifies it.
// Global `fetch` is stubbed in every test, so no test needs an Ollama server.

const CALL: AdapterInvokeOptions = {
  prompt: 'say hi', workingDir: process.cwd(), timeoutMs: 5_000, model: 'stub-local-model:latest',
};
/** Passed explicitly so OLLAMA_BASE_URL in the caller's env cannot change the URL asserted. */
const BASE_URL = 'http://ollama.invalid:11434';
const URL_CHAT = `${BASE_URL}/api/chat`;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** Replaces global `fetch` with `reply` for the duration of `body`, and restores it. */
async function withFetch(
  reply: (init: FetchInit) => Promise<Response>,
  body: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input: FetchInput, init?: FetchInit): Promise<Response> => reply(init);
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** What undici rejects with when nothing listens on the port. */
function connectionRefused(): Error {
  return new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11434') });
}

/** What fetch rejects with when its signal is aborted: an Error named AbortError. */
function abortError(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

function adapter(): OllamaAdapter {
  return new OllamaAdapter({ baseUrl: BASE_URL });
}

test('invoke: a rejected fetch is a TransportError carrying the network reason', async () => {
  await withFetch(async () => { throw connectionRefused(); }, async () => {
    await assert.rejects(adapter().invoke(CALL), (err: unknown) => {
      assert.ok(err instanceof TransportError, `expected a TransportError, found ${String(err)}`);
      assert.match(err.message, /failed before an answer arrived/);
      assert.match(err.message, /ECONNREFUSED/);
      assert.ok(err.message.includes(URL_CHAT));
      assert.ok(err.cause instanceof TypeError, 'the original rejection is kept as the cause');
      return true;
    });
  });
});

test('invoke: a request still unanswered at its deadline is aborted and is a TransportError', async () => {
  // The stub never answers; it rejects the way fetch does once the adapter's own timer aborts it.
  const hang = (init: FetchInit): Promise<Response> => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error('expected invoke to pass an AbortSignal to fetch, found none'));
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  await withFetch(hang, async () => {
    await assert.rejects(adapter().invoke({ ...CALL, timeoutMs: 20 }), (err: unknown) => {
      assert.ok(err instanceof TransportError, `expected a TransportError, found ${String(err)}`);
      assert.match(err.message, /within 20 ms/);
      assert.match(err.message, /request was aborted/);
      return true;
    });
  });
});

test('invoke: an AbortError from fetch is a TransportError even before the deadline', async () => {
  await withFetch(async () => { throw abortError(); }, async () => {
    await assert.rejects(adapter().invoke(CALL), TransportError);
  });
});

test('invoke: HTTP 500 is a TransportError naming the status and the body tail', async () => {
  const reply = async (): Promise<Response> => new Response('upstream exploded', { status: 500 });
  await withFetch(reply, async () => {
    await assert.rejects(adapter().invoke(CALL), (err: unknown) => {
      assert.ok(err instanceof TransportError, `expected a TransportError, found ${String(err)}`);
      assert.match(err.message, /failed with HTTP 500/);
      assert.match(err.message, /upstream exploded/);
      return true;
    });
  });
});

test('invoke: HTTP 401 is a failed result, not a thrown error', async () => {
  const reply = async (): Promise<Response> => new Response('{"error":"unauthorized"}', { status: 401 });
  await withFetch(reply, async () => {
    const result = await adapter().invoke(CALL);
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 401);
    assert.equal(result.output, '{"error":"unauthorized"}');
    assert.equal('transportError' in result, false);
  });
});

test('stream: a rejected fetch is a TransportError', async () => {
  await withFetch(async () => { throw connectionRefused(); }, async () => {
    await assert.rejects(adapter().stream(CALL).next(), TransportError);
  });
});

test('stream: HTTP 503 is a TransportError, HTTP 401 a plain Error', async () => {
  await withFetch(async () => new Response('overloaded', { status: 503 }), async () => {
    await assert.rejects(adapter().stream(CALL).next(), (err: unknown) =>
      err instanceof TransportError && /HTTP 503/.test(err.message) && /overloaded/.test(err.message));
  });
  await withFetch(async () => new Response('unauthorized', { status: 401 }), async () => {
    await assert.rejects(adapter().stream(CALL).next(), (err: unknown) =>
      err instanceof Error && !(err instanceof TransportError) && /401/.test(err.message));
  });
});
