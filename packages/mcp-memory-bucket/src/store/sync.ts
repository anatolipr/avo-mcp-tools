import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type Database from 'better-sqlite3';
import { readMarkdownFile } from './markdown-file.js';
import { flattenTags } from './db.js';
import type { SkillFrontmatter, MemoryFrontmatter } from '../types.js';
import type { NamedRoot } from '../config.js';

export interface TableSyncSpec<TFrontmatter> {
  table: 'skills' | 'memory_docs';
  sources: NamedRoot[];
  /** Which files under `sources` count as this table's docs — skills only match SKILL.md, memory matches any .md. */
  matchesFile: (filePath: string) => boolean;
  columns: string[]; // column names in insert order, excluding body/mtime_ms/source_path/root
  getId: (fm: TFrontmatter) => string | undefined;
  toRow: (fm: TFrontmatter, sourcePath: string) => Record<string, unknown>;
}

const skillColumns = ['id', 'description', 'owner', 'status', 'tags', 'trigger_phrases', 'extends', 'deprecated', 'created_at'];
const memoryColumns = ['id', 'key', 'key_type', 'description', 'doc_type', 'tags', 'status', 'related_to', 'deprecated', 'created_at'];

export function skillSyncSpec(sources: NamedRoot[]): TableSyncSpec<SkillFrontmatter> {
  return {
    table: 'skills',
    sources,
    matchesFile: (filePath) => path.basename(filePath) === 'SKILL.md',
    columns: skillColumns,
    getId: (fm) => fm.name,
    toRow: (fm) => ({
      id: fm.name,
      description: fm.description,
      owner: fm.metadata?.owner ?? null,
      status: fm.metadata?.status ?? 'unreviewed',
      tags: JSON.stringify(fm.tags ?? []),
      trigger_phrases: JSON.stringify(fm.trigger_phrases ?? []),
      extends: fm.metadata?.extends ?? null,
      deprecated: fm.deprecated ? 1 : 0,
      created_at: fm.created_at ?? null,
    }),
  };
}

export function memorySyncSpec(sources: NamedRoot[]): TableSyncSpec<MemoryFrontmatter> {
  return {
    table: 'memory_docs',
    sources,
    matchesFile: (filePath) => filePath.endsWith('.md'),
    columns: memoryColumns,
    getId: (fm) => fm.id,
    toRow: (fm) => ({
      id: fm.id,
      key: fm.key,
      key_type: fm.key_type ?? 'freeform',
      description: fm.description,
      doc_type: fm.doc_type ?? 'other',
      tags: JSON.stringify(fm.tags ?? []),
      status: fm.status ?? 'active',
      related_to: fm.related_to ?? null,
      deprecated: fm.deprecated ? 1 : 0,
      created_at: fm.created_at ?? null,
    }),
  };
}

/**
 * Upserts one file's frontmatter/body into its cache table, keyed by mtime
 * so an unchanged file is skipped. Exported so repositories can index
 * synchronously right after their own writes — the watcher's own event for
 * that same write becomes a harmless no-op re-check once mtime matches.
 */
/** Which configured root a file lives under, by longest matching path prefix. */
function rootForFile(sources: NamedRoot[], filePath: string): string {
  const resolved = path.resolve(filePath);
  let best: NamedRoot | undefined;
  for (const root of sources) {
    const rootPath = path.resolve(root.path);
    if (resolved === rootPath || resolved.startsWith(rootPath + path.sep)) {
      if (!best || rootPath.length > path.resolve(best.path).length) best = root;
    }
  }
  return best?.name ?? '';
}

