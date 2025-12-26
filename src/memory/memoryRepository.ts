import type { SqliteDatabase } from './db';
import type { Memory } from '../models/memory';

export interface MemoryRepository {
  initialize(): void;
  saveMemory(memory: Memory): void;
  getMemoryById(id: string): Memory | undefined;
  searchMemories(query: string, limit?: number): Memory[];
}

export function createMemoryRepository(db: SqliteDatabase): MemoryRepository {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT
    )
  `).run();

  const insertStmt = db.prepare(`
    INSERT INTO memories (id, kind, content, created_at, updated_at, source)
    VALUES (@id, @kind, @content, @created_at, @updated_at, @source)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      content = excluded.content,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      source = excluded.source
  `);

  const getByIdStmt = db.prepare(
    'SELECT id, kind, content, source, created_at as createdAt, updated_at as updatedAt FROM memories WHERE id = ?'
  );

  const searchStmt = db.prepare(
    'SELECT id, kind, content, source, created_at as createdAt, updated_at as updatedAt FROM memories WHERE content LIKE ? LIMIT ?'
  );

  return {
    initialize() {
      // Table is ensured in the factory; no-op here.
    },
    saveMemory(memory: Memory) {
      insertStmt.run({
        id: memory.id,
        kind: memory.kind,
        content: memory.content,
        created_at: memory.createdAt.toISOString(),
        updated_at: memory.updatedAt.toISOString(),
        source: memory.source ?? null,
      });
    },
    getMemoryById(id: string) {
      const row = getByIdStmt.get(id);
      if (!row) return undefined;
      return {
        ...row,
        createdAt: new Date(row.createdAt as unknown as string),
        updatedAt: new Date(row.updatedAt as unknown as string),
      } as Memory;
    },
    searchMemories(query: string, limit = 10) {
      const pattern = `%${query}%`;
      const rows = searchStmt.all(pattern, limit) as unknown as Array<{
        id: string;
        kind: Memory['kind'];
        content: string;
        source?: string | null;
        createdAt: string;
        updatedAt: string;
      }>;

      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        content: row.content,
        source: row.source ?? undefined,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      })) as Memory[];
    },
  };
}
