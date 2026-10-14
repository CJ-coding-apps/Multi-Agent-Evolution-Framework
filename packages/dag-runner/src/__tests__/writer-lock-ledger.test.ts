import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardStore } from '@maf/blackboard';
import type { BlackboardValue, DagNode } from '@maf/types';
import { makeRunId, makeNodeId } from '@maf/types';
import { DagRunner, DagParser, createWriterLockLedger } from '../index.js';
import { testRoleResolver } from './roleResolver.js';

// ORACLE (WP-3.0c, the F7 window). The scheduler's writer lock as a ledger of hold intervals: the
// runner stamps it where it takes and releases the lock, and the dispatcher asks it whether any
// writer held the lock across a reader's turn. Without a home for the answer, the F7 window — a
// writer running *during* a reader's turn — could only be documented; with it, the change is
// attributed to the writer instead of being charged to the reader.

const W1 = makeNodeId('w1');
const N1 = makeNodeId('n1');
const OTHER = makeNodeId('other');
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

  assert.equal(ledger.writerOverlapping(150, 250), W1, 'the window straddles the hold');
  assert.equal(ledger.writerOverlapping(199, 200), W1, 'a window wholly inside the hold');
});

test('a writer that let go before the window opened is not named', () => {
  const clock = { now: 100 };
  const ledger = ledgerAt(clock);
  ledger.enter(W1);
  clock.now = 200;
  ledger.exit(W1);

  assert.equal(ledger.writerOverlapping(201, 300), undefined, 'its hold ended before the turn began');
  assert.equal(ledger.writerOverlapping(250, 400), undefined);
});

test('a writer still holding the lock overlaps however late the window closes', () => {
  const clock = { now: 100 };
  const ledger = ledgerAt(clock);
  ledger.enter(W1);

  assert.equal(ledger.writerOverlapping(500, 900), W1, 'an open hold reads as ending at +Infinity');
});

test('the excluded node is never handed back as its own concurrent writer', () => {
  // A cli-tier reader holds the lock itself; without `exclude` it would be attributed its own turn.
  const clock = { now: 100 };
  const ledger = ledgerAt(clock);
  ledger.enter(N1);
  clock.now = 200;
  ledger.exit(N1);

  assert.equal(ledger.writerOverlapping(150, 250, N1), undefined, 'its own hold is dropped');
  assert.equal(ledger.writerOverlapping(150, 250, OTHER), N1, 'a different excluded node changes nothing');
});

test('the earliest of several overlapping writers is named, so the answer is order-independent', () => {
  const clock = { now: 10 };
  const ledger = ledgerAt(clock);
  ledger.enter(W1);
  clock.now = 20;
  ledger.exit(W1);
  const w2 = makeNodeId('w2');
  ledger.enter(w2);
  clock.now = 30;
  ledger.exit(w2);

  assert.equal(ledger.writerOverlapping(15, 40), W1, 'the first writer to hold the lock across the window');
});

test('exit for a node that never entered records nothing', () => {
  const clock = { now: 100 };
  const ledger = ledgerAt(clock);
  ledger.exit(GHOST);

  assert.equal(ledger.writerOverlapping(0, Number.MAX_SAFE_INTEGER), undefined, 'no ghost interval was created');
});

test('DagRunner stamps the ledger exactly where it takes and releases the writer lock', async () => {
  const ledger = createWriterLockLedger();
  const observed: Array<{ node: string; writer: string | undefined }> = [];
  const executor = async (node: DagNode): Promise<Record<string, BlackboardValue>> => {
    // Inside a writer's own turn, ask exactly what the dispatcher asks: who held the lock across a
    // window ending now, excluding this node. The first writer sees nobody; the second sees the
    // first — which is the stamp the F7 window reads.
    observed.push({
      node:   node.id,
      writer: ledger.writerOverlapping(Date.now() - 60_000, Date.now(), node.id),
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
    observed.map((o) => [o.node, o.writer]),
    [['w1', undefined], ['w2', 'w1']],
    'the second writer saw the first holding the lock; the first saw nobody',
  );
});
