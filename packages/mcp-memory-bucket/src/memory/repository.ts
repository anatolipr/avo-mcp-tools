import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import matter from 'gray-matter';
import { writeMarkdownFile } from '../store/markdown-file.js';
import { slugify } from '../store/slug.js';
import { resolveWithinBase } from '../store/safe-path.js';
import { upsertFile, removeFile, scanSingleFolder, unregisterFolder, memorySyncSpec, type TableSyncSpec } from '../store/sync.js';
import { SearchQueryError, sanitizeFtsQuery } from '../store/search.js';
import { applyBodyEdits, type BodyEdit } from '../shared/body-edits.js';
import { attachmentsDirFor } from '../attachments/storage.js';
import type { NamedFolder, RemoteFolder } from '../config.js';
import { rebaseFolderPath } from '../config.js';
import { normalizeKey } from '../types.js';
import { readFile as readRemoteFile, writeFile as writeRemoteFile, joinRemoteFolderPath, assertRemoteFolderExists } from '../remote/folderfoo-client.js';
import { isFolderVisible, type IdentityTracker } from '../remote/identity.js';
import type { MemoryDoc, MemoryDocType, MemoryFrontmatter, MemoryKeyType, MemoryStatus } from '../types.js';

/** Uppercases and strips everything but letters/digits — used to compare keys that differ only in
 * punctuation/whitespace formatting (e.g. `RMXS-15` and `RMXS15` strip to the same `RMXS15`). */
export function stripKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

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
  attachments: string | null; // JSON
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
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
    source_path: row.source_path,
    folder: row.folder,
    body: row.body,
  };
}

export class MemoryRepository {
  private syncSpec: TableSyncSpec<MemoryFrontmatter>;
  private watcher?: FSWatcher;

  constructor(
    private db: Database.Database,
    private folders: NamedFolder[],
    private remoteFolders: RemoteFolder[] = [],
    private credentialsBaseDir?: string,
    private identity?: IdentityTracker
  ) {
    this.syncSpec = memorySyncSpec(folders);
  }

  /** The RemoteFolder a NamedFolder name resolves to, or undefined for a local (non-remote) folder. */
  private remoteFor(folderName: string): RemoteFolder | undefined {
    return this.remoteFolders.find((f) => f.name === folderName);
  }

  /** Whether `folderName` should be visible right now — always true for local folders; for a remote folder, only when it matches the current login (see identity.ts). No identity tracker configured means folderfoo integration is off entirely, so nothing remote is ever visible. */
  private isFolderNameVisible(folderName: string): boolean {
    const remote = this.remoteFor(folderName);
    if (!remote) return true;
    if (!this.identity) return false;
    return isFolderVisible(remote, this.identity.current());
  }

  /** Names of every remote folder NOT matching the current identity — used to exclude their rows from list/search SQL. */
  private hiddenFolderNames(): string[] {
    if (!this.identity) return this.remoteFolders.map((f) => f.name);
    const identity = this.identity.current();
    return this.remoteFolders.filter((f) => !isFolderVisible(f, identity)).map((f) => f.name);
  }

  /** Attaches the live chokidar watcher so addFolder/removeFolder can mutate it without a restart. */
  setWatcher(watcher: FSWatcher): void {
    this.watcher = watcher;
  }

  listFolders(): NamedFolder[] {
    return [...this.folders];
  }

  /** Full RemoteFolder records (server/tenantId/folderPath/mirrorDir) for every connected remote source — for matching an incoming folderfoo-file-open address back to a configured source. */
  listRemoteFolders(): RemoteFolder[] {
    return [...this.remoteFolders];
  }

