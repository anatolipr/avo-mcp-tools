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
      folder TEXT NOT NULL DEFAULT '',  -- name of the configured folder this file lives under
      deprecated INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0, -- local-only: never synced from/to SKILL.md, cache-file scoped
      created_at TEXT,
      attachments TEXT,               -- JSON array of AttachmentEntry, mirrors frontmatter
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
      folder TEXT NOT NULL DEFAULT '',  -- name of the configured folder this file lives under
      deprecated INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0, -- local-only: never synced from/to the doc's markdown file, cache-file scoped
      created_at TEXT,
      attachments TEXT,               -- JSON array of AttachmentEntry, mirrors frontmatter
      body TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_docs_key ON memory_docs(key);

    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      ref_table UNINDEXED,
      ref_id UNINDEXED,
      description,
      body,
      tags,
      key,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS doc_dates (
      ref_table TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      date TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_doc_dates_date ON doc_dates(date);
    CREATE INDEX IF NOT EXISTS idx_doc_dates_ref ON doc_dates(ref_table, ref_id);
  `);

  ensureColumns(db, 'skills', [
    ['folder', "TEXT NOT NULL DEFAULT ''"],
    ['deprecated', 'INTEGER NOT NULL DEFAULT 0'],
    ['paused', 'INTEGER NOT NULL DEFAULT 0'],
    ['created_at', 'TEXT'],
    ['attachments', 'TEXT'],
  ]);
  ensureColumns(db, 'memory_docs', [
    ['folder', "TEXT NOT NULL DEFAULT ''"],
    ['deprecated', 'INTEGER NOT NULL DEFAULT 0'],
    ['paused', 'INTEGER NOT NULL DEFAULT 0'],
    ['created_at', 'TEXT'],
    ['attachments', 'TEXT'],
  ]);
  ensureSearchIndexHasKeyColumn(db);
  backfillSearchIndex(db);

  return db;
}

/**
 * search_index is an FTS5 virtual table — existing cache files created before the `key` column
 * existed need it added. FTS5 doesn't support ALTER TABLE ADD COLUMN reliably across versions, and
 * search_index is a disposable cache (rebuilt from skills/memory_docs, not the source of truth), so
 * the simplest safe migration is: drop and recreate with the new schema, then let backfillSearchIndex
 * repopulate everything.
 */
function ensureSearchIndexHasKeyColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(search_index)`).all() as Array<{ name: string }>;
  if (cols.length === 0 || cols.some((c) => c.name === 'key')) return; // fresh table, or already migrated
  db.exec(`DROP TABLE search_index`);
  db.exec(`
    CREATE VIRTUAL TABLE search_index USING fts5(
      ref_table UNINDEXED,
      ref_id UNINDEXED,
      description,
      body,
      tags,
      key,
      tokenize = 'porter unicode61'
    );
  `);
}

/** Migration for cache files created before a given column existed. Safe to call every startup. */
function ensureColumns(
  db: Database.Database,
  table: 'skills' | 'memory_docs',
  columns: Array<[name: string, ddlType: string]>
): void {
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, ddlType] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddlType}`);
  }
}

/** One-time backfill for existing rows the first time search_index is introduced into a cache file. */
function backfillSearchIndex(db: Database.Database): void {
  const { count: indexed } = db.prepare(`SELECT COUNT(*) as count FROM search_index`).get() as { count: number };
  if (indexed > 0) return;

  const skillRows = db.prepare(`SELECT id, description, body, tags FROM skills`).all() as Array<{
    id: string;
    description: string;
    body: string;
    tags: string;
  }>;
  const memoryRows = db.prepare(`SELECT id, key, description, body, tags FROM memory_docs`).all() as Array<{
    id: string;
    key: string;
    description: string;
    body: string;
    tags: string;
  }>;
  if (skillRows.length === 0 && memoryRows.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO search_index (ref_table, ref_id, description, body, tags, key) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertAll = db.transaction(() => {
    for (const row of skillRows) {
      insert.run('skills', row.id, row.description, row.body, flattenTags(row.tags), '');
    }
    for (const row of memoryRows) {
      insert.run('memory_docs', row.id, row.description, row.body, flattenTags(row.tags), row.key);
    }
  });
  insertAll();
}

export function flattenTags(tagsJson: string): string {
  try {
    return (JSON.parse(tagsJson) as string[]).join(' ');
  } catch {
    return '';
  }
}
