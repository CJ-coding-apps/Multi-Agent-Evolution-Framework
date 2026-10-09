// KuzuDB driver — the single point where maf talks to the graph backend.
//
// Everything goes through `run(query)`, and `run` binds its parameters. There is deliberately no
// method that takes a statement on its own: the defect this replaces was a `query(cypher, params)`
// whose `params` were dropped on the floor (the real `Connection.query` takes one argument) and
// re-created by string substitution at the call site, in three copies of a quote-escaping helper.
// With no such method and no such helper, a value cannot become part of a query's text.
//
// The native module is loaded LAZILY on first use so that merely importing @maf/memory-graph
// (e.g. from the CLI for `--help`) never touches the platform-specific kuzu binary. A
// missing/broken kuzu install only surfaces when a KuzuDriver is actually constructed.
//
// Native lifetimes (WP-2.15). A kuzu `QueryResult` holds its rows in memory owned by its
// `Database`'s buffer manager, and the binding frees them only in the result's own destructor.
// Left to the garbage collector, that destructor runs in whatever order Node drains its finalizer
// queue — after the `Database`'s own, as often as not — and then writes into a freed buffer
// manager: a segfault, or a heap corrupted for a later, unrelated `malloc` to abort on. That was
// the crash in a process that drops a graph and keeps running, and it was also why
// `Database.close()` "segfaulted": it freed the buffer manager under results still waiting for GC.
// So every result is closed as soon as it has been read, and `close()` then closes the connection
// and the database in that order, once no query is in flight, so nothing outlives what it points
// into and the database's address-space reservation is returned when the graph is closed.
import type { Connection, Database, KuzuModule } from 'kuzu';
import type { GraphQuery, GraphRow } from '@maf/types';

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

export class KuzuDriver {
  private readonly db:   Database;
  private readonly conn: Connection;
  private readonly ready: Promise<void>;
  /** Native work not yet settled: the connection's initialisation, then each `run`. */
  private inFlight = 0;
  private closed = false;
  private released = false;

  constructor(private readonly dbPath: string, bufferPoolSizeBytes = 128 * 1024 * 1024) {
    const kuzu = loadKuzu();
    this.db   = new kuzu.Database(dbPath, bufferPoolSizeBytes);
    this.conn = new kuzu.Connection(this.db);
    // kuzu v0.7.x requires async init before any query. `_getConnection` is undocumented and
    // resolves to the same object; the cast is narrowed to the one hook rather than the whole
    // connection, so the rest of this class stays typed.
    const init = (this.conn as unknown as { _getConnection(): Promise<void> })._getConnection();
    this.ready = this.track(init).catch(() => undefined);
  }

  /**
   * Parses and runs `query`. An unresolvable query throws — a caller is never handed an empty
   * result for a query that failed, because those two facts must not be interchangeable.
   */
  async run(query: GraphQuery): Promise<GraphRow[]> {
    if (this.closed) {
      throw new Error(`The graph at ${this.dbPath} is closed; a query was issued after close().`);
    }
    return this.track(this.execute(query));
  }

  private async execute(query: GraphQuery): Promise<GraphRow[]> {
    await this.ready;
    const prepared = await this.conn.prepare(query.cypher);
    const result   = await this.conn.execute(prepared, query.params);
    try {
      return await result.getAll() as GraphRow[];
    } finally {
      result.close(); // now, while the database it points into is certainly alive
    }
  }

  /**
   * Closes the graph: later queries are refused, and the connection and database are released as
   * soon as no query is in flight — at once when the graph is idle, which is how every caller
   * closes it, so the database is checkpointed before the caller goes on (to delete its directory,
   * say). One in flight finishes first rather than having its database freed under it.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.inFlight === 0) this.release();
  }

  private async track<T>(work: Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await work;
    } finally {
      this.inFlight--;
      if (this.closed && this.inFlight === 0) this.release();
    }
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    // Connection before database. Both are initialised here (nothing is in flight, and `ready`
    // has settled), so each native close happens synchronously inside the call; the promises only
    // carry a failed initialisation, which leaves nothing native to free.
    this.conn.close().catch(() => undefined);
    this.db.close().catch(() => undefined);
  }
}
