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

  constructor(dbPath: string, bufferPoolSizeBytes = 128 * 1024 * 1024) {
    const kuzu = loadKuzu();
    this.db   = new kuzu.Database(dbPath, bufferPoolSizeBytes);
    this.conn = new kuzu.Connection(this.db);
    // kuzu v0.7.x requires async init before any query. `_getConnection` is undocumented and
    // resolves to the same object; the cast is narrowed to the one hook rather than the whole
    // connection, so the rest of this class stays typed.
    const init = (this.conn as unknown as { _getConnection(): Promise<void> })._getConnection();
    this.ready = init.catch(() => undefined);
  }

  /**
   * Parses and runs `query`. An unresolvable query throws — a caller is never handed an empty
   * result for a query that failed, because those two facts must not be interchangeable.
   */
  async run(query: GraphQuery): Promise<GraphRow[]> {
    await this.ready;
    const prepared = await this.conn.prepare(query.cypher);
    const result   = await this.conn.execute(prepared, query.params);
    return await result.getAll() as GraphRow[];
  }

  close(): void {
    // db.close() segfaults on Node 25 / kuzu 0.7.1 — let GC handle it
    try { this.conn.close(); } catch { /* ignore */ }
  }
}
