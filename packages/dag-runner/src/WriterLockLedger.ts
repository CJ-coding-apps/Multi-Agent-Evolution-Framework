import type { NodeId, WriterLockInterval, WriterLockLedger } from '@maf/types';

/**
 * The scheduler's writer lock as a ledger of hold intervals (WP-3.0c, the F7 window). The runner
 * enters a node when it takes the lock and exits it when it lets go; the dispatcher asks which
 * writers overlapped a reader's turn, and whether one is still holding. `now` is injectable so a
 * test can pin the intervals it asserts on — the real clock would make every assertion
 * time-dependent. It defaults to the monotonic clock, never `Date.now()`: the ledger is asked about
 * the *order* and *overlap* of holds, and a wall clock steps backwards on an NTP correction and
 * returns the same millisecond for a release and the very next reader's start.
 *
 * An open hold — a writer that has entered and not yet exited — is treated as ending at +Infinity,
 * so a reader whose turn began after the writer took the lock sees it however late the reader's own
 * bracket closes. Writers are serialized, so the closed intervals are in acquisition order and
 * precede any open one; iterating them in order gives the released writers oldest-first, then the
 * one still holding, which is what makes the answer independent of Map iteration order.
 */
export function createWriterLockLedger(now: () => number = () => performance.now()): WriterLockLedger {
  const open = new Map<NodeId, number>();
  const closed: WriterLockInterval[] = [];
  const overlaps = (iv: WriterLockInterval, from: number, to: number): boolean =>
    iv.from <= to && iv.to >= from;
  return {
    enter(nodeId) {
      open.set(nodeId, now());
    },
    exit(nodeId) {
      const from = open.get(nodeId);
      if (from === undefined) return;
      open.delete(nodeId);
      closed.push({ nodeId, from, to: now() });
    },
    writersOverlapping(from, to) {
      const found: NodeId[] = [];
      for (const iv of closed) if (overlaps(iv, from, to)) found.push(iv.nodeId);
      for (const [nodeId, at] of open) {
        if (overlaps({ nodeId, from: at, to: Number.POSITIVE_INFINITY }, from, to)) found.push(nodeId);
      }
      return found;
    },
    isHolding(nodeId) {
      return open.has(nodeId);
    },
  };
}
