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
// So every result is closed as soon as it has been read, and `close()` — which returns a promise —
// closes the connection and then the database once no work is in flight, so nothing outlives what
// it points into, the database's address-space reservation is returned before that promise
// resolves, and a caller may delete the directory immediately after awaiting it.
import fs from 'node:fs';
import path from 'node:path';
import type { Connection, Database, KuzuModule } from 'kuzu';
import type { GraphQuery, GraphRow } from '@maf/types';

let kuzuModule: KuzuModule | undefined;

/** The Kùzu library actually loaded, for the export file's record and for error messages. */
export function kuzuVersion(): string {
  return loadKuzu().VERSION;
}

/**
 * A graph this Kùzu build cannot open. A 0.7.x database is a directory and 0.11.3 writes one
 * file, so the old graph does not fail as a corrupt file — it fails as the wrong shape, with a
 * message that says nothing about migration. This class carries the sentence that does (D-58).
 */
export class GraphOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphOpenError';
  }
}

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
  /** Resolves the waiters of `whenSettled`, once `inFlight` has reached zero. */
  private idleWaiters: Array<() => void> = [];
  /** The one release this driver runs; a second `close()` hands back the same promise. */
  private closePromise: Promise<void> | undefined;

  constructor(private readonly dbPath: string, bufferPoolSizeBytes = 128 * 1024 * 1024, kuzuOverride?: KuzuModule) {
    // `kuzuOverride` is a test seam, and only that: it lets a test inject a module whose `init()`
    // rejects and whose `conn.close()` then throws — the 0.11.3 release path (see `release`) that
    // has no other way to be reached. In production it is undefined and the real native module is
    // loaded lazily, exactly as before.
    const kuzu = kuzuOverride ?? loadKuzu();
    // 0.7.1 created a missing parent directory; 0.11.3 refuses with "Cannot open database
    // because the directory does not exist". A caller naming a path may not have made its
    // parent yet (`buildRunStack` is one), so the driver creates it, as the older version did.
    // A failure here is not reported from here: the open below names the real reason.
    if (dbPath !== ':memory:') {
      try { fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true }); } catch { /* reported by the open */ }
    }
    try {
      this.db   = new kuzu.Database(dbPath, bufferPoolSizeBytes);
      this.conn = new kuzu.Connection(this.db);
    } catch (err) {
      throw openFailure(dbPath, err);
    }
    // Both 0.7.1 and 0.11.3 expose the same async `init()`. It used to reach through the
    // undocumented `_getConnection`, which 0.11.3 no longer has.
    this.ready = this.track(this.conn.init()).catch((err) => { throw openFailure(this.dbPath, err); });
    // The rejection is still delivered to every `run` that awaits `ready`; this only stops Node
    // reporting it as unhandled when a caller constructs a graph and never queries it.
    this.ready.catch(() => undefined);
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
   * Closes the graph. A later query is refused at once, and the returned promise resolves only
   * after the connection and then the database have been closed — so a caller that removes the
   * directory, or opens another graph, may do so after awaiting it (WP-3.8 follow-up).
   *
   * Waiting, not checking, is what makes that true. `init()` is in flight for every graph whose
   * constructor has just returned, and a query may be in flight too; the old `close()` released
   * only when `inFlight` happened to be zero at that instant, and otherwise returned while the
   * release was still pending. The release now waits for `ready` and then for the counter to reach
   * zero, and a second `close()` returns the same promise.
   *
   * A native close that fails rejects this promise rather than resolving it: a caller in a
   * `finally` must not remove the directory of a database that did not close. The exception is an
   * `init()` that failed: that error was already delivered through `ready`, so the close resolves
   * rather than reporting it twice — see `release()` for the two paths, including the database
   * deliberately leaked when only the connection's init failed.
   *
   * Known property, not a defect: there is no deadline. A native query that never settles keeps
   * `close()` pending, and every `finally { await graph.close() }` in the CLI waits with it. A
   * deadline was refused because the only thing it can do at expiry is free handles under live
   * work — the crash this file exists to prevent.
   */
  close(): Promise<void> {
    this.closed = true; // from here on, `run` refuses at once
    this.closePromise ??= this.release();
    return this.closePromise;
  }

  private async track<T>(work: Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await work;
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) {
        const waiting = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiting) resolve();
      }
    }
  }

  /** Resolves the next time `inFlight` reaches zero. Called only with work already in flight. */
  private whenSettled(): Promise<void> {
    return new Promise<void>((resolve) => { this.idleWaiters.push(resolve); });
  }

  private async release(): Promise<void> {
    // `ready` is the connection's `init()`, tracked like a query. It may reject, and that
    // rejection has already been handed to every `run` that awaited it, so it is swallowed here
    // rather than replacing the close. What it does change is what the closes below can do — the
    // two init-failure paths differ (see the comment on them) — which is why it is recorded.
    let initFailed = false;
    await this.ready.catch(() => { initFailed = true; });
    while (this.inFlight > 0) await this.whenSettled();
    // Connection first, and the database is freed ONLY once the connection has actually been
    // released. A `Connection.close()` whose `init()` rejected re-awaits the retained rejected
    // init promise and throws there, *before* it closes the native connection: in the installed
    // binding, `kuzu@0.11.3 connection.js:425-445`, `close()` reaches `await this._initPromise`
    // (line 432) and never reaches `this._connection.close()` (line 442). Freeing the `Database`
    // under a connection that still points into its buffer manager is the use-after-free this file
    // exists to prevent, so when `conn.close()` throws the database is left for the garbage
    // collector instead — a leaked handle on an error path is the lesser evil. When `conn.close()`
    // succeeds the database is closed as normal: its address-space reservation is returned before
    // this promise resolves, so a caller may delete the directory after awaiting it.
    const failures: Array<{ part: 'connection' | 'database'; error: unknown }> = [];
    let connClosed = false;
    try { await this.conn.close(); connClosed = true; } catch (error) { failures.push({ part: 'connection', error }); }
    if (connClosed) {
      try { await this.db.close(); } catch (error) { failures.push({ part: 'database', error }); }
    }
    // Two init-failure paths reach here, and they differ in what the closes above did.
    //
    // (a) The database failed to open — the 0.7.x-directory refusal is the reachable one.
    // `Connection.init()` throws while opening the database, before it builds a native connection,
    // so it retains neither a connection nor an init promise. `conn.close()` therefore returns
    // normally, and `db.close()` is called: it re-awaits the database's own retained rejected init
    // promise and throws there, so a database failure is recorded. The close still resolves — the
    // one real error was already delivered through `ready`, and reporting it again here would say
    // nothing new. There is no live connection to free the database under.
    //
    // (b) Only the connection's `init()` failed, after `Connection.init()` had opened the database.
    // `conn.close()` re-awaits the connection's retained rejected init promise and throws *before*
    // it releases the native connection (the citation above), so `db.close()` is skipped and the
    // natively open database is deliberately leaked to the garbage collector rather than freed
    // under a connection that may still point into its buffer manager. That leak is why the close
    // resolves here too: this is the error path, not a successful release.
    //
    // Any failure after a real `init()` means a handle may still be open, so the close rejects; a
    // caller never treats a failed release as a successful one.
    if (initFailed || failures.length === 0) return;
    throw releaseFailure(this.dbPath, failures);
  }
}