  /** Same as listFolders(), but tags each entry with whether it's a remote (folderfoo) source — for the web UI's folder list, e.g. to render remote folders in a distinct color. Excludes remote folders that don't match the current login (see identity.ts). */
  listFoldersWithRemoteInfo(): Array<NamedFolder & { remote: boolean }> {
    return this.folders.filter((f) => this.isFolderNameVisible(f.name)).map((f) => ({ ...f, remote: !!this.remoteFor(f.name) }));
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

  /**
   * Registers a new REMOTE (folderfoo) folder: creates its local mirror
   * directory, registers it exactly like a local addFolder (so it starts
   * watching/scanning immediately — empty at first, since nothing's been
   * pulled from folderfoo yet), and records the folderfoo coordinates so
   * get()/create()/update() know to treat this folder as remote. Does NOT
   * perform the initial pull itself — the caller (the web route) does one
   * immediate poll right after this returns, so content shows up without
   * waiting for the first interval tick.
   */
  registerRemoteFolder(remote: RemoteFolder): void {
    if (this.folders.some((f) => f.name === remote.name)) {
      throw new Error(`a memory folder named "${remote.name}" already exists`);
    }
    fs.mkdirSync(remote.mirrorDir, { recursive: true });
    this.remoteFolders.push(remote);
    this.addFolder({ name: remote.name, path: remote.mirrorDir });
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

  /**
   * Unregisters a folder: stops watching it and drops its cached rows. Never touches the user's
   * own files on disk. If `name` was a remote (folderfoo) source, also drops its RemoteFolder
   * entry (so a same-named folder added afterwards, local or remote, isn't mistaken for the old
   * connection by remoteFor()) and deletes its local mirror cache directory — that mirror is
   * bucket-owned derived state, not user content, and gets recreated fresh on reconnect.
   */
  removeFolder(name: string): void {
    const idx = this.folders.findIndex((f) => f.name === name);
    if (idx === -1) throw new Error(`memory folder "${name}" not found`);
    const [removed] = this.folders.splice(idx, 1);
    this.watcher?.unwatch(removed!.path);
    unregisterFolder(this.db, 'memory_docs', name);
    const remoteIdx = this.remoteFolders.findIndex((f) => f.name === name);
    if (remoteIdx !== -1) {
      const [removedRemote] = this.remoteFolders.splice(remoteIdx, 1);
      fs.rmSync(removedRemote!.mirrorDir, { recursive: true, force: true });
    }
  }

  /**
   * Repoints a registered remote source's `folderPath` in place after it was renamed/moved on
   * folderfoo — see SkillRepository's identical method for the full rationale (kept in sync with
   * that one; this file has its own remoteFolders array, not shared state).
   */
  updateRemoteFolderPath(name: string, renamedFolderPath: string, newFolderPath: string): void {
    const remote = this.remoteFolders.find((f) => f.name === name);
    if (!remote) return;
    remote.folderPath = rebaseFolderPath(remote.folderPath, renamedFolderPath, newFolderPath);
  }

  /**
   * Exact-match lookup by normalized key, per V0 (no fuzzy matching).
   * `includePaused` defaults to false: paused docs are hidden from discovery (see setPaused).
   * `folder`, when passed, restricts to docs in that one folder — memory_docs.id never collides
   * across folders (it bakes in a random UUID suffix), but a human-facing `key` can legitimately
   * repeat in different folders, so any caller treating "same key+description" as "the same doc"
   * (e.g. relocate's already-relocated check) needs this to avoid a false match against an
   * unrelated doc that just happens to share a key/description in a different folder.
   */
  getByKey(key: string, docType?: MemoryDocType, opts: { includePaused?: boolean; folder?: string } = {}): MemoryDoc[] {
    const normalized = normalizeKey(key);
    const conditions = ['key = ?'];
    const params: unknown[] = [normalized];
    if (docType) {
      conditions.push('doc_type = ?');
      params.push(docType);
    }
    if (opts.folder) {
      conditions.push('folder = ?');
      params.push(opts.folder);
    }
    if (!opts.includePaused) {
      conditions.push('paused = 0');
    }
    const hidden = this.hiddenFolderNames();
    if (hidden.length > 0) {
      conditions.push(`folder NOT IN (${hidden.map(() => '?').join(', ')})`);
      params.push(...hidden);
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
    const params: unknown[] = [sanitizeFtsQuery(query)];
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
    const hidden = this.hiddenFolderNames();
    if (hidden.length > 0) {
      conditions.push(`m.folder NOT IN (${hidden.map(() => '?').join(', ')})`);
      params.push(...hidden);
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

  /**
   * For a doc in a LOCAL folder, returns the cached row unchanged (identical behavior to before
   * remote sources existed). For a doc in a REMOTE folder, the cached `body` is only ever a
   * poll-interval-stale mirror snapshot — per the settled design, `get` always fetches the current
   * body live from folderfoo instead of trusting it, so a caller never sees stale content just
   * because the last poll tick hasn't run yet.
   */
  async get(id: string): Promise<MemoryDoc | null> {
    const row = this.db.prepare(`SELECT * FROM memory_docs WHERE id = ?`).get(id) as MemoryRow | undefined;
    if (!row) return null;
    const doc = rowToDoc(row);
    if (!this.isFolderNameVisible(doc.folder)) return null;
    const remote = this.remoteFor(doc.folder);
    if (!remote || !this.credentialsBaseDir) return doc;
    const relPath = path.relative(remote.mirrorDir, doc.source_path).replace(/\.md$/, '');
    const dir = joinRemoteFolderPath(remote.folderPath, path.dirname(relPath));
    const name = path.basename(relPath);
    // readRemoteFile returns the file's RAW bytes as folderfoo stored them -
    // the whole markdown file, frontmatter block included, since folderfoo
    // has no concept of frontmatter/body separation (that's purely a
    // mem-bucket/gray-matter concept). Using this raw content directly as
    // `body` was a real bug: the next update() would writeMarkdownFile a
    // FRESH frontmatter block wrapped around this already-frontmattered
    // blob, nesting one level deeper on every single edit (confirmed via a
    // real corrupted doc: 3 levels of self-nested frontmatter+body after 3
    // edits). Must parse it exactly like a local file read would.
    const liveBody = matter(await readRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dir, name)).content.trim();
    return { ...doc, body: liveBody };
  }

  /** Fetches many memory docs by id in one call — e.g. hydrating full bodies for a batch of search() hits. Missing ids are simply absent from the result, not errors. */
  async bulkGet(ids: string[]): Promise<MemoryDoc[]> {
    const docs = await Promise.all(ids.map((id) => this.get(id)));
    return docs.filter((doc): doc is MemoryDoc => doc !== null);
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

  /**
   * Fuzzy key lookup for a partial/drifted key, comparing keys with all punctuation stripped so
   * `RMXS15` and `RMXS-15` are treated as the same candidate. Ranked: exact stripped match first,
   * then stripped-prefix, then stripped-substring; alphabetical tiebreak within each tier.
   */
  suggestKeys(partial: string, limit = 5): Array<{ key: string; docCount: number }> {
    const strippedPartial = stripKey(partial);
    if (!strippedPartial) return [];
    const rows = this.db
      .prepare(`SELECT key, COUNT(*) as doc_count FROM memory_docs GROUP BY key`)
      .all() as Array<{ key: string; doc_count: number }>;
    return rows
      .map((r) => ({ key: r.key, docCount: r.doc_count, stripped: stripKey(r.key) }))
      .filter((r) => r.stripped.includes(strippedPartial))
      .sort((a, b) => {
        const aExact = a.stripped === strippedPartial ? 0 : 1;
        const bExact = b.stripped === strippedPartial ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aPrefix = a.stripped.startsWith(strippedPartial) ? 0 : 1;
        const bPrefix = b.stripped.startsWith(strippedPartial) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.key.localeCompare(b.key);
      })
      .slice(0, limit)
      .map(({ key, docCount }) => ({ key, docCount }));
  }

  async create(input: {
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
  }): Promise<MemoryDoc> {
    const normalizedKey = normalizeKey(input.key);
    const targetFolder = this.resolveFolder(input.folder);
    let id = `${slugify(normalizedKey)}-${slugify(input.description)}-${randomUUID().slice(0, 8)}`;
    // folderfoo's POST /save/:filename silently strips every character
    // outside [0-9a-zA-Z_] from the final filename segment (hyphens
    // included) - a remote-bound id must not contain characters folderfoo
    // will drop, or the name mem-bucket thinks the file is called
    // permanently diverges from what folderfoo actually stored it as the
    // moment it's written, breaking every future get/update for that doc
    // with a 404 (confirmed: this is exactly what happened before this
    // fix). Stripped ONLY for remote-bound docs - local-only folders keep
    // the more readable hyphenated id unchanged.
    if (this.remoteFor(targetFolder.name)) id = id.replace(/-/g, '');
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
    // Remote write happens BEFORE upsertFile, live/synchronous per the settled design (no local
    // staging) — if folderfoo rejects the write, this throws and the mirror is never indexed as
    // if the doc were successfully saved. Reads the just-written mirror file back so folderfoo
    // gets writeMarkdownFile's own formatting verbatim, not a hand-reconstructed string.
    const remote = this.remoteFor(targetFolder.name);
    if (remote && this.credentialsBaseDir) {
      try {
        // Confirms the remote folder still exists before writing — folderfoo's own save endpoint
        // would otherwise silently recreate a deleted folder rather than failing (see
        // assertRemoteFolderExists's doc comment).
        await assertRemoteFolderExists(remote.server, this.credentialsBaseDir, remote.tenantId, remote.folderPath, targetFolder.name);
        const relPath = path.relative(remote.mirrorDir, filePath).replace(/\.md$/, '');
        const dir = joinRemoteFolderPath(remote.folderPath, path.dirname(relPath));
        const name = path.basename(relPath);
        const fileContents = fs.readFileSync(filePath, 'utf-8');
        await writeRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dir, name, fileContents);
      } catch (err) {
        // Remote push failed after the local mirror file was already written — remove the orphaned
        // local file synchronously rather than leaving it for the next poll tick's
        // reconcileDeletions to eventually clean up, so a failed create leaves zero trace immediately.
        fs.unlinkSync(filePath);
        throw err;
      }
    }
    upsertFile(this.db, this.syncSpec, filePath);
    return { ...fm, body: input.body, paused: false };
  }

  /**
   * Creates many memory docs in one call — each entry is the same shape as
   * create()'s input. Returns per-key results (with the id filled in on
   * success) so one bad entry doesn't abort the rest of the batch.
   */
  async bulkCreate(
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
  ): Promise<Array<{ key: string; ok: boolean; id?: string; error?: string }>> {
    const results = [];
    for (const entry of entries) {
      try {
        const doc = await this.create(entry);
        results.push({ key: entry.key, ok: true, id: doc.id });
      } catch (err) {
        results.push({ key: entry.key, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  async update(id: string, frontmatter?: Partial<MemoryFrontmatter>, body?: string, bodyEdits?: BodyEdit[]): Promise<MemoryDoc> {
    const existing = await this.get(id);
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
    const newBody = bodyEdits ? applyBodyEdits(existing.body, bodyEdits).body : (body ?? existing.body);
    writeMarkdownFile(existing.source_path, stripSourcePath(merged), newBody);
    const remote = this.remoteFor(existing.folder);
    if (remote && this.credentialsBaseDir) {
      await assertRemoteFolderExists(remote.server, this.credentialsBaseDir, remote.tenantId, remote.folderPath, existing.folder);
      const relPath = path.relative(remote.mirrorDir, existing.source_path).replace(/\.md$/, '');
      const dir = joinRemoteFolderPath(remote.folderPath, path.dirname(relPath));
      const name = path.basename(relPath);
      const fileContents = fs.readFileSync(existing.source_path, 'utf-8');
      await writeRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dir, name, fileContents);
    }
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
  async bulkUpdate(
    ids: string[],
    changes: {
      add_tags?: string[];
      remove_tags?: string[];
      status?: MemoryStatus;
      related_to?: string | null;
      deprecated?: boolean;
    }
  ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const id of ids) {
      try {
        const existing = await this.get(id);
        if (!existing) throw new Error(`memory doc with id "${id}" not found`);
        let tags = existing.tags;
        if (changes.add_tags?.length) tags = Array.from(new Set([...tags, ...changes.add_tags]));
        if (changes.remove_tags?.length) tags = tags.filter((t) => !changes.remove_tags!.includes(t));
        await this.update(id, {
          tags,
          ...(changes.status !== undefined ? { status: changes.status } : {}),
          ...(changes.related_to !== undefined ? { related_to: changes.related_to } : {}),
          ...(changes.deprecated !== undefined ? { deprecated: changes.deprecated } : {}),
        });
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /**
   * Pauses/resumes memory docs by id — a local-only toggle stored directly in this cache file's
   * `paused` column, never written to the doc's markdown file and never synced by the file
   * watcher (see the comment on memoryColumns in store/sync.ts). Paused docs are hidden from
   * getByKey()/search() by default but remain fetchable via get()/bulkGet(). Because it's
   * local-only, the flag does not follow the doc to another machine's cache or survive the cache
   * file being deleted. Returns per-id results so one bad id doesn't abort the rest of the batch.
   */
  async setPaused(ids: string[], paused: boolean): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const id of ids) {
      try {
        const existing = await this.get(id);
        if (!existing) throw new Error(`memory doc with id "${id}" not found`);
        this.db.prepare(`UPDATE memory_docs SET paused = ? WHERE id = ?`).run(paused ? 1 : 0, id);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`memory doc with id "${id}" not found`);
    // The <id>/ wrapper directory exists solely to hold attachments/ for this doc (memory docs
    // are otherwise flat <id>.md files), so remove the whole wrapper — not just attachments/ —
    // to avoid leaving an orphaned empty <id>/ directory behind. No-op if it never existed.
    fs.rmSync(path.dirname(attachmentsDirFor(existing.source_path, 'memory')), { recursive: true, force: true });
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
  async stripFrontmatter(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`memory doc with id "${id}" not found`);
    writeMarkdownFile(existing.source_path, {}, existing.body);
    upsertFile(this.db, this.syncSpec, existing.source_path);
  }

  /**
   * Deletes many memory docs by id in one call — e.g. cleaning up a batch of
   * abandoned docs found via search(). Returns per-id results so one bad id
   * doesn't abort the rest of the batch.
   */
  async bulkDelete(ids: string[]): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const id of ids) {
      try {
        await this.delete(id);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }
}

function stripSourcePath<T extends { source_path: string; folder: string }>(fm: T): Omit<T, 'source_path' | 'folder'> {
  const { source_path: _sp, folder: _folder, ...rest } = fm;
  return rest;
}
