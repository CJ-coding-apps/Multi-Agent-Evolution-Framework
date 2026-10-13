// The real shape of the `kuzu` package (0.7.1), which ships no types of its own.
//
// This file used to declare `query(statement, params?)` and a default export. Both were false:
// the module exports its classes directly (the driver reaches them with `require('kuzu')`), and
// `Connection.query` takes one argument only — which is why the parameter object every caller
// passed was silently dropped and every query was string-interpolated instead. The declarations
// below are what the binding probe measured, not what looked plausible.
declare module 'kuzu' {
  class Database {
    constructor(path: string, bufferPoolSize?: number);
    /**
     * `async` in the binding: the native close runs synchronously inside the call once the
     * database is initialised; the promise rejects only for an initialisation that failed.
     */
    close(): Promise<void>;
  }

  /**
   * A statement the connection has parsed. Parameters are declared by the statement's `$names`
   * and supplied at `execute`; a parameter the statement does not name, a `null`, an array or a
   * plain object are all rejected rather than coerced.
   */
  class PreparedStatement {
    isSuccess(): boolean;
    getErrorMessage(): string;
  }

  type KuzuParameter = boolean | number | string | Date | bigint;

  class Connection {
    constructor(database: Database, numThreads?: number);
    /** Parses `statement`. Throws with a parser/binder message when it cannot. */
    prepare(statement: string): Promise<PreparedStatement>;
    execute(
      preparedStatement: PreparedStatement,
      params?: Record<string, KuzuParameter>,
    ): Promise<QueryResult>;
    /** `async` in the binding, like `Database.close`. */
    close(): Promise<void>;
  }

  class QueryResult {
    getAll(): Promise<unknown[]>;
    hasNext(): boolean;
    getNext(): Promise<Record<string, unknown>>;
    /** Frees the rows, which live in the database's buffer manager — synchronously. */
    close(): void;
  }

  /** The module object itself, as `require('kuzu')` returns it — the classes are properties, not a default export. */
  export interface KuzuModule {
    Database:   typeof Database;
    Connection: typeof Connection;
  }
}
