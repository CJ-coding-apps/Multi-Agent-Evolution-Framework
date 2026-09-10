// KuzuDB driver — uses require() since kuzu has no TS types.
// The native module is loaded LAZILY on first use so that merely importing
// @maf/memory-graph (e.g. from the CLI for `--help`) never touches the
// platform-specific kuzu binary. A missing/broken kuzu install only surfaces
// when a KuzuDriver is actually constructed.
interface KuzuModule {
  Database:   new (path: string, bufferPoolSize?: number) => unknown;
  Connection: new (db: unknown, numThreads?: number) => unknown;
}

let kuzuModule: KuzuModule | undefined;

function loadKuzu(): KuzuModule {
  if (!kuzuModule) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      kuzuModule = require('kuzu') as KuzuModule;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load the kuzu native module. Graph-memory features require a working ` +
        `kuzu install for this platform (try reinstalling dependencies). Underlying error: ${detail}`,
      );
    }
  }
  return kuzuModule;
}

export interface QueryResult {
  getAll(): Promise<unknown[]>;
  hasNext(): boolean;
  close(): void;
}

export class KuzuDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db:   any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private conn: any;
  private ready: Promise<void>;

  constructor(dbPath: string, bufferPoolSizeBytes = 128 * 1024 * 1024) {
    const kuzu = loadKuzu();
    this.db   = new kuzu.Database(dbPath, bufferPoolSizeBytes);
    this.conn = new kuzu.Connection(this.db);
    // kuzu v0.7.x requires async init before any query
    this.ready = (this.conn._getConnection() as Promise<void>).catch(() => undefined);
  }

  async query(cypher: string): Promise<QueryResult> {
    await this.ready;
    return this.conn.query(cypher) as Promise<QueryResult>;
  }

  async execute(cypher: string): Promise<void> {
    await this.ready;
    await this.conn.query(cypher);
  }

  close(): void {
    // db.close() segfaults on Node 25 / kuzu 0.7.1 — let GC handle it
    try { this.conn.close?.(); } catch { /* ignore */ }
  }
}