/**
 * The rejection a caller gets when the native release failed after a successful initialisation:
 * which handle would not close, and why. The first underlying error rides along as `cause`.
 */
function releaseFailure(
  dbPath: string,
  failures: Array<{ part: 'connection' | 'database'; error: unknown }>,
): Error {
  const detail = failures.map(({ part, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    return `kuzu's ${part} close failed: ${message}`;
  }).join('; ');
  return new Error(`The graph at ${dbPath} was not released: ${detail}`, { cause: failures[0]?.error });
}

/**
 * Turns the native opening failure into the one a user can act on, when it is the
 * 0.7.x-directory case; every other failure keeps its own message, because inventing a
 * migration story for a corrupt file would send the user down the wrong path.
 */
function openFailure(dbPath: string, err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  const looksLikeVersion = /cannot be a directory|different version|database file version/i.test(message);
  if (!looksLikeVersion || dbPath === ':memory:') return err;

  let isDirectory = false;
  try { isDirectory = fs.statSync(dbPath).isDirectory(); } catch { /* missing is a new graph */ }
  if (!isDirectory) return err;

  const version = safeVersion();
  // The route has to be one a user can actually follow. No released maf carries `graph export`,
  // and this Kùzu cannot read the old format, so "export it with the maf that wrote it" was an
  // instruction no installed version could carry out. A memory graph from 0.5.x or earlier is not
  // carried into this one: it holds failure recall history, and nothing else that lives here.
  return new GraphOpenError(
    `The graph at ${dbPath} was written by Kùzu 0.7.x, and this maf uses Kùzu ${version}, which ` +
    `cannot read the older format (Kùzu changed it before 1.0). It holds this repository's recall ` +
    `history — the failures and plans earlier runs recorded — and nothing else: your code, branches ` +
    `and attestations live elsewhere and are unaffected, and a new graph simply starts empty. To keep ` +
    `the old one and let maf start a new graph, run:\n\n` +
    `    mv ${dbPath} ${dbPath}.0.7-backup\n\n` +
    `maf does not move or delete it for you. Original error: ${message}`,
  );
}

function safeVersion(): string {
  try { return kuzuVersion(); } catch { return '0.11.3'; }
}
