import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type Database from 'better-sqlite3';
import { readMarkdownFile } from './markdown-file.js';
import { flattenTags } from './db.js';
import { extractDates, toLocalDate } from './date-extract.js';
import { slugify } from './slug.js';
import { normalizeKey } from '../types.js';
import type { SkillFrontmatter, MemoryFrontmatter } from '../types.js';
import type { NamedFolder } from '../config.js';

export interface TableSyncSpec<TFrontmatter> {
  table: 'skills' | 'memory_docs';
  sources: NamedFolder[];
  /** Which files under `sources` count as this table's docs — skills only match SKILL.md, memory matches any .md. */
  matchesFile: (filePath: string) => boolean;
  columns: string[]; // column names in insert order, excluding body/mtime_ms/source_path/folder
  getId: (fm: TFrontmatter) => string | undefined;
  // `mtimeMs` (last-modified time, see readMarkdownFile) is used as a created_at fallback for
  // docs/skills that predate that frontmatter field. Deliberately mtime, not birthtime: birthtime
  // can be preserved across `cp`/duplicate operations (some tools/filesystems copy it from the
  // source file), which would make a freshly-copied doc report a stale "created" date. mtime is
  // reliably reset to "now" by any write, so it's the more trustworthy fallback in practice.
  toRow: (fm: TFrontmatter, sourcePath: string, mtimeMs: number) => Record<string, unknown>;
  /**
   * Optional fallback for files with no (or incomplete) frontmatter — fills in defaults derived
   * from the file itself so a plain dropped-in .md still gets indexed rather than skipped. Runs
   * before getId/toRow. Skills omit this: SKILL.md's `name`/`description` are spec-required and
   * meaningful, so a skill missing them is a real authoring error, not a file to paper over.
   */
  deriveFrontmatter?: (fm: TFrontmatter, filePath: string, mtimeMs: number) => TFrontmatter;
}

// `paused` is deliberately absent from both lists: it's a local-only cache column (see
// SkillRepository/MemoryRepository#setPaused) that never round-trips through frontmatter, so a
// file add/change/rescan must never overwrite it via the INSERT/ON CONFLICT UPDATE below.
const skillColumns = ['id', 'description', 'owner', 'status', 'tags', 'trigger_phrases', 'extends', 'deprecated', 'created_at'];
const memoryColumns = ['id', 'key', 'key_type', 'description', 'doc_type', 'tags', 'status', 'related_to', 'deprecated', 'created_at'];

export function skillSyncSpec(sources: NamedFolder[]): TableSyncSpec<SkillFrontmatter> {
  return {
    table: 'skills',
    sources,
    matchesFile: (filePath) => path.basename(filePath) === 'SKILL.md',
    columns: skillColumns,
    getId: (fm) => fm.name,
    toRow: (fm, _sourcePath, mtimeMs) => ({
      id: fm.name,
      description: fm.description,
      owner: fm.metadata?.owner ?? null,
      status: fm.metadata?.status ?? 'unreviewed',
      tags: JSON.stringify(fm.tags ?? []),
      trigger_phrases: JSON.stringify(fm.trigger_phrases ?? []),
      extends: fm.metadata?.extends ?? null,
      deprecated: fm.deprecated ? 1 : 0,
      created_at: fm.created_at ?? new Date(mtimeMs).toISOString(),
    }),
  };
}

