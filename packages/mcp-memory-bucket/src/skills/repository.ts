import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import matter from 'gray-matter';
import { writeMarkdownFile } from '../store/markdown-file.js';
import { assertValidSkillName } from '../store/skill-name.js';
import { resolveWithinBase } from '../store/safe-path.js';
import { upsertFile, removeFile, scanSingleFolder, unregisterFolder, skillSyncSpec, type TableSyncSpec } from '../store/sync.js';
import { SearchQueryError, sanitizeFtsQuery } from '../store/search.js';
import { applyBodyEdits, type BodyEdit } from '../shared/body-edits.js';
import type { NamedFolder, RemoteFolder } from '../config.js';
import { rebaseFolderPath } from '../config.js';
import type { SkillDoc, SkillFrontmatter, SkillStatus } from '../types.js';
import { readFile as readRemoteFile, writeFile as writeRemoteFile, joinRemoteFolderPath, assertRemoteFolderExists } from '../remote/folderfoo-client.js';
import { isFolderVisible, type IdentityTracker } from '../remote/identity.js';

interface SkillRow {
  id: string;
  description: string;
  owner: string | null;
  status: SkillStatus;
  tags: string; // JSON
  trigger_phrases: string; // JSON
  extends: string | null;
  source_path: string;
  folder: string;
  deprecated: number;
  paused: number;
  created_at: string | null;
  attachments: string | null; // JSON
  body: string;
}

function rowToDoc(row: SkillRow): SkillDoc {
  return {
    name: row.id,
    description: row.description,
    tags: JSON.parse(row.tags),
    trigger_phrases: JSON.parse(row.trigger_phrases),
    metadata: { owner: row.owner, status: row.status, extends: row.extends },
    deprecated: !!row.deprecated,
    paused: !!row.paused,
    created_at: row.created_at ?? undefined,
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
    source_path: row.source_path,
    folder: row.folder,
    body: row.body,
  };
}

export interface SkillListItem {
  name: string;
  description: string;
  owner: string | null;
  status: SkillStatus;
  tags: string[];
  folder: string;
  paused: boolean;
}

export class SkillRepository {
  private syncSpec: TableSyncSpec<SkillFrontmatter>;
  private watcher?: FSWatcher;

  /** `folders[0]` is always the builtin skills dir — never exposed for create()/removal. */
  constructor(
    private db: Database.Database,
    private folders: NamedFolder[],
    private remoteFolders: RemoteFolder[] = [],
    private credentialsBaseDir?: string,
    private identity?: IdentityTracker
  ) {
    this.syncSpec = skillSyncSpec(folders);
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
   * Pushes the just-written SKILL.md at filePath to folderfoo, if targetFolderName resolves to a
   * remote source. No-op for a local folder. See get()'s comment on the folderPath/name split for
   * a skill's directory-per-skill layout.
   *
   * Confirms the remote folder still exists before writing: folderfoo's own save endpoint would
   * otherwise silently recreate a deleted folder rather than failing (see assertRemoteFolderExists's
   * doc comment) — this turns that into a loud, specific RemoteFolderGoneError instead.
   */
  private async pushToRemoteIfNeeded(targetFolderName: string, filePath: string): Promise<void> {
    const remote = this.remoteFor(targetFolderName);
    if (!remote || !this.credentialsBaseDir) return;
    await assertRemoteFolderExists(remote.server, this.credentialsBaseDir, remote.tenantId, remote.folderPath, targetFolderName);
    const skillDirRelPath = joinRemoteFolderPath(remote.folderPath, path.relative(remote.mirrorDir, path.dirname(filePath)));
    const fileContents = fs.readFileSync(filePath, 'utf-8');
    await writeRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, skillDirRelPath, 'SKILL', fileContents);
  }

  /** Attaches the live chokidar watcher so addFolder/removeFolder can mutate it without a restart. */
  setWatcher(watcher: FSWatcher): void {
    this.watcher = watcher;
  }

