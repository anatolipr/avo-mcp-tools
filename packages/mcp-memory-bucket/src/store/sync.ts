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
import { reconcileRenamedAttachmentsDir, isUnderAttachmentsDir } from '../attachments/storage.js';

/**
 * OS-generated bookkeeping files (macOS's per-directory .DS_Store, Windows' Thumbs.db) that the OS
 * itself creates/deletes as a side effect of Finder/Explorer merely browsing a folder — never
 * user/skill content, so they must never be treated as a skill sibling to push/pull/reconcile, and
 * must never even reach the watcher's onUnmatchedFileChange hook (a stray .DS_Store churning in and
 * out of an open Finder window would otherwise spam push/trash calls against the remote folder).
 */
function isOsJunkFile(filePath: string): boolean {
  const name = path.basename(filePath);
  return name === '.DS_Store' || name === 'Thumbs.db';
}

export interface TableSyncSpec<TFrontmatter> {
  table: 'skills' | 'memory_docs';
  sources: NamedFolder[];
  /** Which files under `sources` count as this table's docs — skills only match SKILL.md, memory matches any .md. */
  matchesFile: (filePath: string) => boolean;
  columns: string[]; // column names in insert order, excluding body/mtime_ms/source_path/folder
  getId: (fm: TFrontmatter, filePath: string) => string | undefined;
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
  /**
   * Maps a local mirror filename (the last path segment, e.g. "IRT-123-Fix.md" or "SKILL.md") to
   * the name folderfoo stores it under remotely, and back. Skills always push under the fixed name
   * "SKILL" (see SkillRepository.pushToRemoteIfNeeded) regardless of the local "SKILL.md" filename.
   * Memory docs push under their own filename UNCHANGED, .md extension included (see
   * MemoryRepository.create's comment on why the extension is preserved — this is what keeps a
   * doc's own remote file and its attachments' remote directory from colliding). Used by
   * pullFile/reconcileDeletions in remote/remote-sync.ts to translate between the two naming
   * schemes without hardcoding either table's convention in that shared code.
   */
  remoteFilename: { toRemote: (localFilename: string) => string; toLocal: (remoteName: string) => string };
  /**
   * Optional post-index hook, called after upsertFile successfully indexes a file — used by memory
   * docs to reconcile an EXTERNAL (filesystem-level, outside memory_rename) rename's orphaned
   * attachments wrapper directory (see attachments/storage.ts's reconcileRenamedAttachmentsDir).
   * Skills omit this: their attachments already live inside the skill's own directory, not a
   * sibling named after the file, so an external rename can't orphan them the same way.
   */
  onIndexed?: (fm: TFrontmatter, filePath: string) => void;
  /**
   * Optional: called on every raw add/change/unlink event under `sources` that `matchesFile` did NOT
   * match. Skills use this to react to a file dropped directly into an existing skill's directory
   * (e.g. references/foo.md, scripts/bar.mjs) by a generic filesystem write that bypassed every MCP
   * tool — see server.ts's wiring — pushing/trashing it on its remote-backed parent folder. Memory
   * docs pass nothing here (a non-.md file under a memory folder has no sync story to react to).
   * Never called for a path under attachments/ — chokidar's own `ignored` filter drops those before
   * either watcher branch runs.
   */
  onUnmatchedFileChange?: (filePath: string, changeType: 'add' | 'change' | 'unlink') => void;
}

// `paused` is deliberately absent from both lists: it's a local-only cache column (see
// SkillRepository/MemoryRepository#setPaused) that never round-trips through frontmatter, so a
// file add/change/rescan must never overwrite it via the INSERT/ON CONFLICT UPDATE below.
const skillColumns = ['id', 'description', 'owner', 'status', 'tags', 'trigger_phrases', 'extends', 'skill_group', 'deprecated', 'created_at', 'attachments'];
const memoryColumns = ['key', 'key_type', 'description', 'doc_type', 'tags', 'status', 'related_to', 'deprecated', 'created_at', 'attachments'];