export function memorySyncSpec(sources: NamedFolder[]): TableSyncSpec<MemoryFrontmatter> {
  return {
    table: 'memory_docs',
    sources,
    matchesFile: (filePath) => filePath.endsWith('.md'),
    columns: memoryColumns,
    getId: (fm) => fm.id,
    deriveFrontmatter: (fm, filePath, mtimeMs) => {
      const basename = path.basename(filePath, '.md');
      const fallbackId = slugify(basename) || 'untitled';
      return {
        ...fm,
        id: fm.id ?? fallbackId,
        key: fm.key ?? normalizeKey(fallbackId),
        key_type: fm.key_type ?? 'freeform',
        description: fm.description ?? basename,
        doc_type: fm.doc_type ?? 'other',
        status: fm.status ?? 'active',
        tags: fm.tags ?? [],
        related_to: fm.related_to ?? null,
        created_at: fm.created_at ?? new Date(mtimeMs).toISOString(),
      };
    },
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
/** Which configured folder a file lives under, by longest matching path prefix. */
function folderForFile(sources: NamedFolder[], filePath: string): string {
  const resolved = path.resolve(filePath);
  let best: NamedFolder | undefined;
  for (const folder of sources) {
    const folderPath = path.resolve(folder.path);
    if (resolved === folderPath || resolved.startsWith(folderPath + path.sep)) {
      if (!best || folderPath.length > path.resolve(best.path).length) best = folder;
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

  const frontmatter = spec.deriveFrontmatter
    ? spec.deriveFrontmatter(parsed.frontmatter, filePath, parsed.mtimeMs)
    : parsed.frontmatter;

  const id = spec.getId(frontmatter);
  if (!id) {
    console.error(`[memory-bucket] skipping ${filePath}: missing required id field in frontmatter`);
    return;
  }

  const row = spec.toRow(frontmatter, filePath, parsed.mtimeMs);
  const folder = folderForFile(spec.sources, filePath);
  const cols = [...spec.columns, 'source_path', 'folder', 'body', 'mtime_ms'];
  const values = [...spec.columns.map((c) => row[c]), filePath, folder, parsed.body, parsed.mtimeMs];
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
    `INSERT INTO search_index (ref_table, ref_id, description, body, tags, key) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(spec.table, id, String(row.description ?? ''), parsed.body, flattenTags(String(row.tags ?? '[]')), String(row.key ?? ''));

  db.prepare(`DELETE FROM doc_dates WHERE ref_table = ? AND ref_id = ?`).run(spec.table, id);
  const dates = new Set(extractDates(parsed.body));
  // created_at is a UTC instant; convert to the OS-local calendar date so it
  // lines up with what a user in this timezone would call "today", matching
  // extractDates()'s output, which is already timezone-naive local text.
  if (row.created_at) dates.add(toLocalDate(String(row.created_at)));
  if (dates.size > 0) {
    const insertDate = db.prepare(`INSERT INTO doc_dates (ref_table, ref_id, date) VALUES (?, ?, ?)`);
    for (const date of dates) insertDate.run(spec.table, id, date);
  }
}

export function removeFile(db: Database.Database, table: 'skills' | 'memory_docs', filePath: string): void {
  const existing = db.prepare(`SELECT id FROM ${table} WHERE source_path = ?`).get(filePath) as
    | { id: string }
    | undefined;
  db.prepare(`DELETE FROM ${table} WHERE source_path = ?`).run(filePath);
  if (existing) {
    db.prepare(`DELETE FROM search_index WHERE ref_table = ? AND ref_id = ?`).run(table, existing.id);
    db.prepare(`DELETE FROM doc_dates WHERE ref_table = ? AND ref_id = ?`).run(table, existing.id);
  }
}

/** Full scan of all configured source dirs — used once at startup before the watcher takes over. */
export function initialScan<TFrontmatter>(db: Database.Database, spec: TableSyncSpec<TFrontmatter>): void {
  for (const folder of spec.sources) {
    if (!fs.existsSync(folder.path)) continue;
    for (const file of walkMarkdownFiles(folder.path)) {
      if (!spec.matchesFile(file)) continue;
      try {
        upsertFile(db, spec, file);
      } catch (err) {
        console.error(`[memory-bucket] failed to index ${file}:`, err);
      }
    }
  }
}

/** Full scan of a single dir — used when a new folder is added live, after registering it in spec.sources. */
export function scanSingleFolder<TFrontmatter>(
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

/** Drops all cached rows (and search index entries) belonging to a removed folder. Never touches files on disk. */
export function unregisterFolder(db: Database.Database, table: 'skills' | 'memory_docs', folderName: string): void {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE folder = ?`).all(folderName) as Array<{ id: string }>;
  db.prepare(`DELETE FROM ${table} WHERE folder = ?`).run(folderName);
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
    spec.sources.map((f) => f.path),
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