  /** User-addable folders — excludes the always-present builtin skills dir at folders[0]. */
  listFolders(): NamedFolder[] {
    return this.folders.slice(1);
  }

  /** Full RemoteFolder records (server/tenantId/folderPath/mirrorDir) for every connected remote source — for matching an incoming folderfoo-file-open address back to a configured source. */
  listRemoteFolders(): RemoteFolder[] {
    return [...this.remoteFolders];
  }

  /** Same as listFolders(), but tags each entry with whether it's a remote (folderfoo) source — for the web UI's folder list, e.g. to render remote folders in a distinct color. Excludes remote folders that don't match the current login (see identity.ts). */
  listFoldersWithRemoteInfo(): Array<NamedFolder & { remote: boolean }> {
    return this.listFolders()
      .filter((f) => this.isFolderNameVisible(f.name))
      .map((f) => ({ ...f, remote: !!this.remoteFor(f.name) }));
  }

  private resolveFolder(folderName: string | undefined): NamedFolder {
    const userFolders = this.listFolders();
    if (folderName) {
      const found = userFolders.find((f) => f.name === folderName);
      if (!found) {
        throw new Error(`unknown skill folder "${folderName}" — valid folders: ${userFolders.map((f) => f.name).join(', ') || '(none configured)'}`);
      }
      return found;
    }
    if (userFolders.length === 1) return userFolders[0]!;
    if (userFolders.length === 0) {
      throw new Error('no skill folder configured — add one first (see bucket_open_ui)');
    }
    throw new Error(`multiple skill folders configured — specify folder: one of ${userFolders.map((f) => f.name).join(', ')}`);
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
      throw new Error(`a skill folder named "${remote.name}" already exists`);
    }
    fs.mkdirSync(remote.mirrorDir, { recursive: true });
    this.remoteFolders.push(remote);
    this.addFolder({ name: remote.name, path: remote.mirrorDir });
  }

  /** Registers a new folder: appends it, scans it once, and starts watching it live. */
  addFolder(folder: NamedFolder): void {
    if (this.folders.some((f) => f.name === folder.name)) {
      throw new Error(`a skill folder named "${folder.name}" already exists`);
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
    if (idx <= 0) throw new Error(`skill folder "${name}" not found or is not removable`); // index 0 is builtin
    const [removed] = this.folders.splice(idx, 1);
    this.watcher?.unwatch(removed!.path);
    unregisterFolder(this.db, 'skills', name);
    const remoteIdx = this.remoteFolders.findIndex((f) => f.name === name);
    if (remoteIdx !== -1) {
      const [removedRemote] = this.remoteFolders.splice(remoteIdx, 1);
      fs.rmSync(removedRemote!.mirrorDir, { recursive: true, force: true });
    }
  }

  /**
   * Repoints a registered remote source's `folderPath` in place after it was renamed/moved on
   * folderfoo — e.g. the embedded File Open dialog's `folderfoo-folder-changed` event. Unlike
   * removeFolder, this keeps the source's local mirror directory, cached rows, and content
   * completely untouched: only WHERE ON FOLDERFOO future polls/writes target changes, matching
   * folderfoo's own rename (same content, new path) rather than a delete+reconnect.
   *
   * `renamedFolderPath`/`newFolderPath` describe the folder that was actually renamed on
   * folderfoo, which may be an ancestor of this source's own `folderPath` (folderfoo's rename is
   * recursive) — see config.ts's rebaseFolderPath for the shared prefix-rewrite logic. No-op if
   * this source's folderPath isn't the renamed folder or nested under it.
   */
  updateRemoteFolderPath(name: string, renamedFolderPath: string, newFolderPath: string): void {
    const remote = this.remoteFolders.find((f) => f.name === name);
    if (!remote) return;
    remote.folderPath = rebaseFolderPath(remote.folderPath, renamedFolderPath, newFolderPath);
  }

  /** `includePaused` defaults to false: paused skills are hidden from discovery (see setPaused). */
  list(query?: string, folder?: string, opts: { includePaused?: boolean } = {}): SkillListItem[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (folder) {
      conditions.push('folder = ?');
      params.push(folder);
    }
    if (!opts.includePaused) {
      conditions.push('paused = 0');
    }
    const hidden = this.hiddenFolderNames();
    if (hidden.length > 0) {
      conditions.push(`folder NOT IN (${hidden.map(() => '?').join(', ')})`);
      params.push(...hidden);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT id, description, owner, status, tags, trigger_phrases, folder, paused FROM skills${where}`)
      .all(...params) as Array<Pick<SkillRow, 'id' | 'description' | 'owner' | 'status' | 'tags' | 'trigger_phrases' | 'folder' | 'paused'>>;

    const needle = query?.trim().toLowerCase();
    const items = rows.map((r) => ({
      name: r.id,
      description: r.description,
      owner: r.owner,
      status: r.status,
      tags: JSON.parse(r.tags) as string[],
      triggerPhrases: JSON.parse(r.trigger_phrases) as string[],
      folder: r.folder,
      paused: !!r.paused,
    }));

    const filtered = needle
      ? items.filter(
          (item) =>
            item.description.toLowerCase().includes(needle) ||
            item.tags.some((t) => t.toLowerCase().includes(needle)) ||
            item.triggerPhrases.some((t) => t.toLowerCase().includes(needle))
        )
      : items;

    return filtered.map(({ triggerPhrases: _tp, ...rest }) => rest);
  }

  /**
   * Full-text search over skill description/body/tags via FTS5 — `query` is
   * raw FTS5 MATCH syntax (AND/OR/NOT, "phrases", prefix*). Ranked by bm25.
   * Optional metadata filters (folder/status/owner/tag) apply before limit/offset,
   * so pagination stays correct even when filtering narrows the FTS hit set.
   */
  search(
    query: string,
    opts: {
      folder?: string;
      status?: SkillStatus;
      owner?: string;
      tag?: string;
      limit?: number;
      offset?: number;
      /** Defaults to false: paused skills are hidden from discovery (see setPaused). */
      includePaused?: boolean;
    } = {}
  ): Array<{ name: string; description: string; folder: string; snippet: string; score: number }> {
    const { folder, status, owner, tag, limit = 20, offset = 0, includePaused = false } = opts;
    const conditions: string[] = [];
    const params: unknown[] = [sanitizeFtsQuery(query)];
    if (folder) {
      conditions.push('s.folder = ?');
      params.push(folder);
    }
    if (status) {
      conditions.push('s.status = ?');
      params.push(status);
    }
    if (owner) {
      conditions.push('s.owner = ?');
      params.push(owner);
    }
    if (tag) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value = ?)');
      params.push(tag);
    }
    if (!includePaused) {
      conditions.push('s.paused = 0');
    }
    const hidden = this.hiddenFolderNames();
    if (hidden.length > 0) {
      conditions.push(`s.folder NOT IN (${hidden.map(() => '?').join(', ')})`);
      params.push(...hidden);
    }
    params.push(limit, offset);

    try {
      const rows = this.db
        .prepare(
          `SELECT s.id AS name, s.description, s.folder,
                  snippet(search_index, 3, '<<', '>>', '…', 20) AS snippet,
                  -bm25(search_index) AS score
           FROM search_index
           JOIN skills s ON s.id = search_index.ref_id AND s.folder = search_index.ref_folder
           WHERE search_index.ref_table = 'skills' AND search_index MATCH ? ${conditions.map((c) => `AND ${c}`).join(' ')}
           ORDER BY bm25(search_index)
           LIMIT ? OFFSET ?`
        )
        .all(...params) as Array<{ name: string; description: string; folder: string; snippet: string; score: number }>;
      return rows;
    } catch (err) {
      throw new SearchQueryError(query, err);
    }
  }

  /**
   * Names are unique PER FOLDER, not globally (skills table key is (folder, id)) — so a bare `name`
   * can match more than one row across configured folders. When `folder` is omitted and the name is
   * unambiguous (unique across every configured folder, or only one folder configured), resolution
   * works exactly as before. When it's genuinely ambiguous, this throws a disambiguation error
   * listing the matching folders rather than silently picking one — per the settled multi-folder
   * design (see FOLDERFOO-MULTI-FOLDER-SUPPORT's "Name collisions across sources" section).
   */
  private resolveRow(name: string, folder?: string): SkillRow | null {
    if (folder) {
      return (this.db.prepare(`SELECT * FROM skills WHERE folder = ? AND id = ?`).get(folder, name) as SkillRow | undefined) ?? null;
    }
    const rows = this.db.prepare(`SELECT * FROM skills WHERE id = ?`).all(name) as SkillRow[];
    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0]!;
    const folders = rows.map((r) => r.folder).join(', ');
    throw new Error(`skill "${name}" exists in multiple folders (${folders}) — specify folder to disambiguate`);
  }

  /**
   * For a skill in a LOCAL folder, returns the cached row unchanged (identical behavior to before
   * remote sources existed). For a skill in a REMOTE folder, the cached `body` is only ever a
   * poll-interval-stale mirror snapshot — per the settled design, `get` always fetches the current
   * body live from folderfoo instead of trusting it.
   */
  async get(name: string, folder?: string): Promise<SkillDoc | null> {
    const row = this.resolveRow(name, folder);
    if (!row) return null;
    const doc = rowToDoc(row);
    if (!this.isFolderNameVisible(doc.folder)) return null;
    const remote = this.remoteFor(doc.folder);
    if (!remote || !this.credentialsBaseDir) return doc;
    // A skill's SKILL.md sits INSIDE a directory named after the skill
    // (<mirrorDir>/[subfolder/]<name>/SKILL.md, per agentskills.io), unlike
    // a memory doc's flat <id>.md - so the skill's own directory is part of
    // the folderPath sent to folderfoo, and "SKILL" (no extension - the
    // server stores opaque names) is the file name within it.
    const skillDirRelPath = joinRemoteFolderPath(remote.folderPath, path.relative(remote.mirrorDir, path.dirname(doc.source_path)));
    // readRemoteFile returns the RAW file bytes folderfoo stored (whole
    // SKILL.md, frontmatter included) - must parse it the same way a local
    // file read would, or the next update() nests a fresh frontmatter
    // block around this already-frontmattered blob (see memory/
    // repository.ts's get() for the confirmed real-world corruption this
    // caused).
    const liveBody = matter(await readRemoteFile(remote.server, this.credentialsBaseDir, remote.tenantId, skillDirRelPath, 'SKILL')).content.trim();
    return { ...doc, body: liveBody };
  }

  /** Fetches many skills by name in one call — e.g. hydrating full bodies for a batch of search() hits. Missing names are simply absent from the result, not errors. */
  async bulkGet(names: string[]): Promise<SkillDoc[]> {
    const docs = await Promise.all(names.map((name) => this.get(name)));
    return docs.filter((doc): doc is SkillDoc => doc !== null);
  }

  /**
   * Creates <folder>/[subfolder/]<name>/SKILL.md — folder-per-skill, per the
   * agentskills.io spec (`name` must equal the containing folder's name).
   * `folder` selects which configured skill folder to write into; required only
   * when more than one user folder is configured. Name uniqueness is checked only
   * WITHIN that target folder — the same name existing in a different configured
   * folder is not a collision (skills key on (folder, id), not on id alone).
   */
  async create(
    frontmatter: { name: string; description: string; license?: string; compatibility?: string; tags?: string[]; trigger_phrases?: string[] } & {
      owner?: string | null;
      status?: SkillStatus;
      extends?: string | null;
    },
    body: string,
    subfolder?: string,
    folder?: string
  ): Promise<SkillDoc> {
    assertValidSkillName(frontmatter.name);
    const targetFolder = this.resolveFolder(folder);
    if (await this.get(frontmatter.name, targetFolder.name)) {
      throw new Error(`skill with name "${frontmatter.name}" already exists in folder "${targetFolder.name}"`);
    }
    const skillDir = resolveWithinBase(targetFolder.path, subfolder, frontmatter.name);
    if (fs.existsSync(skillDir)) {
      throw new Error(`skill directory already exists at ${skillDir}`);
    }
    fs.mkdirSync(skillDir, { recursive: true });
    const filePath = path.join(skillDir, 'SKILL.md');

    const fm: SkillFrontmatter = {
      name: frontmatter.name,
      description: frontmatter.description,
      license: frontmatter.license,
      compatibility: frontmatter.compatibility,
      tags: frontmatter.tags ?? [],
      trigger_phrases: frontmatter.trigger_phrases ?? [],
      metadata: {
        owner: frontmatter.owner ?? null,
        status: frontmatter.status ?? 'unreviewed',
        extends: frontmatter.extends ?? null,
      },
      deprecated: false,
      created_at: new Date().toISOString(),
      source_path: filePath,
      folder: targetFolder.name,
    };
    writeMarkdownFile(filePath, stripSourcePath(fm), body);
    try {
      // Live/synchronous per the settled design — a folderfoo rejection here throws before upsertFile
      // indexes the mirror as if the skill were successfully saved remotely.
      await this.pushToRemoteIfNeeded(targetFolder.name, filePath);
    } catch (err) {
      // Remote push failed after the local mirror was already written — remove the orphaned local
      // dir synchronously rather than leaving it for the next poll tick's reconcileDeletions to
      // eventually clean up, so a failed create leaves zero trace immediately.
      fs.rmSync(skillDir, { recursive: true, force: true });
      throw err;
    }
    upsertFile(this.db, this.syncSpec, filePath);
    return { ...fm, body, paused: false };
  }

  /**
   * Creates many skills in one call — each entry is the same shape as create()'s
   * args. Returns per-name results so one bad entry (duplicate name, invalid
   * name, existing directory) doesn't abort the rest of the batch.
   */
  async bulkCreate(
    entries: Array<{
      frontmatter: { name: string; description: string; license?: string; compatibility?: string; tags?: string[]; trigger_phrases?: string[] } & {
        owner?: string | null;
        status?: SkillStatus;
        extends?: string | null;
      };
      body: string;
      subfolder?: string;
      folder?: string;
    }>
  ): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const entry of entries) {
      try {
        await this.create(entry.frontmatter, entry.body, entry.subfolder, entry.folder);
        results.push({ name: entry.frontmatter.name, ok: true });
      } catch (err) {
        results.push({ name: entry.frontmatter.name, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /** Name of the always-present, non-removable builtin folder (folders[0]) — never user content, never deprecatable. */
  private isBuiltin(doc: Pick<SkillDoc, 'folder'>): boolean {
    return doc.folder === this.folders[0]?.name;
  }

  async update(
    name: string,
    frontmatter?: Partial<Omit<SkillFrontmatter, 'name' | 'metadata'>> & {
      owner?: string | null;
      status?: SkillStatus;
      extends?: string | null;
    },
    body?: string,
    bodyEdits?: BodyEdit[],
    folder?: string
  ): Promise<SkillDoc> {
    const existing = await this.get(name, folder);
    if (!existing) throw new Error(`skill with name "${name}" not found`);
    // `paused` is local-cache-only and must never reach writeMarkdownFile — split it off of
    // `existing` before spreading the rest into the frontmatter that gets written to disk.
    const { paused: existingPaused, ...existingForFile } = existing;

    // Builtin skills (e.g. memory-bucket-authoring) are the server's own always-present
    // documentation, not user content — deprecating them would hide guidance every session needs.
    const deprecated = this.isBuiltin(existing) ? existing.deprecated : frontmatter?.deprecated;

    const merged: SkillFrontmatter = {
      ...existingForFile,
      ...frontmatter,
      deprecated,
      name: existing.name, // name is immutable post-creation (it's also the folder name)
      metadata: {
        ...existing.metadata,
        owner: frontmatter?.owner !== undefined ? frontmatter.owner : existing.metadata.owner,
        status: frontmatter?.status ?? existing.metadata.status,
        extends: frontmatter?.extends !== undefined ? frontmatter.extends : existing.metadata.extends,
      },
    };
    const newBody = bodyEdits ? applyBodyEdits(existing.body, bodyEdits).body : (body ?? existing.body);
    writeMarkdownFile(existing.source_path, stripSourcePath(merged), newBody);
    await this.pushToRemoteIfNeeded(existing.folder, existing.source_path);
    upsertFile(this.db, this.syncSpec, existing.source_path);
    return { ...merged, body: newBody, paused: existingPaused };
  }

  /**
   * Renames a skill: moves <sourceDir>/[subfolder/]<oldName>/ to .../<newName>/ (keeping any
   * scripts/references/assets alongside SKILL.md) and updates the `name` frontmatter field to match.
   *
   * Remote-folder note: pushes the renamed skill's content to folderfoo at its NEW path (a plain
   * write, via pushToRemoteIfNeeded), but does not delete the OLD path on folderfoo — a true
   * remote rename would need a folderfoo folder-rename call scoped to one skill's directory, which
   * is out of scope for this pass (the settled design's write scope covers create/update/
   * attachment writes, not rename). Renaming a remote-sourced skill currently leaves a stale copy
   * under the old name on folderfoo; flagged here rather than silently incomplete.
   */
  async rename(name: string, newName: string, folder?: string): Promise<SkillDoc> {
    assertValidSkillName(newName);
    const existing = await this.get(name, folder);
    if (!existing) throw new Error(`skill with name "${name}" not found`);
    if (newName === name) return existing;
    // The rename target's collision check is scoped to the SAME folder the existing skill lives
    // in — a rename never moves a skill to a different folder, so only that folder's names matter.
    if (await this.get(newName, existing.folder)) {
      throw new Error(`skill with name "${newName}" already exists in folder "${existing.folder}"`);
    }

    const oldDir = path.dirname(existing.source_path);
    const newDir = path.join(path.dirname(oldDir), newName);
    if (fs.existsSync(newDir)) {
      throw new Error(`skill directory already exists at ${newDir}`);
    }
    fs.renameSync(oldDir, newDir);
    const newFilePath = path.join(newDir, 'SKILL.md');

    // Rename changes the skill's id, so it becomes a fresh cache row — paused (local-only,
    // keyed by id) does not carry over, same as it wouldn't survive deleting the cache file.
    const { paused: _existingPaused, ...existingForFile } = existing;
    const merged: SkillFrontmatter = { ...existingForFile, name: newName };
    writeMarkdownFile(newFilePath, stripSourcePath(merged), existing.body);
    await this.pushToRemoteIfNeeded(existing.folder, newFilePath);
    removeFile(this.db, 'skills', existing.source_path);
    upsertFile(this.db, this.syncSpec, newFilePath);
    return { ...merged, body: existing.body, paused: false };
  }

  /**
   * Applies the same frontmatter change to many skills at once — e.g. add/remove
   * a tag across a batch found via search(), or flip status for a group. Tags in
   * `add_tags`/`remove_tags` are merged/subtracted per-skill; other fields (owner,
   * status, extends) overwrite uniformly when provided. Never touches body.
   * Returns per-name results so partial failures (e.g. an unknown name) don't
   * abort the rest of the batch.
   */
  async bulkUpdate(
    names: string[],
    changes: {
      add_tags?: string[];
      remove_tags?: string[];
      owner?: string | null;
      status?: SkillStatus;
      extends?: string | null;
      deprecated?: boolean;
    }
  ): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const name of names) {
      try {
        const existing = await this.get(name);
        if (!existing) throw new Error(`skill with name "${name}" not found`);
        const builtin = this.isBuiltin(existing);
        let tags = existing.tags;
        if (changes.add_tags?.length) tags = Array.from(new Set([...tags, ...changes.add_tags]));
        if (changes.remove_tags?.length) tags = tags.filter((t) => !changes.remove_tags!.includes(t));
        await this.update(name, {
          tags,
          owner: changes.owner,
          status: changes.status,
          extends: changes.extends,
          ...(changes.deprecated !== undefined && !builtin ? { deprecated: changes.deprecated } : {}),
        });
        results.push({ name, ok: true });
      } catch (err) {
        results.push({ name, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /**
   * Pauses/resumes skills by name — a local-only toggle stored directly in this cache file's
   * `paused` column, never written to SKILL.md and never synced by the file watcher (see the
   * comment on skillColumns in store/sync.ts). Paused skills are hidden from list()/search() by
   * default but remain fetchable via get()/bulkGet(). Because it's local-only, the flag does not
   * follow the skill to another machine's cache, survive a rename, or survive the cache file
   * being deleted. Returns per-name results so one bad name doesn't abort the rest of the batch.
   */
  async setPaused(names: string[], paused: boolean): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const name of names) {
      try {
        const existing = await this.get(name);
        if (!existing) throw new Error(`skill with name "${name}" not found`);
        if (this.isBuiltin(existing)) throw new Error(`skill "${name}" is builtin and cannot be paused`);
        // Scoped to the resolved row's own folder — a bare `WHERE id = ?` would flip paused on
        // EVERY folder's same-named skill at once now that names are only unique per folder.
        this.db.prepare(`UPDATE skills SET paused = ? WHERE folder = ? AND id = ?`).run(paused ? 1 : 0, existing.folder, name);
        results.push({ name, ok: true });
      } catch (err) {
        results.push({ name, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /**
   * Renames many skills at once — each entry is a {name, new_name} pair, same
   * semantics as rename(). Returns per-entry results so one bad pair (unknown
   * name, name collision) doesn't abort the rest of the batch.
   */
  async bulkRename(entries: Array<{ name: string; new_name: string }>): Promise<Array<{ name: string; new_name: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const { name, new_name } of entries) {
      try {
        await this.rename(name, new_name);
        results.push({ name, new_name, ok: true });
      } catch (err) {
        results.push({ name, new_name, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /** Removes the whole skill directory, including any scripts/references/assets alongside SKILL.md. Remote-folder note: does not delete the corresponding content on folderfoo — deletion isn't in the settled design's remote write scope (create/update/attachment writes only), same gap flagged on rename(). */
  async delete(name: string, folder?: string): Promise<void> {
    const existing = await this.get(name, folder);
    if (!existing) throw new Error(`skill with name "${name}" not found`);
    if (this.isBuiltin(existing)) throw new Error(`skill "${name}" is builtin and cannot be deleted`);
    const skillDir = path.dirname(existing.source_path);
    fs.rmSync(skillDir, { recursive: true, force: true });
    removeFile(this.db, 'skills', existing.source_path);
  }

  /**
   * Deletes many skills by name in one call — e.g. cleaning up a batch found
   * via search()/list(). Returns per-name results so one bad name doesn't
   * abort the rest of the batch.
   */
  async bulkDelete(names: string[]): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const name of names) {
      try {
        await this.delete(name);
        results.push({ name, ok: true });
      } catch (err) {
        results.push({ name, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }
}

function stripSourcePath<T extends { source_path: string; folder: string }>(fm: T): Omit<T, 'source_path' | 'folder'> {
  const { source_path: _sp, folder: _folder, ...rest } = fm;
  return rest;
}
