import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type Database from 'better-sqlite3';
import { readMarkdownFile } from './markdown-file.js';
import type { SkillFrontmatter, MemoryFrontmatter } from '../types.js';

export interface TableSyncSpec<TFrontmatter> {
  table: 'skills' | 'memory_docs';
  sources: string[];
  /** Which files under `sources` count as this table's docs — skills only match SKILL.md, memory matches any .md. */
  matchesFile: (filePath: string) => boolean;
  columns: string[]; // column names in insert order, excluding body/mtime_ms/source_path
  getId: (fm: TFrontmatter) => string | undefined;
  toRow: (fm: TFrontmatter, sourcePath: string) => Record<string, unknown>;
}

const skillColumns = ['id', 'description', 'owner', 'status', 'tags', 'trigger_phrases', 'extends'];
const memoryColumns = ['id', 'key', 'key_type', 'description', 'doc_type', 'tags', 'status', 'related_to'];

export function skillSyncSpec(sources: string[]): TableSyncSpec<SkillFrontmatter> {
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
    }),
  };
}

export function memorySyncSpec(sources: string[]): TableSyncSpec<MemoryFrontmatter> {
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
    }),
  };
}

/**
 * Upserts one file's frontmatter/body into its cache table, keyed by mtime
 * so an unchanged file is skipped. Exported so repositories can index
 * synchronously right after their own writes — the watcher's own event for
 * that same write becomes a harmless no-op re-check once mtime matches.
 */
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
  const cols = [...spec.columns, 'source_path', 'body', 'mtime_ms'];
  const values = [...spec.columns.map((c) => row[c]), filePath, parsed.body, parsed.mtimeMs];
  const placeholders = cols.map(() => '?').join(', ');
  const updateClause = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');

  db.prepare(
    `INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updateClause}`
  ).run(...values);
}

export function removeFile(db: Database.Database, table: 'skills' | 'memory_docs', filePath: string): void {
  db.prepare(`DELETE FROM ${table} WHERE source_path = ?`).run(filePath);
}

/** Full scan of all configured source dirs — used once at startup before the watcher takes over. */
export function initialScan<TFrontmatter>(db: Database.Database, spec: TableSyncSpec<TFrontmatter>): void {
  for (const dir of spec.sources) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walkMarkdownFiles(dir)) {
      if (!spec.matchesFile(file)) continue;
      try {
        upsertFile(db, spec, file);
      } catch (err) {
        console.error(`[memory-bucket] failed to index ${file}:`, err);
      }
    }
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
  const watcher = chokidar.watch(spec.sources, {
    ignoreInitial: true,
    persistent: true,
    depth: 10,
  });

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
