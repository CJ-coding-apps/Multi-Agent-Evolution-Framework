import Database from 'better-sqlite3';
import type { BlackboardSnapshot, BlackboardEntry, BlackboardKey, BlackboardValue, NodeId, RunId, DagNodeStatus } from '@maf/types';
import { makeRunId } from '@maf/types';

type EntryRow = {
  key: string; value_kind: string; value_data: string;
  produced_by: string; run_id: string; created_at: string; ttl_ms: number | null;
};
type DagRow = { node_id: string; status: string };

export class BlackboardSqlitePersistence {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS bb_snapshots (
        run_id      TEXT NOT NULL,
        snapshot_at TEXT NOT NULL,
        PRIMARY KEY (run_id, snapshot_at)
      );
      CREATE TABLE IF NOT EXISTS bb_entries (
        run_id      TEXT NOT NULL,
        snapshot_at TEXT NOT NULL,
        key         TEXT NOT NULL,
        value_kind  TEXT NOT NULL,
        value_data  TEXT NOT NULL,
        produced_by TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        ttl_ms      INTEGER,
        PRIMARY KEY (run_id, snapshot_at, key)
      );
      CREATE TABLE IF NOT EXISTS bb_dag_state (
        run_id      TEXT NOT NULL,
        snapshot_at TEXT NOT NULL,
        node_id     TEXT NOT NULL,
        status      TEXT NOT NULL,
        PRIMARY KEY (run_id, snapshot_at, node_id)
      );
    `);
  }

  save(snapshot: BlackboardSnapshot): void {
    const at = snapshot.timestamp.toISOString();
    const insertSnap  = this.db.prepare(`INSERT OR REPLACE INTO bb_snapshots VALUES (?,?)`);
    const insertEntry = this.db.prepare(`INSERT OR REPLACE INTO bb_entries VALUES (?,?,?,?,?,?,?,?)`);
    const insertDag   = this.db.prepare(`INSERT OR REPLACE INTO bb_dag_state VALUES (?,?,?,?)`);

    this.db.transaction(() => {
      insertSnap.run(snapshot.runId, at);
      for (const e of snapshot.entries) {
        insertEntry.run(snapshot.runId, at, e.key, e.value.kind, JSON.stringify(e.value), e.producedBy, e.createdAt.toISOString(), e.ttlMs ?? null);
      }
      for (const [nodeId, status] of snapshot.dagState) {
        insertDag.run(snapshot.runId, at, nodeId, status);
      }
    })();
  }

  load(runId: RunId): BlackboardSnapshot | undefined {
    const snapRow = this.db.prepare(
      `SELECT snapshot_at FROM bb_snapshots WHERE run_id=? ORDER BY snapshot_at DESC LIMIT 1`
    ).get(runId) as { snapshot_at: string } | undefined;
    if (!snapRow) return undefined;

    const at = snapRow.snapshot_at;
    const entryRows = this.db.prepare(`SELECT * FROM bb_entries WHERE run_id=? AND snapshot_at=?`).all(runId, at) as EntryRow[];
    const dagRows   = this.db.prepare(`SELECT * FROM bb_dag_state WHERE run_id=? AND snapshot_at=?`).all(runId, at) as DagRow[];

    const entries: BlackboardEntry[] = entryRows.map((r) => ({
      key:        r.key as BlackboardKey,
      value:      JSON.parse(r.value_data) as BlackboardValue,
      producedBy: r.produced_by as NodeId,
      runId:      r.run_id as RunId,
      createdAt:  new Date(r.created_at),
      ...(r.ttl_ms != null ? { ttlMs: r.ttl_ms } : {}),
    }));

    const dagState = new Map<NodeId, DagNodeStatus>(
      dagRows.map((r) => [r.node_id as NodeId, r.status as DagNodeStatus])
    );

    return { runId: makeRunId(runId), timestamp: new Date(at), entries, dagState };
  }

  listSnapshots(runId: RunId): Date[] {
    const rows = this.db.prepare(`SELECT snapshot_at FROM bb_snapshots WHERE run_id=? ORDER BY snapshot_at ASC`).all(runId) as Array<{ snapshot_at: string }>;
    return rows.map((r) => new Date(r.snapshot_at));
  }

  close(): void { this.db.close(); }
}
