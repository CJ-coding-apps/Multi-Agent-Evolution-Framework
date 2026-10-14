import type { NodeId, WriterLockInterval, WriterLockLedger } from '@maf/types';

/**
 * The scheduler's writer lock as a ledger of hold intervals (WP-3.0c, the F7 window). The runner
 * enters a node when it takes the lock and exits it when it lets go; the dispatcher asks whether any
 * writer overlapped a reader's turn. `now` is injectable so a test can pin the intervals it asserts
 * on — the real clock would make every assertion time-dependent.
 *
 * An open hold — a writer that has entered and not yet exited — is treated as ending at +Infinity,
 * so a reader whose turn began after the writer took the lock sees it however late the reader's own
 * bracket closes. Writers are serialized, so the closed intervals are in acquisition order and
 * precede any open one; iterating them in order returns the earliest overlapping writer, which is
 * what makes the answer independent of Map iteration order.
 */
export function createWriterLockLedger(now: () => number = Date.now): WriterLockLedger {
  const open = new Map<NodeId, number>();
  const closed: WriterLockInterval[] = [];
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
    writerOverlapping(from, to, exclude) {
      const overlaps = (iv: WriterLockInterval): boolean =>
        iv.nodeId !== exclude && iv.from <= to && iv.to >= from;
      for (const iv of closed) if (overlaps(iv)) return iv.nodeId;
      for (const [nodeId, at] of open) {
        if (overlaps({ nodeId, from: at, to: Number.POSITIVE_INFINITY })) return nodeId;
      }
      return undefined;
    },
  };
}
