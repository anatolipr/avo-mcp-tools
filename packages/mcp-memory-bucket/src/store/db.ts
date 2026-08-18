import Database from 'better-sqlite3';

export function openCache(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,            -- == SKILL.md "name" field == parent folder name
      description TEXT NOT NULL,      -- required by the agentskills.io spec
      owner TEXT,
      status TEXT NOT NULL,
      tags TEXT NOT NULL,             -- JSON array
      trigger_phrases TEXT NOT NULL,  -- JSON array
      extends TEXT,
      source_path TEXT NOT NULL UNIQUE, -- path to SKILL.md
      body TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_docs (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      key_type TEXT NOT NULL,
      description TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      tags TEXT NOT NULL,             -- JSON array
      status TEXT NOT NULL,
      related_to TEXT,
      source_path TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_docs_key ON memory_docs(key);
  `);

  return db;
}