export function skillSyncSpec(sources: NamedFolder[]): TableSyncSpec<SkillFrontmatter> {
  return {
    table: 'skills',
    sources,
    matchesFile: (filePath) => path.basename(filePath) === 'SKILL.md',
    columns: skillColumns,
    getId: (fm) => fm.name,
    remoteFilename: {
      toRemote: () => 'SKILL',
      // SKILL.md itself pushes/pulls under the fixed opaque remote name "SKILL" (translated to/from
      // "SKILL.md" locally) — but a sibling file (references/foo.md, scripts/bar.mjs) pushes under
      // its own real name (see SkillRepository.pushSkillSiblingFileIfNeeded) and must pull back down
      // under that SAME real name, not get coerced into "SKILL.md". Only translate the one name this
      // spec actually owns; anything else passes through unchanged.
      toLocal: (remoteName) => (remoteName === 'SKILL' ? 'SKILL.md' : remoteName),
    },
    toRow: (fm, _sourcePath, mtimeMs) => ({
      id: fm.name,
      description: fm.description,
      owner: fm.metadata?.owner ?? null,
      status: fm.metadata?.status ?? 'unreviewed',
      tags: JSON.stringify(fm.tags ?? []),
      trigger_phrases: JSON.stringify(fm.trigger_phrases ?? []),
      extends: fm.metadata?.extends ?? null,
      skill_group: fm.metadata?.group ?? null,
      deprecated: fm.deprecated ? 1 : 0,
      created_at: fm.created_at ?? new Date(mtimeMs).toISOString(),
      attachments: fm.attachments ? JSON.stringify(fm.attachments) : null,
    }),
  };
}

