import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type {
  LcmMessage, LcmSummary, LcmMessageId, LcmSummaryId, RunId,
} from '@maf/types';
import { makeLcmMessageId, makeLcmSummaryId } from '@maf/types';

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
    this.db.exec(SCHEMA);
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
    parentIds: LcmSummaryId[],
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
      for (const p of parentIds)  insertParent.run(id, p);
      for (const m of messageIds) insertMsgLink.run(id, m);
    });
    txn();
    return id;
  }

  getMessagesBySession(sessionId: string, limit?: number): LcmMessage[] {
    const rows = limit
      ? this.db.prepare(`SELECT * FROM lcm_messages WHERE session_id=? ORDER BY created_at ASC LIMIT ?`).all(sessionId, limit) as MsgRow[]
      : this.db.prepare(`SELECT * FROM lcm_messages WHERE session_id=? ORDER BY created_at ASC`).all(sessionId) as MsgRow[];
    return rows.map(rowToMessage);
  }

  getMessagesByIds(ids: LcmMessageId[]): LcmMessage[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM lcm_messages WHERE id IN (${placeholders})`).all(...ids) as MsgRow[];
    return rows.map(rowToMessage);
  }

  getSummary(id: LcmSummaryId): LcmSummary | undefined {
    const row = this.db.prepare(`SELECT * FROM lcm_summaries WHERE id=?`).get(id) as SumRow | undefined;
    if (!row) return undefined;
    const parentIds = (this.db.prepare(`SELECT parent_id FROM lcm_summary_parents WHERE summary_id=?`).all(id) as Array<{parent_id:string}>).map(r => makeLcmSummaryId(r.parent_id));
    const messageIds = (this.db.prepare(`SELECT message_id FROM lcm_summary_messages WHERE summary_id=?`).all(id) as Array<{message_id:string}>).map(r => makeLcmMessageId(r.message_id));
    return rowToSummary(row, parentIds, messageIds);
  }

  searchMessages(query: string, sessionId: string): LcmMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM lcm_messages WHERE session_id=? AND content LIKE ? ORDER BY created_at DESC LIMIT 50`
    ).all(sessionId, `%${query}%`) as MsgRow[];
    return rows.map(rowToMessage);
  }

  // Returns messages not yet linked to a summary (candidates for compaction)
  getUncompactedMessages(sessionId: string, freshTailCount: number): LcmMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM lcm_messages
      WHERE session_id=? AND summary_id IS NULL
      ORDER BY created_at ASC
      LIMIT MAX(0, (SELECT COUNT(*) FROM lcm_messages WHERE session_id=?) - ?)
    `).all(sessionId, sessionId, freshTailCount) as MsgRow[];
    return rows.map(rowToMessage);
  }

  markSummarized(messageIds: LcmMessageId[], summaryId: LcmSummaryId): void {
    const stmt = this.db.prepare(`UPDATE lcm_messages SET summary_id=? WHERE id=?`);
    const txn = this.db.transaction(() => {
      for (const id of messageIds) stmt.run(summaryId, id);
    });
    txn();
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
