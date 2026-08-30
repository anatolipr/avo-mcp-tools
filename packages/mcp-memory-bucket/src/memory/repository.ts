import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import matter from 'gray-matter';
import { writeMarkdownFile, formatMarkdownFile } from '../store/markdown-file.js';
import { resolveWithinBase } from '../store/safe-path.js';
import { uniqueFilename } from '../attachments/storage.js';
import { upsertFile, removeFile, scanSingleFolder, unregisterFolder, memorySyncSpec, type TableSyncSpec } from '../store/sync.js';
import { SearchQueryError, sanitizeFtsQuery } from '../store/search.js';
import { applyBodyEdits, type BodyEdit } from '../shared/body-edits.js';
import { attachmentsDirFor } from '../attachments/storage.js';
import type { NamedFolder, RemoteFolder } from '../config.js';
import { rebaseFolderPath } from '../config.js';
import { normalizeKey } from '../types.js';
import { readFile as readRemoteFile, writeFile as writeRemoteFile, writeBinaryFile as writeRemoteBinaryFile, renameFile as renameRemoteFile, trashFile as trashRemoteFile, joinRemoteFolderPath, assertRemoteFolderExists, FolderfooRequestError } from '../remote/folderfoo-client.js';
import { isFolderVisible, type IdentityTracker } from '../remote/identity.js';
import { writeRemoteThenLocal } from '../remote/write-order.js';
import type { MemoryDoc, MemoryDocType, MemoryFrontmatter, MemoryKeyType, MemoryStatus } from '../types.js';

/** Uppercases and strips everything but letters/digits — used to compare keys that differ only in
 * punctuation/whitespace formatting (e.g. `RMXS-15` and `RMXS15` strip to the same `RMXS15`). */
export function stripKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

interface MemoryRow {
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

  /**
   * Pushes one attachment's raw binary content to folderfoo, if `folderName` resolves to a remote
   * source — the attachment counterpart to create()/update(). Pushed under the attachment's own
   * actual filename. No-op for a local folder. Takes `data` directly rather than reading it off
   * `attachmentFilePath` — called by AttachmentRepository BEFORE the local attachment file is
   * written, per the "remote is the source of truth" ordering (remote/write-order.ts), so there is
   * nothing on disk yet to read back.
   */
  async pushAttachmentIfNeeded(folderName: string, attachmentFilePath: string, data: Buffer, mimeType: string): Promise<void> {
    const remote = this.remoteFor(folderName);
    if (!remote || !this.credentialsBaseDir) return;
    await assertRemoteFolderExists(remote.server, this.credentialsBaseDir, remote.tenantId, remote.folderPath, folderName);
    const dirRelPath = joinRemoteFolderPath(remote.folderPath, path.relative(remote.mirrorDir, path.dirname(attachmentFilePath)));
    await writeRemoteBinaryFile(remote.server, this.credentialsBaseDir, remote.tenantId, dirRelPath, path.basename(attachmentFilePath), data, mimeType);
  }

  /**
   * Trashes one attachment's remote copy on folderfoo, if `folderName` resolves to a remote source
   * — the attachment counterpart to delete()'s own trashRemoteFile call. No-op for a local folder.
   * Without this, AttachmentRepository.remove() only deleted the local file + frontmatter entry,
   * leaving the remote copy behind under <stem>/attachments/ forever (folderfoo has no reconciler
   * that notices an attachment dropped OUT of a doc's declared list — only pullFile/
   * reconcileDeletions notice a whole file disappearing from folderfoo's own listing, the opposite
   * direction). Same soft-delete rationale as delete(): recoverable via folderfoo's own trash UI if
   * the removal was a mistake.
   */
  async trashAttachmentIfNeeded(folderName: string, attachmentFilePath: string): Promise<void> {
    const remote = this.remoteFor(folderName);
    if (!remote || !this.credentialsBaseDir) return;
    await assertRemoteFolderExists(remote.server, this.credentialsBaseDir, remote.tenantId, remote.folderPath, folderName);
    const dirRelPath = joinRemoteFolderPath(remote.folderPath, path.relative(remote.mirrorDir, path.dirname(attachmentFilePath)));
    await trashRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dirRelPath, path.basename(attachmentFilePath));
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

