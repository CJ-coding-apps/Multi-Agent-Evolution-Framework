import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type {
  LcmMessage, LcmSummary, LcmMessageId, LcmSummaryId, RunId,
} from '@maf/types';
import { makeLcmMessageId, makeLcmSummaryId } from '@maf/types';

/**
 * The archive's schema version, stamped in SQLite's own `user_version` (L2). Version 1 is the
 * unversioned layout every earlier build wrote: `lcm_summary_parents` stored the **parent** in
 * `summary_id` and the **child** in `parent_id`, the reverse of the column names. Version 2 stores
 * the relation the names describe — `summary_id` is the child, `parent_id` is the parent — so a
 * reader that trusts the columns gets the tree the engine has.
 */
const LCM_SCHEMA_VERSION = 2;

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS lcm_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  parent_id   TEXT,
  summary_id  TEXT,
  FOREIGN KEY(summary_id) REFERENCES lcm_summaries(id)
);
CREATE INDEX IF NOT EXISTS idx_msg_session ON lcm_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS lcm_summaries (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  level       INTEGER NOT NULL,
  operator    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lcm_summary_parents (
  summary_id  TEXT NOT NULL,
  parent_id   TEXT NOT NULL,
  PRIMARY KEY(summary_id, parent_id),
  FOREIGN KEY(summary_id) REFERENCES lcm_summaries(id),
  FOREIGN KEY(parent_id)  REFERENCES lcm_summaries(id)
);

CREATE TABLE IF NOT EXISTS lcm_summary_messages (
  summary_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  PRIMARY KEY(summary_id, message_id),
  FOREIGN KEY(summary_id) REFERENCES lcm_summaries(id),
  FOREIGN KEY(message_id) REFERENCES lcm_messages(id)
);

CREATE TABLE IF NOT EXISTS lcm_migrations (
  from_version INTEGER NOT NULL,
  to_version   INTEGER NOT NULL,
  applied_at   TEXT NOT NULL,
  PRIMARY KEY(from_version, to_version)
);

-- L3/V1: the one retry a root is allowed, for the whole run. A row is written when an assembly
-- claims the retry, before the call, so a failed or crashed retry is not attempted again either;
-- retry_id is the summary it produced and outcome says whether it did.
CREATE TABLE IF NOT EXISTS lcm_root_retries (
  root_id     TEXT PRIMARY KEY,
  retry_id    TEXT NOT NULL DEFAULT '',
  outcome     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_root_retry_output ON lcm_root_retries(retry_id);

-- L3/V1: each degradation is recorded once per root and reason, however many assemblies later
-- find the same root. A transcript line per assembly would report one fact as many.
CREATE TABLE IF NOT EXISTS lcm_root_degradations (
  summary_id  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY(summary_id, reason)
);
`;

type MsgRow = {
  id: string; session_id: string; run_id: string; role: string;
  content: string; tokens: number; created_at: string;
  parent_id: string | null; summary_id: string | null;
};

type SumRow = {
  id: string; content: string; tokens: number;
  level: number; operator: string; created_at: string;
};

export class LcmStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // V7: read the version before writing anything. `exec(SCHEMA)` used to run first, so refusing
    // a newer archive still created this build's five tables in it and switched its journal to
    // WAL — a refusal that modified the file it refused. A file this build cannot read is left
    // exactly as its writer left it.
    const from = this.db.pragma('user_version', { simple: true }) as number;
    if (from > LCM_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `The LCM database at ${dbPath} has schema version ${from}, newer than this build understands ` +
        `(${LCM_SCHEMA_VERSION}). Refusing to open it: an older engine would read the parent relation ` +
        `upside down rather than fail.`,
      );
    }
    this.db.exec(SCHEMA);
    if (from < LCM_SCHEMA_VERSION) this.migrate();
  }

  /**
   * L2: bring an older archive to the current relation in one transaction. An unversioned database
   * with parent rows stores `(parent, child)` under the column names `(summary_id, parent_id)`;
   * the swap rewrites each row as `(child, parent)`. The migration is recorded in
   * `lcm_migrations`, so a reader can tell an archive that was rewritten from one written new.
   *
   * A fresh database has no rows to swap and is simply stamped: there is no migration to record.
   *
   * V6: the transaction is `BEGIN IMMEDIATE`, and the version is re-read inside it. Two processes
   * opening the same old archive both used to read 0 and both swap — the second swap restores the
   * inversion the first removed. Under the write lock the second opener waits, re-reads the stamp
   * the first wrote, and does nothing.
   */
  private migrate(): void {
    const txn = this.db.transaction(() => {
      const from = this.db.pragma('user_version', { simple: true }) as number;
      if (from >= LCM_SCHEMA_VERSION) return;
      const hadRows = (this.db.prepare(`SELECT COUNT(*) AS n FROM lcm_summary_parents`).get() as { n: number }).n > 0;
      if (hadRows) {
        this.db.exec(`
          ALTER TABLE lcm_summary_parents RENAME TO lcm_summary_parents_v1;
          CREATE TABLE lcm_summary_parents (
            summary_id  TEXT NOT NULL,
            parent_id   TEXT NOT NULL,
            PRIMARY KEY(summary_id, parent_id),
            FOREIGN KEY(summary_id) REFERENCES lcm_summaries(id),
            FOREIGN KEY(parent_id)  REFERENCES lcm_summaries(id)
          );
          INSERT INTO lcm_summary_parents (summary_id, parent_id)
            SELECT parent_id, summary_id FROM lcm_summary_parents_v1;
          DROP TABLE lcm_summary_parents_v1;
        `);
        this.db.prepare(
          `INSERT OR IGNORE INTO lcm_migrations (from_version, to_version, applied_at) VALUES (?,?,?)`,
        ).run(from, LCM_SCHEMA_VERSION, new Date().toISOString());
      }
      this.db.pragma(`user_version = ${LCM_SCHEMA_VERSION}`);
    });
    txn.immediate();
  }

  insertMessage(msg: Omit<LcmMessage, 'id' | 'createdAt'>): LcmMessageId {
    const id = makeLcmMessageId(crypto.randomUUID());
    this.db.prepare(`
      INSERT INTO lcm_messages (id,session_id,run_id,role,content,tokens,created_at,parent_id,summary_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, msg.sessionId, msg.runId, msg.role, msg.content, msg.tokens,
           new Date().toISOString(), msg.parentId ?? null, msg.summaryId ?? null);
    return id;
  }

  insertSummary(
    content: string,
    tokens: number,
    level: number,
    operator: 'LLM-Map' | 'Agentic-Map',
    childIds: LcmSummaryId[],
    messageIds: LcmMessageId[],
  ): LcmSummaryId {
    const id = makeLcmSummaryId(crypto.randomUUID());
    const now = new Date().toISOString();

    const insertSummary = this.db.prepare(
      `INSERT INTO lcm_summaries (id,content,tokens,level,operator,created_at) VALUES (?,?,?,?,?,?)`
    );
    const insertParent  = this.db.prepare(`INSERT OR IGNORE INTO lcm_summary_parents VALUES (?,?)`);
    const insertMsgLink = this.db.prepare(`INSERT OR IGNORE INTO lcm_summary_messages VALUES (?,?)`);

    const txn = this.db.transaction(() => {
      insertSummary.run(id, content, tokens, level, operator, now);
      // L2: the relation is (child, parent) under the column names. `id` is the parent this call
      // created; each child is one of the summaries it was built from.
      for (const child of childIds) insertParent.run(child, id);
      for (const m of messageIds) insertMsgLink.run(id, m);
    });
    txn();
    return id;
  }

  /**
   * Every message of a session, oldest first. There is deliberately no `limit` parameter: the
   * version that had one answered `ORDER BY created_at ASC LIMIT ?`, so a caller asking for the
   * "fresh tail" was handed the OLDEST messages and the tail was destroyed on the second
   * compaction pass (D-17). The newest N has its own method, {@link getFreshTail}.
   */
  getMessagesBySession(sessionId: string): LcmMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM lcm_messages WHERE session_id=? ORDER BY created_at ASC, rowid ASC`,
    ).all(sessionId) as MsgRow[];
    return rows.map(rowToMessage);
  }

  /**
   * The newest `count` messages of a session, returned in chronological order so a prompt reads
   * forward. `rowid` breaks a tie between messages written in the same millisecond — the normal
   * case for a transcript and a run's tool output.
   */
  getFreshTail(sessionId: string, count: number): LcmMessage[] {
    if (count <= 0) return [];
    const rows = this.db.prepare(
      `SELECT * FROM lcm_messages WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(sessionId, count) as MsgRow[];
    return rows.reverse().map(rowToMessage);
  }

  /**
   * The messages behind `ids`, in reading order — the order the ids arrive in is not a chronology
   * and an `IN (...)` scan is free to return them in any order. A summarizer handed `m3, m1, m2`
   * writes a summary that misstates what happened, and `lcm_expand` should replay the segment
   * forward, so both read this.
   */
  getMessagesByIds(ids: LcmMessageId[]): LcmMessage[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM lcm_messages WHERE id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`,
    ).all(...ids) as MsgRow[];
    return rows.map(rowToMessage);
  }

  getSummary(id: LcmSummaryId): LcmSummary | undefined {
    const row = this.db.prepare(`SELECT * FROM lcm_summaries WHERE id=?`).get(id) as SumRow | undefined;
    if (!row) return undefined;
    // L2: `summary_id` names the child, so this row's parents are the summaries that name it as a
    // child. The column reads as it is named, and `parentIds` is what the field says it is.
    const parentIds = (this.db.prepare(`SELECT parent_id FROM lcm_summary_parents WHERE summary_id=?`).all(id) as Array<{parent_id:string}>).map(r => makeLcmSummaryId(r.parent_id));
    const messageIds = (this.db.prepare(`SELECT message_id FROM lcm_summary_messages WHERE summary_id=?`).all(id) as Array<{message_id:string}>).map(r => makeLcmMessageId(r.message_id));
    return rowToSummary(row, parentIds, messageIds);
  }

  /**
   * A summary only when it covers at least one message of `sessionId` (WP-3.2 R9). `lcm_summaries`
   * has no session column — ownership is the messages a summary covers — so the check joins through
   * the link table. `.maf/lcm.db` persists across runs, and without this `lcm.expand` could read an
   * earlier run's archive from a run that never saw it.
   */
  getSummaryInSession(id: LcmSummaryId, sessionId: string): LcmSummary | undefined {
    const owned = this.db.prepare(
      `SELECT 1 AS owned FROM lcm_summary_messages sm
       JOIN lcm_messages m ON m.id = sm.message_id
       WHERE sm.summary_id = ? AND m.session_id = ? LIMIT 1`,
    ).get(id, sessionId) as { owned: number } | undefined;
    return owned ? this.getSummary(id) : undefined;
  }

  searchMessages(query: string, sessionId: string): LcmMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM lcm_messages WHERE session_id=? AND content LIKE ? ORDER BY created_at DESC LIMIT 50`
    ).all(sessionId, `%${query}%`) as MsgRow[];
    return rows.map(rowToMessage);
  }

  /**
   * The messages compaction may summarize: every uncompacted message except the newest
   * `freshTailCount`, oldest first. "Except the newest N" is applied to the uncompacted rows
   * themselves, so this returns exactly the set that will stop being raw context — compaction
   * summarizes the entries it drops and nothing else.
   */
  getUncompactedMessages(sessionId: string, freshTailCount: number): LcmMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM lcm_messages WHERE session_id=? AND summary_id IS NULL ORDER BY created_at ASC, rowid ASC`,
    ).all(sessionId) as MsgRow[];
    const droppable = Math.max(0, rows.length - Math.max(0, freshTailCount));
    return rows.slice(0, droppable).map(rowToMessage);
  }

  /**
   * Every summary that covers at least one message of this session, oldest first — the archive
   * the ghost cues and the Upward mode's context are built from.
   */
  getSummariesForSession(sessionId: string): LcmSummary[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT s.id, s.content, s.tokens, s.level, s.operator, s.created_at, s.rowid AS rowid
      FROM lcm_summaries s
      JOIN lcm_summary_messages sm ON sm.summary_id = s.id
      JOIN lcm_messages m          ON m.id = sm.message_id
      WHERE m.session_id = ?
      ORDER BY s.created_at ASC, s.rowid ASC
    `).all(sessionId) as SumRow[];
    return rows.map((row) => this.getSummary(makeLcmSummaryId(row.id))!);
  }

  /**
   * Links an existing summary to more messages (WP-3.2 F3). A merge copies a session's messages
   * under new ids; the summary that covered the originals is shared, and this is what makes it
   * visible from the target session as well.
   */
  linkSummaryMessages(summaryId: LcmSummaryId, messageIds: LcmMessageId[]): void {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO lcm_summary_messages VALUES (?,?)`);
    const txn = this.db.transaction(() => {
      for (const id of messageIds) stmt.run(summaryId, id);
    });
    txn();
  }

  markSummarized(messageIds: LcmMessageId[], summaryId: LcmSummaryId): void {
    const stmt = this.db.prepare(`UPDATE lcm_messages SET summary_id=? WHERE id=?`);
    const txn = this.db.transaction(() => {
      for (const id of messageIds) stmt.run(summaryId, id);
    });
    txn();
  }

  /**
   * L3/V1: claims the one retry `rootId` is allowed, for the whole run and every assembly after
   * it. The row is written before the call, so a retry that fails is spent too — "retried once"
   * cannot mean "retried once per failure". Returns false when another assembly, in this process
   * or another, already claimed it.
   */
  claimRootRetry(rootId: LcmSummaryId): boolean {
    const inserted = this.db.prepare(
      `INSERT OR IGNORE INTO lcm_root_retries (root_id, retry_id, outcome, created_at) VALUES (?,?,?,?)`,
    ).run(rootId, '', 'attempted', new Date().toISOString());
    return inserted.changes === 1;
  }

  /** Records what a claimed retry produced, so the new root is not itself retried (L3/V1). */
  finishRootRetry(rootId: LcmSummaryId, retryId?: LcmSummaryId): void {
    this.db.prepare(`UPDATE lcm_root_retries SET retry_id=?, outcome=? WHERE root_id=?`)
      .run(retryId ?? '', retryId === undefined ? 'failed' : 'succeeded', rootId);
  }

  /** Whether `rootId` has already had its one retry, whatever the outcome (L3/V1). */
  hasRootRetry(rootId: LcmSummaryId): boolean {
    return this.db.prepare(`SELECT 1 AS found FROM lcm_root_retries WHERE root_id=?`)
      .get(rootId) !== undefined;
  }

  /** Whether `id` is the summary a retry produced — never retried again (L3/V1). */
  isRootRetryOutput(id: LcmSummaryId): boolean {
    return this.db.prepare(`SELECT 1 AS found FROM lcm_root_retries WHERE retry_id=? AND retry_id<>''`)
      .get(id) !== undefined;
  }

  /**
   * L3/V1: records one degradation per root and reason. Returns true when this call is the one
   * that recorded it, so the caller writes the transcript line once rather than once per assembly.
   */
  markRootDegraded(summaryId: LcmSummaryId, reason: string, tokens: number): boolean {
    const inserted = this.db.prepare(
      `INSERT OR IGNORE INTO lcm_root_degradations (summary_id, reason, tokens, created_at) VALUES (?,?,?,?)`,
    ).run(summaryId, reason, tokens, new Date().toISOString());
    return inserted.changes === 1;
  }

  close(): void { this.db.close(); }
}

function rowToMessage(r: MsgRow): LcmMessage {
  return {
    id:         makeLcmMessageId(r.id),
    sessionId:  r.session_id,
    runId:      r.run_id as RunId,
    role:       r.role as LcmMessage['role'],
    content:    r.content,
    tokens:     r.tokens,
    createdAt:  new Date(r.created_at),
    ...(r.parent_id  ? { parentId:  makeLcmMessageId(r.parent_id)  } : {}),
    ...(r.summary_id ? { summaryId: makeLcmSummaryId(r.summary_id) } : {}),
  };
}

function rowToSummary(r: SumRow, parentIds: LcmSummaryId[], messageIds: LcmMessageId[]): LcmSummary {
  return {
    id:         makeLcmSummaryId(r.id),
    content:    r.content,
    tokens:     r.tokens,
    level:      r.level,
    operator:   r.operator as LcmSummary['operator'],
    createdAt:  new Date(r.created_at),
    parentIds,
    messageIds,
  };
}
