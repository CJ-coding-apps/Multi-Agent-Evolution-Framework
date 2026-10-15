import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardStore } from '@maf/blackboard';
import type { BlackboardValue, DagNode } from '@maf/types';
import { makeRunId, makeNodeId } from '@maf/types';
import { DagRunner, DagParser, createWriterLockLedger } from '../index.js';
import { testRoleResolver } from './roleResolver.js';

// ORACLE (WP-3.0c, the F7 window; F2 of the 3.0c review). The scheduler's writer lock as a ledger
// of hold intervals: the runner stamps it where it takes and releases the lock, and the dispatcher
// asks it which writers overlapped a reader's turn and whether one is still holding. Without a home
// for the answer, the F7 window — a writer running *during* a reader's turn — could only be
// documented; with it, the change is attributed to a writer whose own gate will judge it instead of
// being charged to the reader. The dispatcher does the judging (F2); the ledger answers only the two
// questions it can answer, and answers them in order.

const W1 = makeNodeId('w1');
const GHOST = makeNodeId('ghost');

/** A mutable clock, so every interval below is exactly the one the test names. */
function ledgerAt(clock: { now: number }) {
  return createWriterLockLedger(() => clock.now);
}

test('a writer that held the lock across the window is named', () => {
  const clock = { now: 100 };
  const ledger = ledgerAt(clock);
  ledger.enter(W1);
  clock.now = 200;
  ledger.exit(W1);

  assert.deepEqual(ledger.writersOverlapping(150, 250), [W1], 'the window straddles the hold');
  assert.deepEqual(ledger.writersOverlapping(199, 200), [W1], 'a window wholly inside the hold');
});

test('a writer that let go before the window opened is not named', () => {
  const clock = { now: 100 };
  const ledger = ledgerAt(clock);
  ledger.enter(W1);
  clock.now = 200;
  ledger.exit(W1);

  assert.deepEqual(ledger.writersOverlapping(201, 300), [], 'its hold ended before the turn began');
  assert.deepEqual(ledger.writersOverlapping(250, 400), []);
});

test('a writer still holding the lock overlaps however late the window closes', () => {
  const clock = { now: 100 };
  const ledger = ledgerAt(clock);
  ledger.enter(W1);

  assert.deepEqual(ledger.writersOverlapping(500, 900), [W1], 'an open hold reads as ending at +Infinity');
  assert.equal(ledger.isHolding(W1), true, 'and it says so, which is what rule (a) turns on');
});

test('isHolding is false for a writer that has released, and for one that never entered', () => {
  const clock = { now: 100 };
  const ledger = ledgerAt(clock);
  ledger.enter(W1);
  assert.equal(ledger.isHolding(W1), true);
  clock.now = 200;
  ledger.exit(W1);
  assert.equal(ledger.isHolding(W1), false, 'a released hold is no longer open');
  assert.equal(ledger.isHolding(GHOST), false, 'a node that never entered is not holding');
});

test('every overlapping writer is listed, released ones in acquisition order, the holder last', () => {
  // Two writers in sequence, both overlapping one window, and a third still running: the answer
  // names all three, so the caller can ask which of them can answer for a change rather than taking
  // the first one the map happens to yield (F2).
  const clock = { now: 10 };
  const ledger = ledgerAt(clock);
  ledger.enter(W1);
  clock.now = 20;
  ledger.exit(W1);
  const w2 = makeNodeId('w2');
  ledger.enter(w2);
  clock.now = 30;
  ledger.exit(w2);
  const w3 = makeNodeId('w3');
  clock.now = 40;
  ledger.enter(w3);

  assert.deepEqual(ledger.writersOverlapping(15, 50), [W1, w2, w3],
    'the two released writers oldest-first, then the one still holding');
  assert.deepEqual(ledger.writersOverlapping(35, 50), [w3], 'a window after both released names only the holder');
});

test('exit for a node that never entered records nothing', () => {
  const clock = { now: 100 };
  const ledger = ledgerAt(clock);
  ledger.exit(GHOST);

  assert.deepEqual(ledger.writersOverlapping(0, Number.MAX_SAFE_INTEGER), [],
    'no ghost interval was created');
});

test('DagRunner stamps the ledger exactly where it takes and releases the writer lock', async () => {
  const ledger = createWriterLockLedger();
  const observed: Array<{ node: string; writers: string[]; holding: boolean }> = [];
  const executor = async (node: DagNode): Promise<Record<string, BlackboardValue>> => {
    // Inside a writer's own turn, ask exactly what the dispatcher asks: which writers overlapped a
    // window ending now, and whether this one is holding. The first writer sees nobody; the second
    // sees the first — which is the stamp the F7 window reads.
    observed.push({
      node:    node.id,
      writers: ledger.writersOverlapping(performance.now() - 60_000, performance.now())
        .filter((id) => id !== node.id),
      holding: ledger.isHolding(node.id),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {};
  };

  const runId = makeRunId('ledger-stamp');
  const dag = DagParser.fromSpec(
    { id: 'x', nodes: [{ id: 'w1', label: 'w1' }, { id: 'w2', label: 'w2' }] },
    runId,
    testRoleResolver(['coder'], 'coder'),
  );
  const outcome = await new DagRunner().run({
    dag, board: new BlackboardStore(), executor, writerLockLedger: ledger,
  });

  assert.equal(outcome.status, 'Succeeded');
  assert.deepEqual(
    observed.map((o) => [o.node, o.writers, o.holding]),
    [['w1', [], true], ['w2', ['w1'], true]],
    'the second writer saw the first holding the lock; the first saw nobody',
  );
  assert.equal(ledger.isHolding(makeNodeId('w2')), false, 'and the runner released it when the node ended');
});
