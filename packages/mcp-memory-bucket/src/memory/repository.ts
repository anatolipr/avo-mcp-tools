import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { writeMarkdownFile } from '../store/markdown-file.js';
import { slugify } from '../store/slug.js';
import { resolveWithinBase } from '../store/safe-path.js';
import { upsertFile, removeFile, scanSingleFolder, unregisterFolder, memorySyncSpec, type TableSyncSpec } from '../store/sync.js';
import { SearchQueryError } from '../store/search.js';
import type { NamedFolder } from '../config.js';
import { normalizeKey } from '../types.js';
import type { MemoryDoc, MemoryDocType, MemoryFrontmatter, MemoryKeyType, MemoryStatus } from '../types.js';

interface MemoryRow {
  id: string;
  key: string;
  key_type: MemoryKeyType;
  description: string;
  doc_type: MemoryDocType;
  tags: string; // JSON
  status: MemoryStatus;
  related_to: string | null;
  source_path: string;
  folder: string;
  deprecated: number;
  paused: number;
  created_at: string | null;
  body: string;
}

function rowToDoc(row: MemoryRow): MemoryDoc {
  return {
    id: row.id,
    key: row.key,
    key_type: row.key_type,
    description: row.description,
    doc_type: row.doc_type,
    tags: JSON.parse(row.tags),
    status: row.status,
    related_to: row.related_to,
    deprecated: !!row.deprecated,
    paused: !!row.paused,
    created_at: row.created_at ?? undefined,
    source_path: row.source_path,
    folder: row.folder,
    body: row.body,
  };
}

export class MemoryRepository {
  private syncSpec: TableSyncSpec<MemoryFrontmatter>;
  private watcher?: FSWatcher;

  constructor(private db: Database.Database, private folders: NamedFolder[]) {
    this.syncSpec = memorySyncSpec(folders);
  }

  /** Attaches the live chokidar watcher so addFolder/removeFolder can mutate it without a restart. */
  setWatcher(watcher: FSWatcher): void {
    this.watcher = watcher;
  }

  listFolders(): NamedFolder[] {
    return [...this.folders];
  }

  private resolveFolder(folderName: string | undefined): NamedFolder {
    if (folderName) {
      const found = this.folders.find((f) => f.name === folderName);
      if (!found) {
        throw new Error(`unknown memory folder "${folderName}" — valid folders: ${this.folders.map((f) => f.name).join(', ') || '(none configured)'}`);
      }
      return found;
    }
    if (this.folders.length === 1) return this.folders[0]!;
    if (this.folders.length === 0) {
      throw new Error('no memory folder configured — add one first (see bucket_open_ui)');
    }
    throw new Error(`multiple memory folders configured — specify folder: one of ${this.folders.map((f) => f.name).join(', ')}`);
  }

  /** Registers a new folder: appends it, scans it once, and starts watching it live. */
  addFolder(folder: NamedFolder): void {
    if (this.folders.some((f) => f.name === folder.name)) {
      throw new Error(`a memory folder named "${folder.name}" already exists`);
    }
    this.folders.push(folder);
    scanSingleFolder(this.db, this.syncSpec, folder.path);
    this.watcher?.add(folder.path);
  }

  /** Unregisters a folder: stops watching it and drops its cached rows. Never touches files on disk. */
  removeFolder(name: string): void {
    const idx = this.folders.findIndex((f) => f.name === name);
    if (idx === -1) throw new Error(`memory folder "${name}" not found`);
    const [removed] = this.folders.splice(idx, 1);
    this.watcher?.unwatch(removed!.path);
    unregisterFolder(this.db, 'memory_docs', name);
  }

  /**
   * Exact-match lookup by normalized key, per V0 (no fuzzy matching).
   * `includePaused` defaults to false: paused docs are hidden from discovery (see setPaused).
   */
  getByKey(key: string, docType?: MemoryDocType, opts: { includePaused?: boolean } = {}): MemoryDoc[] {
    const normalized = normalizeKey(key);
    const conditions = ['key = ?'];
    const params: unknown[] = [normalized];
    if (docType) {
      conditions.push('doc_type = ?');
      params.push(docType);
    }
    if (!opts.includePaused) {
      conditions.push('paused = 0');
    }
    const rows = this.db
      .prepare(`SELECT * FROM memory_docs WHERE ${conditions.join(' AND ')}`)
      .all(...params) as MemoryRow[];
    return rows.map(rowToDoc);
  }

