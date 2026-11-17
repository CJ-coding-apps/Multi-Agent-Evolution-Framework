import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckerBridge } from '../index.js';

// R9-L3: two protocol fixes had no test of their own. (1) A settlement the driver wrote in the
// same read as the "pending" reply that named it can be read before the checker has a promise to
// settle; it must be held, or the call never settles. (2) The driver sends an error across as
// `{t:'E', n, m}`, not `{name, message}`; the checker must decode the tag, or every error loses
// its name and message. Both are exercised on the bridge itself, so removing either fix reddens
// its test here rather than only the baseline.

interface BridgeInternals {
  receive(line: string): void;
  promiseFor(pid: string): Promise<unknown>;
  fromWire(wire: unknown): unknown;
}

const KEY = 'protocol-test-key';

async function openBridge(): Promise<{ internals: BridgeInternals; close: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maf-protocol-'));
  await writeFile(path.join(dir, 'to-checker.log'), '', 'utf8');
  // The constructor only reads the child's pid, listens for a spawn error, and kills it on close.
  const child = { pid: 4242, on() {}, kill() {} } as unknown as ChildProcess;
  const bridge = new CheckerBridge({ child, dir, key: KEY, timeoutMs: 5_000 });
  return {
    internals: bridge as unknown as BridgeInternals,
    close: async () => {
      bridge.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A signed line as the driver writes it: `sign(text) text`. */
function signed(message: Record<string, unknown>): string {
  const text = JSON.stringify(message);
  const signature = createHmac('sha256', KEY).update(text).digest('hex');
  return `${signature} ${text}`;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('the settlement was dropped: no waiter ever received it')), ms);
      timer.unref?.();
    }),
  ]);
}

test('a settlement read before its waiter exists is held, not dropped', async () => {
  const { internals, close } = await openBridge();
  try {
    // The driver's reply and the settlement land in one read; the bridge sees the settlement
    // first, with no promise waiting for it yet.
    internals.receive(signed({ k: 'settled', pid: 'q1', ok: true, value: 42 }));
    assert.equal(await withDeadline(internals.promiseFor('q1'), 250), 42);
  } finally {
    await close();
  }
});

test('a settlement read after its waiter exists settles that promise', async () => {
  const { internals, close } = await openBridge();
  try {
    const pending = internals.promiseFor('q2');
    internals.receive(signed({ k: 'settled', pid: 'q2', ok: true, value: 'later' }));
    assert.equal(await withDeadline(pending, 250), 'later');
    // The waiter is consumed: the same pid is not settled twice.
    internals.receive(signed({ k: 'settled', pid: 'q2', ok: true, value: 'again' }));
    assert.equal(await withDeadline(internals.promiseFor('q2'), 250), 'again');
  } finally {
    await close();
  }
});

test("the driver's {t:'E',n,m} error record keeps its name and message", async () => {
  const { internals, close } = await openBridge();
  try {
    const decoded = internals.fromWire({ t: 'E', n: 'RangeError', m: 'bad3' });
    assert.ok(decoded instanceof Error);
    assert.equal(decoded.name, 'RangeError');
    assert.equal(decoded.message, 'bad3');
    // An unnamed error still crosses with its message rather than a generic one.
    const unnamed = internals.fromWire({ t: 'E', m: 'plain' });
    assert.ok(unnamed instanceof Error);
    assert.equal(unnamed.message, 'plain');
  } finally {
    await close();
  }
});
