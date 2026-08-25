import Database from 'better-sqlite3';

export function openCache(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  ensureSkillsCompoundKey(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT NOT NULL,               -- == SKILL.md "name" field == parent folder name
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
      mtime_ms INTEGER NOT NULL,
      PRIMARY KEY (folder, id)        -- name is unique PER FOLDER, not globally — see skill_get's folder param
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
      ref_folder UNINDEXED,
      description,
      body,
      tags,
      key,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS doc_dates (
      ref_table TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      ref_folder TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_doc_dates_date ON doc_dates(date);
    CREATE INDEX IF NOT EXISTS idx_doc_dates_ref ON doc_dates(ref_table, ref_id, ref_folder);
  `);

  ensureDocDatesHasRefFolderColumn(db);
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
 * search_index is an FTS5 virtual table — existing cache files created before the `key` or
 * `ref_folder` column existed need it added. `ref_folder` was added alongside skills' compound
 * (folder, id) key (see ensureSkillsCompoundKey's doc comment): once two different folders can
 * legitimately have a skill sharing the same `id`, ref_id alone no longer uniquely identifies a
 * search_index row, so ref_folder joins ref_table/ref_id as part of every lookup/delete on this
 * table. FTS5 doesn't support ALTER TABLE ADD COLUMN reliably across versions, and search_index is
 * a disposable cache (rebuilt from skills/memory_docs, not the source of truth), so the simplest
 * safe migration is: drop and recreate with the new schema, then let backfillSearchIndex repopulate
 * everything.
 */
function ensureSearchIndexHasKeyColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(search_index)`).all() as Array<{ name: string }>;
  if (cols.length === 0 || (cols.some((c) => c.name === 'key') && cols.some((c) => c.name === 'ref_folder'))) return; // fresh table, or already migrated
  db.exec(`DROP TABLE search_index`);
  db.exec(`
    CREATE VIRTUAL TABLE search_index USING fts5(
      ref_table UNINDEXED,
      ref_id UNINDEXED,
      ref_folder UNINDEXED,
      description,
      body,
      tags,
      key,
      tokenize = 'porter unicode61'
    );
  `);
}

/**
 * Migration for cache files created before doc_dates had a ref_folder column — same reason as
 * search_index's ref_folder addition above (ensureSearchIndexHasKeyColumn's doc comment). Unlike
 * search_index, doc_dates is a plain table, so a simple ALTER TABLE ADD COLUMN suffices; no drop
 * needed. Existing rows backfill to '' (unscoped), which is safe: the only NEW ambiguity ref_folder
 * resolves is a skill-name collision across folders, and any pre-existing doc_dates row predates
 * that possibility (skills only just gained a compound key), so nothing has been misattributed yet.
 */
function ensureDocDatesHasRefFolderColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(doc_dates)`).all() as Array<{ name: string }>;
  if (cols.length === 0 || cols.some((c) => c.name === 'ref_folder')) return; // fresh table, or already migrated
  db.exec(`ALTER TABLE doc_dates ADD COLUMN ref_folder TEXT NOT NULL DEFAULT ''`);
}

/**
 * Migration for cache files created before `skills` had a compound (folder, id) PRIMARY KEY — name
 * uniqueness moved from global to per-folder (see relocate's folder-scoping fix), so the old bare-`id`
 * key must become (folder, id). `skills` is a disposable cache fully rebuilt from SKILL.md files on
 * disk (initialScan/the file watcher repopulate it), so — same precedent as
 * ensureSearchIndexHasKeyColumn's search_index migration — the simplest safe migration is to drop and
 * let the normal scan repopulate, rather than hand-writing a data-preserving ALTER TABLE.
 */
function ensureSkillsCompoundKey(db: Database.Database): void {
  const pk = (db.prepare(`PRAGMA table_info(skills)`).all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0);
  if (pk.length === 0 || pk.some((c) => c.name === 'folder')) return; // fresh table, or already migrated to the compound key
  db.exec(`DROP TABLE skills`);
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

  const skillRows = db.prepare(`SELECT id, folder, description, body, tags FROM skills`).all() as Array<{
    id: string;
    folder: string;
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
    `INSERT INTO search_index (ref_table, ref_id, ref_folder, description, body, tags, key) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAll = db.transaction(() => {
    for (const row of skillRows) {
      insert.run('skills', row.id, row.folder, row.description, row.body, flattenTags(row.tags), '');
    }
    for (const row of memoryRows) {
      insert.run('memory_docs', row.id, '', row.description, row.body, flattenTags(row.tags), row.key);
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
