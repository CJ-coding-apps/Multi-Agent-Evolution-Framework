declare module 'kuzu' {
  class Database {
    constructor(path: string, bufferPoolSize?: number);
    close(): void;
  }
  class Connection {
    constructor(database: Database, numThreads?: number);
    query(statement: string, params?: Record<string, unknown>): QueryResult;
    close(): void;
  }
  class QueryResult {
    getAll(): unknown[];
    hasNext(): boolean;
    getNext(): Record<string, unknown>;
    close(): void;
  }
  export default { Database, Connection };
}