  /**
   * Splits an absolute source_path (the web UI's doc identifier — see client/detail-panel.ts) back
   * into the (folder, filename) pair get()/update()/etc. take, by matching it against each
   * configured folder's own path. Returns undefined if it doesn't fall under any configured folder.
   */
  splitSourcePath(sourcePath: string): { folder: string; filename: string } | undefined {
    const resolved = path.resolve(sourcePath);
    let best: NamedFolder | undefined;
    for (const folder of this.folders) {
      const folderPath = path.resolve(folder.path);
      if (resolved === folderPath || resolved.startsWith(folderPath + path.sep)) {
        if (!best || folderPath.length > path.resolve(best.path).length) best = folder;
      }
    }
    if (!best) return undefined;
    return { folder: best.name, filename: path.relative(path.resolve(best.path), resolved) };
  }

  /** Normalizes an agent-supplied filename to always end in `.md`, matching how docs are stored on disk. */
  private static normalizeFilename(filename: string): string {
    return filename.endsWith('.md') ? filename : `${filename}.md`;
  }

  /**
   * Resolves a (folder, filename) pair — the doc's real identity — to its absolute on-disk path,
   * without requiring the file to already exist (used by both lookups and create/rename to compute
   * a target path). Does NOT search subfolders: callers needing a doc that might live in a
   * subfolder must already know its relative filename (e.g. "sub/DOC.md").
   */
  private sourcePathFor(folderName: string | undefined, filename: string): string {
    const targetFolder = this.resolveFolder(folderName);
    return resolveWithinBase(targetFolder.path, undefined, MemoryRepository.normalizeFilename(filename));
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
   * Validates a caller-supplied `folder` filter (getByKey/getByFilenameContains/search) against the
   * configured folder list, throwing the same "unknown memory folder" error resolveFolder() uses for
   * writes. Without this, an unrecognized folder name (typo, stale name from a since-removed folder,
   * or an outright made-up one) silently matched zero rows via `folder = ?` in SQL instead of erroring
   * — indistinguishable from "folder is real but has no matches".
   */
  private assertKnownFolder(folderName: string): void {
    if (!this.folders.some((f) => f.name === folderName)) {
      throw new Error(`unknown memory folder "${folderName}" — valid folders: ${this.folders.map((f) => f.name).join(', ') || '(none configured)'}`);
    }
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
   * `folder`, when passed, restricts to docs in that one folder — a doc's real identity is its
   * (folder, filename) pair, but a human-facing `key` can legitimately repeat in different folders
   * (and even within one folder, across several files), so any caller treating "same key+description"
   * as "the same doc" (e.g. relocate's already-relocated check) needs this to avoid a false match
   * against an unrelated doc that just happens to share a key/description in a different folder.
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
      this.assertKnownFolder(opts.folder);
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
   * Case-insensitive substring match against each doc's own filename — the fallback getByKey()
   * (and memory_get) fall back to when no doc's `key` matches, e.g. a bare ticket ref like
   * "RMXS-13" that only appears in a filename ("RMXS-13-Fix-for-language.md") because the doc's
   * key is something else, drifted, or was never set. Returns every match, same shape as
   * getByKey() — a filename fragment matching several docs is not an error, same as a key with
   * several docs isn't.
   */
  getByFilenameContains(fragment: string, docType?: MemoryDocType, opts: { includePaused?: boolean; folder?: string } = {}): MemoryDoc[] {
    const conditions = ['LOWER(source_path) LIKE ?'];
    // Cheap prefilter (SQLite has no basename function to match precisely against just the
    // filename in SQL) — narrows to plausible candidates, then rowToDoc + a JS basename check
    // below excludes any false positive where the fragment only appeared in a parent directory
    // name (e.g. a folder literally named "rmxs-13"), not the filename itself.
    const params: unknown[] = [`%${fragment.toLowerCase()}%`];
    if (docType) {
      conditions.push('doc_type = ?');
      params.push(docType);
    }
    if (opts.folder) {
      this.assertKnownFolder(opts.folder);
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
    const fragmentLower = fragment.toLowerCase();
    return rows.map(rowToDoc).filter((doc) => path.basename(doc.source_path).toLowerCase().includes(fragmentLower));
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
  ): Array<{ filename: string; key: string; description: string; doc_type: MemoryDocType; folder: string; snippet: string; score: number }> {
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
      this.assertKnownFolder(folder);
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
          `SELECT m.source_path, m.key, m.description, m.doc_type, m.folder,
                  snippet(search_index, 3, '<<', '>>', '…', 20) AS snippet,
                  -bm25(search_index) AS score
           FROM search_index
           JOIN memory_docs m ON m.source_path = search_index.ref_id
           WHERE search_index.ref_table = 'memory_docs' AND search_index MATCH ? ${conditions.map((c) => `AND ${c}`).join(' ')}
           ORDER BY bm25(search_index)
           LIMIT ? OFFSET ?`
        )
        .all(...params) as Array<{
        source_path: string;
        key: string;
        description: string;
        doc_type: MemoryDocType;
        folder: string;
        snippet: string;
        score: number;
      }>;
      return rows.map(({ source_path, ...rest }) => ({ ...rest, filename: path.basename(source_path) }));
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
  async get(folder: string | undefined, filename: string): Promise<MemoryDoc | null> {
    const sourcePath = this.sourcePathFor(folder, filename);
    const row = this.db.prepare(`SELECT * FROM memory_docs WHERE source_path = ?`).get(sourcePath) as MemoryRow | undefined;
    if (!row) return null;
    const doc = rowToDoc(row);
    if (!this.isFolderNameVisible(doc.folder)) return null;
    const remote = this.remoteFor(doc.folder);
    if (!remote || !this.credentialsBaseDir) return doc;
    // No .md stripping — the remote copy keeps the exact same filename as the local mirror (see
    // create()'s comment on why the extension is preserved).
    const relPath = path.relative(remote.mirrorDir, doc.source_path);
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
    let raw: string;
    try {
      raw = await readRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dir, name);
    } catch (err) {
      // Also try the LEGACY extensionless remote name — a doc pushed before the
      // extension-preserving fix still sits on folderfoo under its bare id (no ".md") and always
      // will, until it's renamed/re-saved (same tolerance reconcileDeletions already applies via
      // remoteFilename.toLocal/toRemote — see remote-sync.ts). Only retry on a 404, never for a
      // FolderfooAuthError or any other failure, which must surface as-is.
      if (!(err instanceof FolderfooRequestError) || err.status !== 404 || !name.endsWith('.md')) throw err;
      raw = await readRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dir, name.slice(0, -3));
    }
    const liveBody = matter(raw).content.trim();
    return { ...doc, body: liveBody };
  }

  /** Fetches many memory docs by (folder, filename) in one call — e.g. hydrating full bodies for a batch of search() hits. Missing docs are simply absent from the result, not errors. */
  async bulkGet(refs: Array<{ folder?: string; filename: string }>): Promise<MemoryDoc[]> {
    const docs = await Promise.all(refs.map((ref) => this.get(ref.folder, ref.filename)));
    return docs.filter((doc): doc is MemoryDoc => doc !== null);
  }

  listKeys(keyPrefix?: string): Array<{ key: string; docCount: number }> {
    const conditions = ['paused = 0'];
    const params: unknown[] = [];
    const hidden = this.hiddenFolderNames();
    if (hidden.length > 0) {
      conditions.push(`folder NOT IN (${hidden.map(() => '?').join(', ')})`);
      params.push(...hidden);
    }
    const rows = this.db
      .prepare(`SELECT key, COUNT(*) as doc_count FROM memory_docs WHERE ${conditions.join(' AND ')} GROUP BY key ORDER BY key`)
      .all(...params) as Array<{ key: string; doc_count: number }>;
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
    filename: string;
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
    const targetDir = resolveWithinBase(targetFolder.path, input.subfolder, '.');
    // Collision-avoidance is a pure disk STAT (fs.existsSync), not a write — safe to run before
    // any write, remote or local, regardless of ordering.
    const filename = uniqueFilename(targetDir, MemoryRepository.normalizeFilename(input.filename));
    const filePath = path.join(targetDir, filename);

    const fm: MemoryFrontmatter = {
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
    const fileContents = formatMarkdownFile(stripSourcePath(fm), input.body);

    // Remote is the source of truth for a remote folder: the remote write happens FIRST, entirely
    // in memory (fileContents is already fully formatted, no disk read needed) — if folderfoo
    // rejects it, nothing local changes at all, so a remote outage can't leave the local mirror
    // and folderfoo disagreeing (see remote/write-order.ts). Only on remote success does the local
    // mirror get created.
    const remote = this.remoteFor(targetFolder.name);
    await writeRemoteThenLocal(
      async () => {
        if (!remote || !this.credentialsBaseDir) return;
        // Confirms the remote folder still exists before writing — folderfoo's own save endpoint
        // would otherwise silently recreate a deleted folder rather than failing (see
        // assertRemoteFolderExists's doc comment).
        await assertRemoteFolderExists(remote.server, this.credentialsBaseDir, remote.tenantId, remote.folderPath, targetFolder.name);
        // The remote filename keeps the SAME name (including .md) as the local mirror file — no
        // extension stripping. Historically this stripped ".md" to match the old opaque id (which
        // never carried an extension), which meant a memory doc's OWN remote file was named
        // differently than its local mirror name, and differently than its attachments' remote
        // directory (attachmentsDirFor names that directory after the local filename stem). That
        // asymmetry is exactly what caused attaching a file to a remote-backed doc to collide
        // (ENOTDIR: folderfoo tried to mkdir a directory with the same name as the doc's own
        // extensionless file). Keeping the extension keeps local and remote names identical, so
        // there's nothing left to collide.
        const relPath = path.relative(remote.mirrorDir, filePath);
        const dir = joinRemoteFolderPath(remote.folderPath, path.dirname(relPath));
        const name = path.basename(relPath);
        await writeRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dir, name, fileContents);
      },
      () => {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(filePath, fileContents, 'utf-8');
      }
    );
    upsertFile(this.db, this.syncSpec, filePath);
    return { ...fm, body: input.body, paused: false };
  }

  /**
   * Creates many memory docs in one call — each entry is the same shape as
   * create()'s input. Returns per-key results (with the new filename on
   * success) so one bad entry doesn't abort the rest of the batch.
   */
  async bulkCreate(
    entries: Array<{
      filename: string;
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
  ): Promise<Array<{ key: string; ok: boolean; filename?: string; error?: string }>> {
    const results = [];
    for (const entry of entries) {
      try {
        const doc = await this.create(entry);
        results.push({ key: entry.key, ok: true, filename: path.basename(doc.source_path) });
      } catch (err) {
        results.push({ key: entry.key, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  async update(folder: string | undefined, filename: string, frontmatter?: Partial<MemoryFrontmatter>, body?: string, bodyEdits?: BodyEdit[]): Promise<MemoryDoc> {
    const existing = await this.get(folder, filename);
    if (!existing) throw new Error(`memory doc "${filename}" not found`);
    // `paused` is local-cache-only and must never reach writeMarkdownFile — split it off of
    // `existing` before spreading the rest into the frontmatter that gets written to disk.
    const { paused: existingPaused, ...existingForFile } = existing;

    const merged: MemoryFrontmatter = {
      ...existingForFile,
      ...frontmatter,
      key: frontmatter?.key ? normalizeKey(frontmatter.key) : existing.key,
    };
    const newBody = bodyEdits ? applyBodyEdits(existing.body, bodyEdits).body : (body ?? existing.body);
    const fileContents = formatMarkdownFile(stripSourcePath(merged), newBody);

    // Remote-first — see create()'s comment on why (remote/write-order.ts).
    const remote = this.remoteFor(existing.folder);
    await writeRemoteThenLocal(
      async () => {
        if (!remote || !this.credentialsBaseDir) return;
        await assertRemoteFolderExists(remote.server, this.credentialsBaseDir, remote.tenantId, remote.folderPath, existing.folder);
        // No .md stripping — see create()'s comment.
        const relPath = path.relative(remote.mirrorDir, existing.source_path);
        const dir = joinRemoteFolderPath(remote.folderPath, path.dirname(relPath));
        const name = path.basename(relPath);
        await writeRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dir, name, fileContents);
      },
      () => fs.writeFileSync(existing.source_path, fileContents, 'utf-8')
    );
    upsertFile(this.db, this.syncSpec, existing.source_path);
    return { ...merged, body: newBody, paused: existingPaused };
  }

  /**
   * Applies the same frontmatter change to many memory docs at once — e.g.
   * add/remove a tag across a batch found via search(), or flip status for a
   * group (e.g. mark a set of docs "shipped"). Tags in `add_tags`/`remove_tags`
   * are merged/subtracted per-doc; `status`/`related_to` overwrite uniformly
   * when provided. Never touches body. Returns per-ref results so partial
   * failures (e.g. an unknown doc) don't abort the rest of the batch.
   */
  async bulkUpdate(
    refs: Array<{ folder?: string; filename: string }>,
    changes: {
      add_tags?: string[];
      remove_tags?: string[];
      status?: MemoryStatus;
      related_to?: string | null;
      deprecated?: boolean;
    }
  ): Promise<Array<{ filename: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const ref of refs) {
      try {
        const existing = await this.get(ref.folder, ref.filename);
        if (!existing) throw new Error(`memory doc "${ref.filename}" not found`);
        let tags = existing.tags;
        if (changes.add_tags?.length) tags = Array.from(new Set([...tags, ...changes.add_tags]));
        if (changes.remove_tags?.length) tags = tags.filter((t) => !changes.remove_tags!.includes(t));
        await this.update(ref.folder, ref.filename, {
          tags,
          ...(changes.status !== undefined ? { status: changes.status } : {}),
          ...(changes.related_to !== undefined ? { related_to: changes.related_to } : {}),
          ...(changes.deprecated !== undefined ? { deprecated: changes.deprecated } : {}),
        });
        results.push({ filename: ref.filename, ok: true });
      } catch (err) {
        results.push({ filename: ref.filename, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /**
   * Pauses/resumes memory docs — a local-only toggle stored directly in this cache file's
   * `paused` column, never written to the doc's markdown file and never synced by the file
   * watcher (see the comment on memoryColumns in store/sync.ts). Paused docs are hidden from
   * getByKey()/search() by default but remain fetchable via get()/bulkGet(). Because it's
   * local-only, the flag does not follow the doc to another machine's cache or survive the cache
   * file being deleted. Returns per-ref results so one bad doc doesn't abort the rest of the batch.
   */
  async setPaused(refs: Array<{ folder?: string; filename: string }>, paused: boolean): Promise<Array<{ filename: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const ref of refs) {
      try {
        const existing = await this.get(ref.folder, ref.filename);
        if (!existing) throw new Error(`memory doc "${ref.filename}" not found`);
        this.db.prepare(`UPDATE memory_docs SET paused = ? WHERE source_path = ?`).run(paused ? 1 : 0, existing.source_path);
        results.push({ filename: ref.filename, ok: true });
      } catch (err) {
        results.push({ filename: ref.filename, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  async delete(folder: string | undefined, filename: string): Promise<void> {
    const existing = await this.get(folder, filename);
    if (!existing) throw new Error(`memory doc "${filename}" not found`);
    // Archive the remote copy FIRST, before touching anything local — otherwise a deleted-locally-
    // but-still-present-remotely doc gets silently pulled right back in on the next poll (exactly
    // the "deleted doc reappears" bug this fixes). Soft-delete (trash), not a hard remote delete —
    // folderfoo has no permanent single-file delete on /data/:filename, and trash matches this
    // tool's existing move-not-copy conventions elsewhere while still leaving the remote side
    // recoverable if the delete was a mistake.
    const remote = this.remoteFor(existing.folder);
    if (remote && this.credentialsBaseDir) {
      await assertRemoteFolderExists(remote.server, this.credentialsBaseDir, remote.tenantId, remote.folderPath, existing.folder);
      const relPath = path.relative(remote.mirrorDir, existing.source_path);
      const dir = joinRemoteFolderPath(remote.folderPath, path.dirname(relPath));
      const name = path.basename(relPath);
      await trashRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dir, name);
    }
    // The sibling wrapper directory exists solely to hold attachments/ for this doc (memory docs
    // are otherwise flat files), so remove the whole wrapper — not just attachments/ — to avoid
    // leaving an orphaned empty directory behind. No-op if it never existed.
    fs.rmSync(path.dirname(attachmentsDirFor(existing.source_path, 'memory')), { recursive: true, force: true });
    fs.unlinkSync(existing.source_path);
    removeFile(this.db, 'memory_docs', existing.source_path);
  }

  /**
   * Renames a memory doc's file in place (frontmatter/body unchanged) — moves
   * <folder>/[subfolder/]<filename> to .../<newFilename>, along with its attachments directory
   * (if any) so existing attachments aren't orphaned. Rejects on a collision with an existing file
   * at the new name, rather than silently auto-suffixing — an explicit rename target should be
   * honored or rejected, never silently altered.
   *
   * Remote-folder note: uses folderfoo's real POST /rename/:filename endpoint — a true in-place
   * rename (handles the raw+.meta.json sidecar pair together), not a write-under-the-new-name.
   * No stale copy is left behind under the old name. Remote-first — see create()'s comment.
   */
  async rename(folder: string | undefined, filename: string, newFilename: string): Promise<MemoryDoc> {
    const existing = await this.get(folder, filename);
    if (!existing) throw new Error(`memory doc "${filename}" not found`);
    const normalizedNew = MemoryRepository.normalizeFilename(newFilename);
    const newPath = path.join(path.dirname(existing.source_path), normalizedNew);
    if (newPath === existing.source_path) return existing;
    if (fs.existsSync(newPath)) {
      throw new Error(`a memory doc already exists at "${normalizedNew}" in this folder`);
    }

    const oldAttachmentsWrapper = path.dirname(attachmentsDirFor(existing.source_path, 'memory'));
    const newAttachmentsWrapper = path.dirname(attachmentsDirFor(newPath, 'memory'));

    const merged: MemoryFrontmatter = { ...existing, source_path: newPath };
    const remote = this.remoteFor(existing.folder);
    await writeRemoteThenLocal(
      async () => {
        if (!remote || !this.credentialsBaseDir) return;
        await assertRemoteFolderExists(remote.server, this.credentialsBaseDir, remote.tenantId, remote.folderPath, existing.folder);
        const oldRelPath = path.relative(remote.mirrorDir, existing.source_path);
        const dir = joinRemoteFolderPath(remote.folderPath, path.dirname(oldRelPath));
        const oldName = path.basename(oldRelPath);
        const newName = path.basename(newPath);
        try {
          await renameRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dir, oldName, newName);
        } catch (err) {
          // Same legacy-extensionless fallback as get() above: a doc pushed before the
          // extension-preserving fix still sits on folderfoo under its bare id (no ".md"), so
          // renaming by the .md-suffixed name 404s even though the doc reads back fine via get()'s
          // own fallback. Retry once against the bare name — only on a 404, never for any other
          // failure, which must surface as-is.
          if (!(err instanceof FolderfooRequestError) || err.status !== 404 || !oldName.endsWith('.md')) throw err;
          await renameRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, dir, oldName.slice(0, -3), newName);
        }
      },
      () => {
        fs.renameSync(existing.source_path, newPath);
        if (fs.existsSync(oldAttachmentsWrapper)) {
          fs.renameSync(oldAttachmentsWrapper, newAttachmentsWrapper);
        }
      }
    );

    removeFile(this.db, 'memory_docs', existing.source_path);
    upsertFile(this.db, this.syncSpec, newPath);
    return { ...merged, body: existing.body, paused: false };
  }

  /**
   * Strips the doc's frontmatter entirely, leaving a bare markdown file with just the body — the
   * inverse of memory_create, for turning a managed memory doc back into a plain dropped-in file.
   * The file stays at the same path, but loses its `key` (so it drops out of key-based lookup) —
   * the upsertFile call below immediately re-derives a fresh one from the filename via
   * deriveFrontmatter's fallback.
   */
  async stripFrontmatter(folder: string | undefined, filename: string): Promise<void> {
    const existing = await this.get(folder, filename);
    if (!existing) throw new Error(`memory doc "${filename}" not found`);
    writeMarkdownFile(existing.source_path, {}, existing.body);
    upsertFile(this.db, this.syncSpec, existing.source_path);
  }

  /**
   * Deletes many memory docs in one call — e.g. cleaning up a batch of
   * abandoned docs found via search(). Returns per-ref results so one bad doc
   * doesn't abort the rest of the batch.
   */
  async bulkDelete(refs: Array<{ folder?: string; filename: string }>): Promise<Array<{ filename: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const ref of refs) {
      try {
        await this.delete(ref.folder, ref.filename);
        results.push({ filename: ref.filename, ok: true });
      } catch (err) {
        results.push({ filename: ref.filename, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }
}

function stripSourcePath<T extends { source_path: string; folder: string }>(fm: T): Omit<T, 'source_path' | 'folder'> {
  const { source_path: _sp, folder: _folder, ...rest } = fm;
  return rest;
}