export function memorySyncSpec(sources: NamedFolder[]): TableSyncSpec<MemoryFrontmatter> {
  return {
    table: 'memory_docs',
    sources,
    matchesFile: (filePath) => filePath.endsWith('.md'),
    columns: memoryColumns,
    getId: (_fm, filePath) => filePath,
    remoteFilename: {
      toRemote: (localFilename) => localFilename,
      // Tolerates LEGACY remote files pushed before memory docs kept their .md extension on the
      // remote side (the opaque-id era — see MemoryRepository.create's comment on why the
      // extension is preserved now). Those files are still sitting on folderfoo under a bare,
      // extensionless name (e.g. "abc123", not "abc123.md") and will stay that way until someone
      // renames/re-saves them — pullFile must still recognize them as memory docs and give them a
      // `.md` mirror filename, or they're silently skipped by matchesFile forever, and
      // reconcileDeletions (which compares local .md names against exactly what's on the remote
      // listing) would incorrectly delete a correctly-pulled local copy that has no exact remote
      // match under the new naming.
      toLocal: (remoteName) => (remoteName.endsWith('.md') ? remoteName : `${remoteName}.md`),
    },
    onIndexed: (fm, filePath) => reconcileRenamedAttachmentsDir(filePath, fm.attachments?.length ?? 0),
    deriveFrontmatter: (fm, filePath, mtimeMs) => {
      const basename = path.basename(filePath, '.md');
      return {
        ...fm,
        key: fm.key ?? normalizeKey(slugify(basename) || 'untitled'),
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
      key: fm.key,
      key_type: fm.key_type ?? 'freeform',
      description: fm.description,
      doc_type: fm.doc_type ?? 'other',
      tags: JSON.stringify(fm.tags ?? []),
      status: fm.status ?? 'active',
      related_to: fm.related_to ?? null,
      deprecated: fm.deprecated ? 1 : 0,
      created_at: fm.created_at ?? null,
      attachments: fm.attachments ? JSON.stringify(fm.attachments) : null,
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
  const existingBySourcePath = db
    .prepare(`SELECT mtime_ms FROM ${spec.table} WHERE source_path = ?`)
    .get(filePath) as { mtime_ms: number } | undefined;

  const parsed = readMarkdownFile<TFrontmatter>(filePath);
  if (existingBySourcePath && existingBySourcePath.mtime_ms === parsed.mtimeMs) return; // unchanged, skip reprocessing

  const frontmatter = spec.deriveFrontmatter
    ? spec.deriveFrontmatter(parsed.frontmatter, filePath, parsed.mtimeMs)
    : parsed.frontmatter;

  const id = spec.getId(frontmatter, filePath);
  if (!id) {
    console.error(`[memory-bucket] skipping ${filePath}: missing required id field in frontmatter`);
    return;
  }

  const row = spec.toRow(frontmatter, filePath, parsed.mtimeMs);
  const folder = folderForFile(spec.sources, filePath);

  // `skills` keys on (folder, id): name is unique PER FOLDER, not globally (see skill_get's
  // folder param) — two different folders each having a same-named skill is legitimate, so the
  // collision guard and upsert conflict target both scope by folder too. `memory_docs` has no
  // separate id column at all — its id IS filePath (source_path), the table's actual PRIMARY KEY,
  // so a "different file claiming the same id" collision is structurally impossible for it; only
  // skills needs the guard below.
  const scopedById = spec.table === 'skills';

  if (scopedById) {
    // id/name is (part of) the table's real PRIMARY KEY (the sole addressing handle across the
    // whole public API - skill_get(name, folder?)), so a DIFFERENT file claiming the same id
    // (within the same folder) is a genuine collision, not a re-scan of the same file. The ON
    // CONFLICT below would otherwise silently overwrite whichever row synced first - the
    // first-synced item's row (and its full content) simply vanishes from the cache with no error
    // and no way to address it. Refuse the overwrite and warn loudly instead: the first-synced item
    // keeps working, the colliding one is visibly excluded rather than invisibly clobbering it.
    const existingById = db.prepare(`SELECT source_path FROM ${spec.table} WHERE folder = ? AND id = ?`).get(folder, id) as
      | { source_path: string }
      | undefined;
    if (existingById && existingById.source_path !== filePath) {
      console.error(
        `[memory-bucket] SKIPPED indexing ${filePath}: id "${id}" in folder "${folder}" already used by ${existingById.source_path} — ` +
          `names must be unique within a folder. Rename one of these two files (or its frontmatter name) to resolve the collision.`
      );
      return;
    }
  }

  const cols = [...spec.columns, 'source_path', 'folder', 'body', 'mtime_ms'];
  const values = [...spec.columns.map((c) => row[c]), filePath, folder, parsed.body, parsed.mtimeMs];
  const placeholders = cols.map(() => '?').join(', ');
  const updateClause = cols
    .filter((c) => c !== 'id' && c !== 'source_path' && c !== 'folder')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const conflictTarget = scopedById ? 'folder, id' : 'source_path';

  db.prepare(
    `INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(${conflictTarget}) DO UPDATE SET ${updateClause}`
  ).run(...values);

  // ref_folder scopes these two tables' delete-then-reinsert the same way the skills upsert above
  // does: two skills in different folders can now legitimately share an `id`, so ref_id alone is
  // no longer enough to identify "this file's" search_index/doc_dates rows without also clobbering
  // the other folder's same-named skill's rows. memory_docs' id is filePath (globally unique by
  // construction), so '' (unscoped) is safe there.
  const refFolder = scopedById ? folder : '';
  db.prepare(`DELETE FROM search_index WHERE ref_table = ? AND ref_id = ? AND ref_folder = ?`).run(spec.table, id, refFolder);
  db.prepare(
    `INSERT INTO search_index (ref_table, ref_id, ref_folder, description, body, tags, key, filename) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    spec.table,
    id,
    refFolder,
    String(row.description ?? ''),
    parsed.body,
    flattenTags(String(row.tags ?? '[]')),
    String(row.key ?? row.skill_group ?? ''),
    path.basename(filePath)
  );

  db.prepare(`DELETE FROM doc_dates WHERE ref_table = ? AND ref_id = ? AND ref_folder = ?`).run(spec.table, id, refFolder);
  const dates = new Set(extractDates(parsed.body));
  // created_at is a UTC instant; convert to the OS-local calendar date so it
  // lines up with what a user in this timezone would call "today", matching
  // extractDates()'s output, which is already timezone-naive local text.
  if (row.created_at) dates.add(toLocalDate(String(row.created_at)));
  if (dates.size > 0) {
    const insertDate = db.prepare(`INSERT INTO doc_dates (ref_table, ref_id, ref_folder, date) VALUES (?, ?, ?, ?)`);
    for (const date of dates) insertDate.run(spec.table, id, refFolder, date);
  }

  spec.onIndexed?.(frontmatter, filePath);
}

export function removeFile(db: Database.Database, table: 'skills' | 'memory_docs', filePath: string): void {
  const idCol = table === 'skills' ? 'id' : 'source_path';
  const existing = db.prepare(`SELECT ${idCol} AS id, folder FROM ${table} WHERE source_path = ?`).get(filePath) as
    | { id: string; folder: string }
    | undefined;
  db.prepare(`DELETE FROM ${table} WHERE source_path = ?`).run(filePath);
  if (existing) {
    // Scoped by folder for the same reason upsertFile's ref_folder is (skills' compound key means
    // ref_id alone can match another folder's same-named skill) - memory_docs' id is filePath
    // (globally unique by construction), so its rows are always stored/looked-up with
    // ref_folder='', matching backfillSearchIndex.
    const refFolder = table === 'skills' ? existing.folder : '';
    db.prepare(`DELETE FROM search_index WHERE ref_table = ? AND ref_id = ? AND ref_folder = ?`).run(table, existing.id, refFolder);
    db.prepare(`DELETE FROM doc_dates WHERE ref_table = ? AND ref_id = ? AND ref_folder = ?`).run(table, existing.id, refFolder);
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
  const idCol = table === 'skills' ? 'id' : 'source_path';
  const rows = db.prepare(`SELECT ${idCol} AS id FROM ${table} WHERE folder = ?`).all(folderName) as Array<{ id: string }>;
  db.prepare(`DELETE FROM ${table} WHERE folder = ?`).run(folderName);
  for (const row of rows) {
    db.prepare(`DELETE FROM search_index WHERE ref_table = ? AND ref_id = ?`).run(table, row.id);
  }
}

export function* walkMarkdownFiles(dir: string): Generator<string> {
  // A directory listed here can vanish before this generator actually resumes into it — e.g.
  // upsertFile's onIndexed hook (see memorySyncSpec) can synchronously rename away another doc's
  // now-orphaned attachments wrapper directory while reconciling an external rename, mid-walk of
  // the SAME initialScan/scanSingleFolder call that's iterating this directory's siblings. Treat a
  // directory that's disappeared by the time we get to it as simply empty, not an error.
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isUnderAttachmentsDir(entry.name)) continue;
      yield* walkMarkdownFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full;
    }
  }
}

/**
 * The inverse of walkMarkdownFiles: yields every file (any extension, not just .md — an attachment
 * can be anything) that DOES live under an `attachments/` directory, anywhere under `dir`. Used by
 * remote-sync.ts's reconcileDeletions to prune stale attachment files from the local mirror once
 * they're gone from folderfoo's own listing — walkMarkdownFiles deliberately can't see these paths
 * at all (that's what keeps attachments from being indexed as standalone docs), so pruning them
 * needs its own dedicated walk.
 */
export function* walkAttachmentFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkAttachmentFiles(full);
    } else if (entry.isFile() && isUnderAttachmentsDir(full)) {
      yield full;
    }
  }
}

/**
 * Yields every file under `skillDir` (a single skill's own directory, i.e. dirname(SKILL.md's
 * source_path)) EXCEPT SKILL.md itself and anything under attachments/ — the "sibling files" a
 * portable agentskills.io skill keeps alongside SKILL.md (references/, scripts/, assets/, etc).
 * Used by push (walk-and-push on create()) and by remote-sync.ts's reconcileDeletions to prune
 * stale siblings. A sibling is never indexed as its own doc row — see skillSyncSpec's matchesFile,
 * which only ever matches SKILL.md itself.
 */
export function* walkSkillSiblingFiles(skillDir: string): Generator<string> {
  if (!fs.existsSync(skillDir)) return;
  for (const entry of fs.readdirSync(skillDir, { withFileTypes: true })) {
    const full = path.join(skillDir, entry.name);
    if (entry.isDirectory()) {
      if (isUnderAttachmentsDir(entry.name)) continue;
      yield* walkSkillSiblingFiles(full);
    } else if (entry.isFile() && entry.name !== 'SKILL.md' && !isOsJunkFile(full)) {
      yield full;
    }
  }
}

export function watchSources<TFrontmatter>(db: Database.Database, spec: TableSyncSpec<TFrontmatter>): FSWatcher {
  const watcher = chokidar.watch(
    spec.sources.map((f) => f.path),
    { ignoreInitial: true, persistent: true, depth: 10, ignored: (filePath) => isUnderAttachmentsDir(filePath) || isOsJunkFile(filePath) }
  );

  watcher
    .on('add', (filePath) => {
      if (!spec.matchesFile(filePath)) {
        spec.onUnmatchedFileChange?.(filePath, 'add');
        return;
      }
      try {
        upsertFile(db, spec, filePath);
      } catch (err) {
        console.error(`[memory-bucket] failed to index ${filePath}:`, err);
      }
    })
    .on('change', (filePath) => {
      if (!spec.matchesFile(filePath)) {
        spec.onUnmatchedFileChange?.(filePath, 'change');
        return;
      }
      try {
        upsertFile(db, spec, filePath);
      } catch (err) {
        console.error(`[memory-bucket] failed to reindex ${filePath}:`, err);
      }
    })
    .on('unlink', (filePath) => {
      if (!spec.matchesFile(filePath)) {
        spec.onUnmatchedFileChange?.(filePath, 'unlink');
        return;
      }
      removeFile(db, spec.table, filePath);
    });

  return watcher;
}
