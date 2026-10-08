import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardStore } from '@maf/blackboard';
import type { BlackboardValue, DagNode, NodeId, RetryPolicy, RunOutcome } from '@maf/types';
import { TransportError, VerdictError, makeNodeId, makeRunId } from '@maf/types';
import { DagRunner, DagParser, withRetry, DEFAULT_RETRY_POLICY } from '../index.js';
import { testRoleResolver } from './roleResolver.js';

// ORACLE (D-06; audit P0 #3): retries are for transport, never for verdicts. Only a
// TransportError earns a second attempt. A gate refusal, a policy denial, or any error nobody
// classified fails the node on its first attempt — the retry wraps the whole executor, gates
// included, so retrying those used to give a refused diff a second roll.

const RUN_ID = makeRunId('retry-classification');
const ROLES = testRoleResolver(['coder'], 'coder');

/** The default policy with the waiting taken out: the attempt count is what is under test. */
const NO_WAIT: RetryPolicy = { ...DEFAULT_RETRY_POLICY, backoffMs: 0, jitterMs: 0 };

/** Stand-ins for what gates, policy and transports throw, classified and not. */
class GateRefused extends VerdictError {}
class UnclassifiedPolicyError extends Error {}
class ConnectionReset extends TransportError {}

type NodeSpec = Parameters<typeof DagParser.fromSpec>[0]['nodes'];

function dagOf(nodes: NodeSpec) {
  return DagParser.fromSpec({ id: 'x', nodes }, RUN_ID, ROLES);
}

function nodeState(outcome: RunOutcome, id: string) {
  return outcome.nodes?.find((n) => n.nodeId === makeNodeId(id));
}

// ─── withRetry ──────────────────────────────────────────────────────────────

test('the default retry policy is two attempts: one retry', () => {
  assert.equal(DEFAULT_RETRY_POLICY.maxAttempts, 2);
});

test('a TransportError is retried once, and the retry can succeed', async () => {
  const attempts: number[] = [];
  let retries = 0;
  const value = await withRetry(async (attempt) => {
    attempts.push(attempt);
    if (attempt === 1) throw new TransportError('the backend closed the connection');
    return 'answer';
  }, NO_WAIT, () => { retries++; });

  assert.equal(value, 'answer');
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(retries, 1);
});

test('a subclass of TransportError is retried like its base', async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new ConnectionReset('read ECONNRESET');
    return 'answer';
  }, NO_WAIT);

  assert.equal(value, 'answer');
  assert.equal(calls, 2);
});

test('a TransportError on every attempt gives up after the default two, with the last error', async () => {
  let calls = 0;
  const errors = [new TransportError('timed out'), new TransportError('timed out again')];
  await assert.rejects(
    () => withRetry(async () => { throw errors[calls++]; }, NO_WAIT),
    (err: unknown) => err === errors[1],
  );
  assert.equal(calls, 2);
});

test('maxAttempts 1 means no retry, even for a TransportError', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new TransportError('timed out'); }, { ...NO_WAIT, maxAttempts: 1 }),
    TransportError,
  );
  assert.equal(calls, 1);
});

test('a VerdictError is not retried', async () => {
  let calls = 0;
  let retries = 0;
  const refusal = new GateRefused('the security gate refused the diff: 1 blocking finding');
  await assert.rejects(
    () => withRetry(async () => { calls++; throw refusal; }, NO_WAIT, () => { retries++; }),
    (err: unknown) => err === refusal,
  );
  assert.equal(calls, 1, 'a refusal is terminal although the policy allows a second attempt');
  assert.equal(retries, 0);
});

test('an error nobody classified is not retried', async () => {
  // Classification is opt-in: a generic Error, an error class that predates the split, and a
  // thrown non-Error all fail on the first attempt.
  const thrown: unknown[] = [
    new Error('a bug in the executor'),
    new UnclassifiedPolicyError('Deny: fs.write .env'),
    'a bare string',
  ];
  for (const value of thrown) {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => { calls++; throw value; }, NO_WAIT),
      (err: unknown) => err === value,
    );
    assert.equal(calls, 1, `${String(value)} must fail on the first attempt`);
  }
});

