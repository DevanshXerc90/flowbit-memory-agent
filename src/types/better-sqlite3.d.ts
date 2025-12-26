declare module 'better-sqlite3' {
  interface Statement {
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    get<T = any>(...params: any[]): T | undefined;
    all<T = any>(...params: any[]): T[];
  }

  interface DatabaseOptions {
    memory?: boolean;
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    verbose?: (...params: any[]) => void;
  }

  interface Database {
    prepare(sql: string): Statement;
    pragma(source: string): unknown;
    close(): void;
  }

  interface BetterSqlite3Constructor {
    new (filename: string, options?: DatabaseOptions): Database;
    (filename: string, options?: DatabaseOptions): Database;
  }

  const BetterSqlite3: BetterSqlite3Constructor;
  export = BetterSqlite3;
}