  /**
   * Full-text search over memory description/body/tags via FTS5 — `query` is
   * raw FTS5 MATCH syntax (AND/OR/NOT, "phrases", prefix*). Ranked by bm25.
   * Optional metadata filters (doc_type/status/folder/tag) apply before limit/offset,
   * so pagination stays correct even when filtering narrows the FTS hit set.
   */
  search(
    query: string,
    opts: {
      docType?: MemoryDocType;
      status?: MemoryStatus;
      folder?: string;
      tag?: string;
      limit?: number;
      offset?: number;
      /** Defaults to false: paused docs are hidden from discovery (see setPaused). */
      includePaused?: boolean;
    } = {}
  ): Array<{ id: string; key: string; description: string; doc_type: MemoryDocType; folder: string; snippet: string; score: number }> {
    const { docType, status, folder, tag, limit = 20, offset = 0, includePaused = false } = opts;
    const conditions: string[] = [];
    const params: unknown[] = [query];
    if (docType) {
      conditions.push('m.doc_type = ?');
      params.push(docType);
    }
    if (status) {
      conditions.push('m.status = ?');
      params.push(status);
    }
    if (folder) {
      conditions.push('m.folder = ?');
      params.push(folder);
    }
    if (tag) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)');
      params.push(tag);
    }
    if (!includePaused) {
      conditions.push('m.paused = 0');
    }
    params.push(limit, offset);

    try {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.key, m.description, m.doc_type, m.folder,
                  snippet(search_index, 3, '<<', '>>', '…', 20) AS snippet,
                  -bm25(search_index) AS score
           FROM search_index
           JOIN memory_docs m ON m.id = search_index.ref_id
           WHERE search_index.ref_table = 'memory_docs' AND search_index MATCH ? ${conditions.map((c) => `AND ${c}`).join(' ')}
           ORDER BY bm25(search_index)
           LIMIT ? OFFSET ?`
        )
        .all(...params) as Array<{
        id: string;
        key: string;
        description: string;
        doc_type: MemoryDocType;
        folder: string;
        snippet: string;
        score: number;
      }>;
      return rows;
    } catch (err) {
      throw new SearchQueryError(query, err);
    }
  }

  get(id: string): MemoryDoc | null {
    const row = this.db.prepare(`SELECT * FROM memory_docs WHERE id = ?`).get(id) as MemoryRow | undefined;
    return row ? rowToDoc(row) : null;
  }

  /** Fetches many memory docs by id in one call — e.g. hydrating full bodies for a batch of search() hits. Missing ids are simply absent from the result, not errors. */
  bulkGet(ids: string[]): MemoryDoc[] {
    return ids.map((id) => this.get(id)).filter((doc): doc is MemoryDoc => doc !== null);
  }

  listKeys(keyPrefix?: string): Array<{ key: string; docCount: number }> {
    const rows = this.db
      .prepare(`SELECT key, COUNT(*) as doc_count FROM memory_docs GROUP BY key ORDER BY key`)
      .all() as Array<{ key: string; doc_count: number }>;
    const prefix = keyPrefix ? normalizeKey(keyPrefix) : undefined;
    return rows
      .filter((r) => !prefix || r.key.startsWith(prefix))
      .map((r) => ({ key: r.key, docCount: r.doc_count }));
  }

  create(input: {
    key: string;
    key_type: MemoryKeyType;
    doc_type: MemoryDocType;
    description: string;
    body: string;
    tags?: string[];
    status?: MemoryStatus;
    related_to?: string | null;
    subfolder?: string;
    folder?: string;
  }): MemoryDoc {
    const normalizedKey = normalizeKey(input.key);
    const id = `${slugify(normalizedKey)}-${slugify(input.description)}-${randomUUID().slice(0, 8)}`;
    const targetFolder = this.resolveFolder(input.folder);
    const filePath = resolveWithinBase(targetFolder.path, input.subfolder, `${id}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const fm: MemoryFrontmatter = {
      id,
      key: normalizedKey,
      key_type: input.key_type,
      description: input.description,
      doc_type: input.doc_type,
      tags: input.tags ?? [],
      status: input.status ?? 'active',
      related_to: input.related_to ?? null,
      deprecated: false,
      created_at: new Date().toISOString(),
      source_path: filePath,
      folder: targetFolder.name,
    };
    writeMarkdownFile(filePath, stripSourcePath(fm), input.body);
    upsertFile(this.db, this.syncSpec, filePath);
    return { ...fm, body: input.body, paused: false };
  }

  /**
   * Creates many memory docs in one call — each entry is the same shape as
   * create()'s input. Returns per-key results (with the id filled in on
   * success) so one bad entry doesn't abort the rest of the batch.
   */
  bulkCreate(
    entries: Array<{
      key: string;
      key_type: MemoryKeyType;
      doc_type: MemoryDocType;
      description: string;
      body: string;
      tags?: string[];
      status?: MemoryStatus;
      related_to?: string | null;
      subfolder?: string;
      folder?: string;
    }>
  ): Array<{ key: string; ok: boolean; id?: string; error?: string }> {
    return entries.map((entry) => {
      try {
        const doc = this.create(entry);
        return { key: entry.key, ok: true, id: doc.id };
      } catch (err) {
        return { key: entry.key, ok: false, error: (err as Error).message };
      }
    });
  }

  update(id: string, frontmatter?: Partial<MemoryFrontmatter>, body?: string): MemoryDoc {
    const existing = this.get(id);
    if (!existing) throw new Error(`memory doc with id "${id}" not found`);
    // `paused` is local-cache-only and must never reach writeMarkdownFile — split it off of
    // `existing` before spreading the rest into the frontmatter that gets written to disk.
    const { paused: existingPaused, ...existingForFile } = existing;

    const merged: MemoryFrontmatter = {
      ...existingForFile,
      ...frontmatter,
      id: existing.id,
      key: frontmatter?.key ? normalizeKey(frontmatter.key) : existing.key,
    };
    const newBody = body ?? existing.body;
    writeMarkdownFile(existing.source_path, stripSourcePath(merged), newBody);
    upsertFile(this.db, this.syncSpec, existing.source_path);
    return { ...merged, body: newBody, paused: existingPaused };
  }

  /**
   * Applies the same frontmatter change to many memory docs at once — e.g.
   * add/remove a tag across a batch found via search(), or flip status for a
   * group (e.g. mark a set of docs "shipped"). Tags in `add_tags`/`remove_tags`
   * are merged/subtracted per-doc; `status`/`related_to` overwrite uniformly
   * when provided. Never touches body. Returns per-id results so partial
   * failures (e.g. an unknown id) don't abort the rest of the batch.
   */
  bulkUpdate(
    ids: string[],
    changes: {
      add_tags?: string[];
      remove_tags?: string[];
      status?: MemoryStatus;
      related_to?: string | null;
      deprecated?: boolean;
    }
  ): Array<{ id: string; ok: boolean; error?: string }> {
    return ids.map((id) => {
      try {
        const existing = this.get(id);
        if (!existing) throw new Error(`memory doc with id "${id}" not found`);
        let tags = existing.tags;
        if (changes.add_tags?.length) tags = Array.from(new Set([...tags, ...changes.add_tags]));
        if (changes.remove_tags?.length) tags = tags.filter((t) => !changes.remove_tags!.includes(t));
        this.update(id, {
          tags,
          ...(changes.status !== undefined ? { status: changes.status } : {}),
          ...(changes.related_to !== undefined ? { related_to: changes.related_to } : {}),
          ...(changes.deprecated !== undefined ? { deprecated: changes.deprecated } : {}),
        });
        return { id, ok: true };
      } catch (err) {
        return { id, ok: false, error: (err as Error).message };
      }
    });
  }

  /**
   * Pauses/resumes memory docs by id — a local-only toggle stored directly in this cache file's
   * `paused` column, never written to the doc's markdown file and never synced by the file
   * watcher (see the comment on memoryColumns in store/sync.ts). Paused docs are hidden from
   * getByKey()/search() by default but remain fetchable via get()/bulkGet(). Because it's
   * local-only, the flag does not follow the doc to another machine's cache or survive the cache
   * file being deleted. Returns per-id results so one bad id doesn't abort the rest of the batch.
   */
  setPaused(ids: string[], paused: boolean): Array<{ id: string; ok: boolean; error?: string }> {
    return ids.map((id) => {
      try {
        const existing = this.get(id);
        if (!existing) throw new Error(`memory doc with id "${id}" not found`);
        this.db.prepare(`UPDATE memory_docs SET paused = ? WHERE id = ?`).run(paused ? 1 : 0, id);
        return { id, ok: true };
      } catch (err) {
        return { id, ok: false, error: (err as Error).message };
      }
    });
  }

  delete(id: string): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`memory doc with id "${id}" not found`);
    fs.unlinkSync(existing.source_path);
    removeFile(this.db, 'memory_docs', existing.source_path);
  }

  /**
   * Strips the doc's frontmatter entirely, leaving a bare markdown file with just the body — the
   * inverse of memory_create, for turning a managed memory doc back into a plain dropped-in file.
   * The file stays at the same path, but loses its `key` (so it drops out of key-based lookup) and
   * its `id` — the upsertFile call below immediately re-derives a fresh one from the filename via
   * deriveFrontmatter's fallback, so the caller should treat this doc as gone under its old id
   * once this returns (look it up by the new filename-derived id/key instead).
   */
  stripFrontmatter(id: string): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`memory doc with id "${id}" not found`);
    writeMarkdownFile(existing.source_path, {}, existing.body);
    upsertFile(this.db, this.syncSpec, existing.source_path);
  }

  /**
   * Deletes many memory docs by id in one call — e.g. cleaning up a batch of
   * abandoned docs found via search(). Returns per-id results so one bad id
   * doesn't abort the rest of the batch.
   */
  bulkDelete(ids: string[]): Array<{ id: string; ok: boolean; error?: string }> {
    return ids.map((id) => {
      try {
        this.delete(id);
        return { id, ok: true };
      } catch (err) {
        return { id, ok: false, error: (err as Error).message };
      }
    });
  }
}

function stripSourcePath<T extends { source_path: string; folder: string }>(fm: T): Omit<T, 'source_path' | 'folder'> {
  const { source_path: _sp, folder: _folder, ...rest } = fm;
  return rest;
}