// ─── through the scheduler ──────────────────────────────────────────────────

test('a node whose executor throws a gate refusal runs once and fails with the refusal', async () => {
  let calls = 0;
  const outcome = await new DagRunner().run({
    dag: dagOf([{ id: 'a', label: 'a', retry: NO_WAIT }]),
    board: new BlackboardStore(),
    executor: async () => { calls++; throw new GateRefused('the security gate refused the diff'); },
  });

  assert.equal(calls, 1);
  assert.equal(outcome.status, 'Failed');
  assert.equal(nodeState(outcome, 'a')?.error, 'the security gate refused the diff');
});

test('a node whose adapter reports a transport failure is retried once and can succeed', async () => {
  let calls = 0;
  const outcome = await new DagRunner().run({
    dag: dagOf([{ id: 'a', label: 'a', retry: NO_WAIT }]),
    board: new BlackboardStore(),
    executor: async (): Promise<Record<string, BlackboardValue>> => {
      calls++;
      if (calls === 1) throw new TransportError('"claude" did not finish within 600000 ms and was killed (exit code 124).');
      return {};
    },
  });

  assert.equal(calls, 2);
  assert.equal(outcome.status, 'Succeeded');
});

test('a node that fails while a sibling is still running: the run waits for the sibling, then ends Failed', { timeout: 10_000 }, async () => {
  // a: a transport failure (retried), then a refusal (not) — it ends while b is in flight.
  // b: held open until a has ended and let go on a later macrotask, so the scheduler must take
  //    the "nothing ready, something still running" branch and wait on b alone.
  // c: depends on a, so it can never become ready.
  const A = makeNodeId('a');
  const B = makeNodeId('b');
  const C = makeNodeId('c');
  const dag = dagOf([
    { id: 'a', label: 'a', retry: NO_WAIT },
    { id: 'b', label: 'b', retry: NO_WAIT },
    { id: 'c', label: 'c', dependencies: ['a'], retry: NO_WAIT },
  ]);

  let releaseB = (): void => {};
  const bReleased = new Promise<void>((resolve) => { releaseB = () => resolve(); });
  const calls = new Map<NodeId, number>();
  let bStarted = false;
  let bFinished = false;
  let bInFlightWhenAEnded: boolean | undefined;

  const executor = async (node: DagNode): Promise<Record<string, BlackboardValue>> => {
    const attempt = (calls.get(node.id) ?? 0) + 1;
    calls.set(node.id, attempt);
    if (node.id === A) {
      if (attempt === 1) throw new TransportError('the backend closed the connection');
      throw new GateRefused('the security gate refused the diff');
    }
    if (node.id === B) {
      bStarted = true;
      await bReleased;
      bFinished = true;
    }
    return {};
  };

  const outcome = await new DagRunner().run({
    dag,
    board: new BlackboardStore(),
    executor,
    isWriter: () => false,
    onNodeEnd: (id) => {
      if (id !== A) return;
      bInFlightWhenAEnded = bStarted && !bFinished;
      setTimeout(releaseB, 5);
    },
  });

  assert.equal(bInFlightWhenAEnded, true, 'b must still be running when a fails, or the race path is not exercised');
  assert.equal(bFinished, true, 'the run must not return before its running sibling settles');
  assert.equal(calls.get(A), 2, 'one retry for the transport failure, none for the refusal');
  assert.equal(calls.get(B), 1);
  assert.equal(calls.get(C), undefined, 'c depends on a failed node and never runs');
  assert.equal(outcome.status, 'Failed');
  assert.deepEqual(outcome.unscheduled, ['c']);
  assert.equal(nodeState(outcome, 'a')?.status, 'Failed');
  assert.equal(nodeState(outcome, 'a')?.error, 'the security gate refused the diff');
  assert.equal(nodeState(outcome, 'b')?.status, 'Succeeded');
});
