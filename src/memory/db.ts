import Database = require('better-sqlite3');

export interface SqliteStatement<TParams extends any[] = any[], TRow = any> {
  run(...params: TParams): { changes: number; lastInsertRowid: number | bigint };
  get(...params: TParams): TRow | undefined;
  all(...params: TParams): TRow[];
}

export interface SqliteDatabase {
  prepare<TParams extends any[] = any[], TRow = any>(sql: string): SqliteStatement<TParams, TRow>;
  pragma(source: string): unknown;
  close(): void;
}

export function openMemoryDatabase(filename = 'data/memory.db'): SqliteDatabase {
  const db = new (Database as any)(filename) as SqliteDatabase;
  db.pragma('journal_mode = WAL');
  return db;
}