export function upsertFile<TFrontmatter>(
  db: Database.Database,
  spec: TableSyncSpec<TFrontmatter>,
  filePath: string
): void {
  const existing = db
    .prepare(`SELECT mtime_ms FROM ${spec.table} WHERE source_path = ?`)
    .get(filePath) as { mtime_ms: number } | undefined;

  const parsed = readMarkdownFile<TFrontmatter>(filePath);
  if (existing && existing.mtime_ms === parsed.mtimeMs) return; // unchanged, skip reprocessing

  const id = spec.getId(parsed.frontmatter);
  if (!id) {
    console.error(`[memory-bucket] skipping ${filePath}: missing required id field in frontmatter`);
    return;
  }

  const row = spec.toRow(parsed.frontmatter, filePath);
  const root = rootForFile(spec.sources, filePath);
  const cols = [...spec.columns, 'source_path', 'root', 'body', 'mtime_ms'];
  const values = [...spec.columns.map((c) => row[c]), filePath, root, parsed.body, parsed.mtimeMs];
  const placeholders = cols.map(() => '?').join(', ');
  const updateClause = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');

  db.prepare(
    `INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updateClause}`
  ).run(...values);

  db.prepare(`DELETE FROM search_index WHERE ref_table = ? AND ref_id = ?`).run(spec.table, id);
  db.prepare(
    `INSERT INTO search_index (ref_table, ref_id, description, body, tags) VALUES (?, ?, ?, ?, ?)`
  ).run(spec.table, id, String(row.description ?? ''), parsed.body, flattenTags(String(row.tags ?? '[]')));
}

export function removeFile(db: Database.Database, table: 'skills' | 'memory_docs', filePath: string): void {
  const existing = db.prepare(`SELECT id FROM ${table} WHERE source_path = ?`).get(filePath) as
    | { id: string }
    | undefined;
  db.prepare(`DELETE FROM ${table} WHERE source_path = ?`).run(filePath);
  if (existing) {
    db.prepare(`DELETE FROM search_index WHERE ref_table = ? AND ref_id = ?`).run(table, existing.id);
  }
}

/** Full scan of all configured source dirs — used once at startup before the watcher takes over. */
export function initialScan<TFrontmatter>(db: Database.Database, spec: TableSyncSpec<TFrontmatter>): void {
  for (const root of spec.sources) {
    if (!fs.existsSync(root.path)) continue;
    for (const file of walkMarkdownFiles(root.path)) {
      if (!spec.matchesFile(file)) continue;
      try {
        upsertFile(db, spec, file);
      } catch (err) {
        console.error(`[memory-bucket] failed to index ${file}:`, err);
      }
    }
  }
}

/** Full scan of a single dir — used when a new root is added live, after registering it in spec.sources. */
export function scanSingleRoot<TFrontmatter>(
  db: Database.Database,
  spec: TableSyncSpec<TFrontmatter>,
  dirPath: string
): void {
  if (!fs.existsSync(dirPath)) return;
  for (const file of walkMarkdownFiles(dirPath)) {
    if (!spec.matchesFile(file)) continue;
    try {
      upsertFile(db, spec, file);
    } catch (err) {
      console.error(`[memory-bucket] failed to index ${file}:`, err);
    }
  }
}

/** Drops all cached rows (and search index entries) belonging to a removed root. Never touches files on disk. */
export function unregisterRoot(db: Database.Database, table: 'skills' | 'memory_docs', rootName: string): void {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE root = ?`).all(rootName) as Array<{ id: string }>;
  db.prepare(`DELETE FROM ${table} WHERE root = ?`).run(rootName);
  for (const row of rows) {
    db.prepare(`DELETE FROM search_index WHERE ref_table = ? AND ref_id = ?`).run(table, row.id);
  }
}

function* walkMarkdownFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdownFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full;
    }
  }
}

export function watchSources<TFrontmatter>(db: Database.Database, spec: TableSyncSpec<TFrontmatter>): FSWatcher {
  const watcher = chokidar.watch(
    spec.sources.map((r) => r.path),
    { ignoreInitial: true, persistent: true, depth: 10 }
  );

  watcher
    .on('add', (filePath) => {
      if (!spec.matchesFile(filePath)) return;
      try {
        upsertFile(db, spec, filePath);
      } catch (err) {
        console.error(`[memory-bucket] failed to index ${filePath}:`, err);
      }
    })
    .on('change', (filePath) => {
      if (!spec.matchesFile(filePath)) return;
      try {
        upsertFile(db, spec, filePath);
      } catch (err) {
        console.error(`[memory-bucket] failed to reindex ${filePath}:`, err);
      }
    })
    .on('unlink', (filePath) => {
      if (!spec.matchesFile(filePath)) return;
      removeFile(db, spec.table, filePath);
    });

  return watcher;
}
