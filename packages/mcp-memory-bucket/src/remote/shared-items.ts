import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  getSharedWithMe,
  getChangedSince,
  getLastChanged,
  readFile,
  readBinaryFile,
  fetchPublicLink,
  fetchPublicFolderFile,
  leaveShare,
  joinRemoteFolderPath,
  FolderfooAuthError,
  FolderfooRequestError,
  type SharedWithMeEntry,
} from './folderfoo-client.js';
import { toMirrorRelativeDir } from './remote-sync.js';
import { upsertFile, removeFile, walkMarkdownFiles, type TableSyncSpec } from '../store/sync.js';
import { sanitizeFolderName, type RemoteFolder } from '../config.js';
import type { SkillFrontmatter, MemoryFrontmatter } from '../types.js';

/**
 * Item-level shares (memory docs/skills shared directly with this user, not a whole connected
 * folder — see config.ts's RemoteFolder for that separate mechanism) live in their own mirror
 * directory, since a shared item has no connected-folder home of its own and may come from any
 * number of different owners. Nested under {server}/{tenantId} the same way mirrorDirFor nests
 * remote folders under {mode}_{username}, so items from two different folderfoo deployments/tenants
 * never collide on disk.
 *
 * Every item gets its own <origin_id>/ directory under that (its "item root"). Two shapes:
 *  - item_type 'file': one shared file — a memory doc (plus its <stem>/attachments/, which a
 *    memory-kind share covers on folderfoo's side) or a legacy skill shared as its SKILL file.
 *    mirror_path is the doc file inside the item root.
 *  - item_type 'folder': a shared folder mirrored whole — one skill with its siblings and
 *    attachments, or (through a public folder link) a folder of docs. mirror_path IS the item root,
 *    and every doc found under it is indexed.
 */
export function sharedItemsMirrorRoot(baseDir: string): string {
  return path.join(baseDir, '.memory-bucket-shared-items');
}

export function sharedItemsMirrorDir(baseDir: string, server: string, tenantId: string): string {
  const serverSegment = sanitizeFolderName(server.replace(/^https?:\/\//, ''));
  return path.join(sharedItemsMirrorRoot(baseDir), serverSegment, sanitizeFolderName(tenantId));
}

/**
 * The `folder` a shared item's cache row is filed under. A shared item lives outside every
 * configured source directory, so without this every one of them landed in folder '' — where two
 * shared skills with the same name collide on the (folder, id) key and the second is never indexed,
 * and where nothing could tell a shared row from an ordinary one. The prefix is also what the
 * repositories key their write guard on (see isSharedFolderName).
 */
const SHARED_FOLDER_PREFIX = 'shared-by-';

export function sharedFolderName(owner: string): string {
  return `${SHARED_FOLDER_PREFIX}${sanitizeFolderName(owner) || 'unknown'}`;
}

export function isSharedFolderName(folderName: string | undefined): boolean {
  return !!folderName && folderName.startsWith(SHARED_FOLDER_PREFIX);
}

/** Thrown by a repository write against someone else's shared item this login may not edit. */
export function sharedItemReadOnlyError(name: string): Error {
  return new Error(
    `"${name}" is shared with you read-only here — ask its owner for editor access, copy it into your own folder with bucket_fork_shared_item ("Fork to mine" in the web UI), or drop it with bucket_leave_shared_item`
  );
}

export type ItemType = 'file' | 'folder';

interface SharedItemRow {
  origin_id: string;
  owner: string;
  server: string;
  tenant_id: string;
  kind: 'memory' | 'skill';
  role: 'member' | 'editor';
  item_type: ItemType;
  remote_path: string;
  mirror_path: string;
  last_seen_modified_at: string | null;
  status: 'active' | 'revoked';
  added_at: string;
  username: string;
  public_token: string | null;
}

type Specs = { skill: TableSyncSpec<SkillFrontmatter>; memory: TableSyncSpec<MemoryFrontmatter> };

// origin_id becomes a directory name under the mirror root (and that directory is removed
// recursively on revoke), so it must be exactly the uuid folderfoo mints — never a path fragment.
const ORIGIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A row belongs to `username` when it was granted to that login, or isn't login-scoped at all (public link / legacy row). */
function isVisibleTo(row: Pick<SharedItemRow, 'username'>, username: string | null): boolean {
  return row.username === '' || row.username === username;
}

/** The item's own <origin_id>/ directory — see sharedItemsMirrorRoot. */
function itemRoot(row: Pick<SharedItemRow, 'item_type' | 'mirror_path'>): string {
  return row.item_type === 'folder' ? row.mirror_path : path.dirname(row.mirror_path);
}

const tableFor = (kind: 'memory' | 'skill') => (kind === 'skill' ? 'skills' : 'memory_docs');

/** Cache rows currently filed from under an item's root. */
function indexedPaths(db: Database.Database, row: Pick<SharedItemRow, 'kind' | 'item_type' | 'mirror_path'>): string[] {
  const root = itemRoot(row);
  const rows = db.prepare(`SELECT source_path FROM ${tableFor(row.kind)} WHERE substr(source_path, 1, ?) = ?`).all(root.length + 1, root + path.sep) as Array<{
    source_path: string;
  }>;
  return rows.map((r) => r.source_path);
}

/** Every doc file the item's mirror holds — the one file for a file item, every matching doc for a folder item. */
function mirrorDocs(specs: Specs, row: Pick<SharedItemRow, 'kind' | 'item_type' | 'mirror_path'>): string[] {
  if (row.item_type === 'file') return fs.existsSync(row.mirror_path) ? [row.mirror_path] : [];
  const spec = row.kind === 'skill' ? specs.skill : specs.memory;
  return [...walkMarkdownFiles(row.mirror_path)].filter((file) => spec.matchesFile(file));
}

function indexMirror(db: Database.Database, specs: Specs, row: Pick<SharedItemRow, 'kind' | 'item_type' | 'owner' | 'mirror_path'>): string[] {
  const folder = sharedFolderName(row.owner);
  const table = tableFor(row.kind);
  const docs = mirrorDocs(specs, row);
  for (const stale of indexedPaths(db, row)) if (!docs.includes(stale)) removeFile(db, table, stale);
  for (const doc of docs) {
    // upsertFile skips a file whose mtime it has already seen, so a row filed under a different
    // folder (e.g. '' from before shared items had their own) would otherwise keep it forever.
    const existing = db.prepare(`SELECT folder FROM ${table} WHERE source_path = ?`).get(doc) as { folder: string } | undefined;
    if (existing && existing.folder !== folder) removeFile(db, table, doc);
    // Branched because upsertFile<T> is generic over TFrontmatter and a union spec fits neither signature.
    if (row.kind === 'skill') upsertFile(db, specs.skill, doc, folder);
    else upsertFile(db, specs.memory, doc, folder);
  }
  return docs;
}

function unindexMirror(db: Database.Database, row: Pick<SharedItemRow, 'kind' | 'item_type' | 'mirror_path'>): void {
  for (const doc of indexedPaths(db, row)) removeFile(db, tableFor(row.kind), doc);
}

function removeMirror(db: Database.Database, baseDir: string, row: Pick<SharedItemRow, 'kind' | 'item_type' | 'mirror_path'>): void {
  unindexMirror(db, row);
  const dir = path.resolve(itemRoot(row));
  const root = path.resolve(sharedItemsMirrorRoot(baseDir));
  if (dir.startsWith(root + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

/** folderfoo's `path` field for a file is relative to the owner's root — everything but the last segment is its containing folder path. */
function dirname(remotePath: string): string {
  const idx = remotePath.lastIndexOf('/');
  return idx === -1 ? '' : remotePath.slice(0, idx);
}

function basename(remotePath: string): string {
  return remotePath.slice(remotePath.lastIndexOf('/') + 1);
}

/** A skill's SKILL file is stored remotely as "SKILL" and locally as "SKILL.md"; every other name is literal. */
function localName(kind: 'memory' | 'skill', remoteName: string): string {
  return kind === 'skill' && remoteName === 'SKILL' ? 'SKILL.md' : remoteName;
}

/** The local filename a shared memory doc/skill FILE mirrors to — a legacy extensionless memory doc still needs ".md" to be addressable. */
function localDocFilename(kind: 'memory' | 'skill', remoteName: string): string {
  if (kind === 'skill') return 'SKILL.md';
  return remoteName.endsWith('.md') ? remoteName : `${remoteName}.md`;
}

interface TreeFile {
  /** Path relative to the item root, '/'-separated. */
  rel: string;
  read: () => Promise<Buffer | string>;
}

/** Makes `root` hold exactly `files`: writes each one and deletes anything else found under it. */
async function writeTree(root: string, files: TreeFile[]): Promise<void> {
  const wanted = new Set<string>();
  for (const file of files) {
    const target = path.resolve(root, ...file.rel.split('/'));
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`refusing shared file path outside its item: ${file.rel}`);
    const content = await file.read();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    wanted.add(target);
  }
  (function prune(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        prune(full);
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } else if (!wanted.has(path.resolve(full))) {
        fs.rmSync(full, { force: true });
      }
    }
  })(root);
}

/** A folderfoo listing that 403s/404s (no attachments directory, or not shared) is simply empty. */
async function listOrEmpty(list: () => Promise<Array<{ name: string; folderPath: string }>>): Promise<Array<{ name: string; folderPath: string }>> {
  try {
    return await list();
  } catch (err) {
    if (err instanceof FolderfooRequestError && (err.status === 403 || err.status === 404)) return [];
    throw err;
  }
}

/**
 * Pulls an item's whole mirror from folderfoo and returns the change signature to store in
 * last_seen_modified_at (null where the caller supplies its own — a login file's modifiedAt).
 */
async function pullItem(baseDir: string, row: SharedItemRow): Promise<string | null> {
  const root = itemRoot(row);
  const { server, tenant_id: tenantId, owner, kind } = row;

  if (row.public_token) {
    const token = row.public_token;
    const view = await fetchPublicLink(server, token);
    if (row.item_type === 'file') {
      const content = typeof view.content === 'string' ? view.content : JSON.stringify(view.content, null, 2);
      await writeTree(root, [{ rel: path.basename(row.mirror_path), read: async () => content }]);
      return null;
    }
    const files = view.files ?? [];
    await writeTree(
      root,
      files.map((f) => {
        const remoteRel = f.folderPath ? `${f.folderPath}/${f.name}` : f.name;
        return { rel: f.folderPath ? `${f.folderPath}/${localName(kind, f.name)}` : localName(kind, f.name), read: () => fetchPublicFolderFile(server, token, remoteRel) };
      })
    );
    return publicFolderSignature(files);
  }

  if (row.item_type === 'file') {
    const remoteDir = dirname(row.remote_path);
    const remoteName = basename(row.remote_path);
    const docFile = path.basename(row.mirror_path);
    const files: TreeFile[] = [{ rel: docFile, read: () => readFile(server, baseDir, tenantId, remoteDir, remoteName, owner) }];
    if (kind === 'memory') {
      // A memory-kind share also covers the doc's <stem>/attachments/ on folderfoo.
      const stem = docFile.slice(0, -'.md'.length);
      const attachmentsDir = joinRemoteFolderPath(remoteDir, `${stem}/attachments`);
      for (const f of await listOrEmpty(() => getChangedSince(server, baseDir, tenantId, attachmentsDir, 0, owner))) {
        const rel = toMirrorRelativeDir(attachmentsDir, f.folderPath);
        files.push({
          rel: `${stem}/attachments/${rel ? `${rel}/` : ''}${f.name}`,
          read: () => readBinaryFile(server, baseDir, tenantId, f.folderPath, f.name, owner),
        });
      }
    }
    await writeTree(root, files);
    return null;
  }

  const lastChanged = await getLastChanged(server, baseDir, tenantId, row.remote_path, owner);
  const listing = await getChangedSince(server, baseDir, tenantId, row.remote_path, 0, owner);
  await writeTree(
    root,
    listing.map((f) => {
      const rel = toMirrorRelativeDir(row.remote_path, f.folderPath);
      return { rel: `${rel ? `${rel}/` : ''}${localName(kind, f.name)}`, read: () => readBinaryFile(server, baseDir, tenantId, f.folderPath, f.name, owner) };
    })
  );
  return String(lastChanged);
}

function publicFolderSignature(files: Array<{ name: string; folderPath: string; mtime: number }>): string {
  return JSON.stringify(files.map((f) => `${f.folderPath}/${f.name}@${f.mtime}`).sort());
}

/**
 * Whether a folder shared by `owner` is ONE skill (a SKILL file at its root) rather than a folder of
 * skills or docs. A single skill is mirrored as a folder item; anything else is connected as a
 * remote folder source instead (see sharing.ts's acceptShare).
 */
export async function isSingleSkillFolder(server: string, baseDir: string, tenantId: string, owner: string, folderPath: string): Promise<boolean> {
  const listing = await getChangedSince(server, baseDir, tenantId, folderPath, 0, owner);
  return listing.some((f) => f.folderPath === folderPath && f.name === 'SKILL');
}

/**
 * Registers a share into shared_items and pulls its content immediately. Called for an accepted
 * share/public link (the explicit act of accepting) and by refreshSharedItems for a direct share it
 * just discovered. Idempotent on origin_id: re-adding an already-tracked share (or one previously
 * revoked and re-shared) just refreshes it.
 *
 * `publicToken` marks a public-link item: it has no `shares` row on folderfoo, so its content can
 * only be read back through the link itself (no login), never the owner-addressed read.
 * `paused` files the item hidden from agent-facing list/search until the user unpauses it — used
 * for a share nobody on this side explicitly accepted.
 */
export async function addSharedItem(
  db: Database.Database,
  baseDir: string,
  skillSpec: TableSyncSpec<SkillFrontmatter>,
  memorySpec: TableSyncSpec<MemoryFrontmatter>,
  entry: {
    owner: string;
    server: string;
    tenantId: string;
    path: string;
    originId: string;
    kind: 'memory' | 'skill';
    itemType?: ItemType;
    role?: 'member' | 'editor';
    username?: string | null;
    publicToken?: string;
    modifiedAt?: string;
    paused?: boolean;
  }
): Promise<void> {
  if (!ORIGIN_ID_PATTERN.test(entry.originId)) throw new Error('invalid originId');
  const itemType = entry.itemType ?? 'file';
  const remoteName = basename(entry.path);
  if (!remoteName || remoteName === '.' || remoteName === '..') throw new Error('invalid shared item path');
  const root = path.join(sharedItemsMirrorDir(baseDir, entry.server, entry.tenantId), entry.originId);
  const row: SharedItemRow = {
    origin_id: entry.originId,
    owner: entry.owner,
    server: entry.server,
    tenant_id: entry.tenantId,
    kind: entry.kind,
    role: entry.publicToken ? 'member' : (entry.role ?? 'member'),
    item_type: itemType,
    remote_path: entry.path,
    mirror_path: itemType === 'folder' ? root : path.join(root, localDocFilename(entry.kind, remoteName)),
    last_seen_modified_at: entry.modifiedAt ?? null,
    status: 'active',
    added_at: new Date().toISOString(),
    username: entry.publicToken ? '' : (entry.username ?? ''),
    public_token: entry.publicToken ?? null,
  };
  const signature = await pullItem(baseDir, row);
  if (signature !== null) row.last_seen_modified_at = signature;

  db.prepare(
    `INSERT INTO shared_items (origin_id, owner, server, tenant_id, kind, role, item_type, remote_path, mirror_path, last_seen_modified_at, status, added_at, username, public_token)
     VALUES (@origin_id, @owner, @server, @tenant_id, @kind, @role, @item_type, @remote_path, @mirror_path, @last_seen_modified_at, 'active', @added_at, @username, @public_token)
     ON CONFLICT(origin_id) DO UPDATE SET
       owner = excluded.owner, kind = excluded.kind, role = excluded.role, item_type = excluded.item_type, remote_path = excluded.remote_path,
       mirror_path = excluded.mirror_path, last_seen_modified_at = excluded.last_seen_modified_at, status = 'active',
       username = excluded.username, public_token = excluded.public_token`
  ).run(row);

  const docs = indexMirror(db, { skill: skillSpec, memory: memorySpec }, row);
  if (entry.paused) {
    const pause = db.prepare(`UPDATE ${tableFor(entry.kind)} SET paused = 1 WHERE source_path = ?`);
    for (const doc of docs) pause.run(doc);
  }
}

export interface RefreshSummary {
  added: number;
  updated: number;
  revoked: number;
  unchanged: number;
  /** One message per server or item that could not be refreshed — an empty summary with errors is a failed refresh, not "nothing new". */
  errors: string[];
  /** True when folderfoo rejected the stored login; the caller owns telling IdentityTracker. */
  authExpired: boolean;
}

/**
 * Brings shared_items in line with folderfoo for the CURRENT login — called on demand (the web UI's
 * refresh button, opening its "Shared with me" panel, or bucket_list_shared_items with refresh).
 * Still no poller/timer.
 *
 * Login-granted items: one GET /shared-with-me per server+tenant in `servers` (plus any already
 * tracked), diffed by origin_id against the rows granted to `username`. Rows granted to a
 * different login are never touched — the other login's shares are simply absent from this
 * response, which is not a revocation.
 *  - live but not tracked → a direct share nobody here accepted; added PAUSED, so content someone
 *    else chose to push is not agent-visible until the user unpauses it. Covers files tagged with a
 *    kind, and folders tagged 'skill' that hold one skill (not ones already connected as a source,
 *    per `isConnected`).
 *  - tracked but not live → revoked (or deleted); evicted from the cache and mirror, row kept as
 *    'revoked' for the UI's dismissible "no longer shared with you" entry.
 *  - changed (a file's modifiedAt, a folder's last-changed watermark), or the mirror is gone →
 *    refetched and reindexed.
 *  - otherwise only the bookkeeping columns (role, remote_path) are brought up to date.
 * The mirror path is origin_id-based, so a rename never needs a file move.
 *
 * Public-link items have no /shared-with-me entry; each is re-read through its own link.
 */
export async function refreshSharedItems(
  db: Database.Database,
  baseDir: string,
  skillSpec: TableSyncSpec<SkillFrontmatter>,
  memorySpec: TableSyncSpec<MemoryFrontmatter>,
  servers: Array<{ server: string; tenantId: string }>,
  username: string | null,
  isConnected: (server: string, tenantId: string, owner: string, folderPath: string) => boolean = () => false
): Promise<RefreshSummary> {
  const summary: RefreshSummary = { added: 0, updated: 0, revoked: 0, unchanged: 0, errors: [], authExpired: false };
  const specs: Specs = { skill: skillSpec, memory: memorySpec };
  const noteError = (what: string, err: unknown) => {
    if (err instanceof FolderfooAuthError) summary.authExpired = true;
    summary.errors.push(`${what}: ${(err as Error).message}`);
    console.error(`[memory-bucket] ${what}:`, err);
  };
  const revoke = (row: SharedItemRow) => {
    removeMirror(db, baseDir, row);
    db.prepare(`UPDATE shared_items SET status = 'revoked' WHERE origin_id = ?`).run(row.origin_id);
    summary.revoked++;
  };

  const active = db.prepare(`SELECT * FROM shared_items WHERE status = 'active'`).all() as SharedItemRow[];

  for (const row of active.filter((r) => r.public_token)) {
    try {
      const before = row.item_type === 'file' && fs.existsSync(row.mirror_path) ? fs.readFileSync(row.mirror_path, 'utf-8') : null;
      if (row.item_type === 'folder') {
        const view = await fetchPublicLink(row.server, row.public_token!);
        if (fs.existsSync(row.mirror_path) && publicFolderSignature(view.files ?? []) === row.last_seen_modified_at) {
          summary.unchanged++;
          continue;
        }
      }
      const signature = await pullItem(baseDir, row);
      if (row.item_type === 'file' && before !== null && fs.readFileSync(row.mirror_path, 'utf-8') === before) {
        summary.unchanged++;
        continue;
      }
      if (signature !== null) db.prepare(`UPDATE shared_items SET last_seen_modified_at = ? WHERE origin_id = ?`).run(signature, row.origin_id);
      indexMirror(db, specs, row);
      summary.updated++;
    } catch (err) {
      // 404 is folderfoo's answer for a revoked, expired, or deleted link — anything else is a
      // transient failure that must not be mistaken for a revocation.
      if (err instanceof FolderfooRequestError && err.status === 404) revoke(row);
      else noteError(`failed to refresh public item ${row.origin_id}`, err);
    }
  }

  if (username === null) return summary;

  const byServerTenant = new Map<string, { server: string; tenantId: string; rows: SharedItemRow[] }>();
  const groupFor = (server: string, tenantId: string) => {
    const key = `${server}::${tenantId}`;
    let group = byServerTenant.get(key);
    if (!group) byServerTenant.set(key, (group = { server, tenantId, rows: [] }));
    return group;
  };
  for (const row of active) {
    if (!row.public_token && isVisibleTo(row, username)) groupFor(row.server, row.tenant_id).rows.push(row);
  }
  for (const { server, tenantId } of servers) groupFor(server, tenantId);

  for (const { server, tenantId, rows } of byServerTenant.values()) {
    let live: SharedWithMeEntry[];
    try {
      live = await getSharedWithMe(server, baseDir, tenantId);
    } catch (err) {
      noteError(`failed to refresh shared items from ${server}`, err);
      continue;
    }
    const liveByOrigin = new Map(live.filter((e) => e.originId).map((e) => [e.originId as string, e]));
    const trackedOrigins = new Set(rows.map((row) => row.origin_id));

    for (const row of rows) {
      const liveEntry = liveByOrigin.get(row.origin_id);
      if (!liveEntry) {
        revoke(row);
        continue;
      }
      // folderfoo's third role, 'live', is file-channel publishing — read-only as far as this app goes.
      const role = liveEntry.role === 'editor' ? 'editor' : 'member';
      try {
        const current: SharedItemRow = { ...row, remote_path: liveEntry.name, role };
        let signature = liveEntry.modifiedAt;
        let stale = liveEntry.modifiedAt !== row.last_seen_modified_at;
        if (row.item_type === 'folder') {
          signature = String(await getLastChanged(server, baseDir, tenantId, liveEntry.name, liveEntry.owner));
          stale = signature !== row.last_seen_modified_at;
        }
        if (stale || !fs.existsSync(row.mirror_path)) {
          const pulled = await pullItem(baseDir, current);
          if (row.item_type === 'file') {
            const mtimeDate = new Date(liveEntry.modifiedAt);
            fs.utimesSync(row.mirror_path, mtimeDate, mtimeDate);
          } else if (pulled !== null) {
            signature = pulled;
          }
          indexMirror(db, specs, current);
          summary.updated++;
        } else {
          summary.unchanged++;
        }
        db.prepare(`UPDATE shared_items SET remote_path = ?, last_seen_modified_at = ?, role = ?, username = ? WHERE origin_id = ?`).run(
          liveEntry.name,
          signature,
          role,
          username,
          row.origin_id
        );
      } catch (err) {
        noteError(`failed to refresh shared item ${row.origin_id}`, err);
      }
    }

    // kind-filtered: a plain (non-mcp-memory-bucket) share has kind:null and nothing here knows how
    // to mirror it. A folder is an item only when it holds one skill — see isSingleSkillFolder.
    for (const entry of live) {
      if (!entry.originId || !entry.kind || trackedOrigins.has(entry.originId)) continue;
      try {
        let itemType: ItemType = 'file';
        if (entry.type === 'folder') {
          if (entry.kind !== 'skill' || isConnected(server, tenantId, entry.owner, entry.name)) continue;
          if (!(await isSingleSkillFolder(server, baseDir, tenantId, entry.owner, entry.name))) continue;
          itemType = 'folder';
        }
        await addSharedItem(db, baseDir, skillSpec, memorySpec, {
          owner: entry.owner,
          server,
          tenantId,
          path: entry.name,
          originId: entry.originId,
          kind: entry.kind,
          itemType,
          role: entry.role === 'editor' ? 'editor' : 'member',
          username,
          modifiedAt: entry.type === 'file' ? entry.modifiedAt : undefined,
          paused: true,
        });
        summary.added++;
      } catch (err) {
        noteError(`failed to add newly-discovered shared item ${entry.originId}`, err);
      }
    }
  }

  return summary;
}

/**
 * Makes the skills/memory_docs cache agree with shared_items for the current login: an item the
 * login can see is indexed from its mirror, anything else (another login's item, a revoked one) is
 * evicted. Run at startup, on every login/logout, and after a cache rebuild — the rebuild wipes both
 * tables and rescans only the configured source directories, which never include the shared mirror.
 * A visible item whose mirror is gone is marked for refetch on the next refresh.
 */
export function syncSharedItemsIndex(
  db: Database.Database,
  skillSpec: TableSyncSpec<SkillFrontmatter>,
  memorySpec: TableSyncSpec<MemoryFrontmatter>,
  username: string | null
): void {
  const rows = db.prepare(`SELECT * FROM shared_items`).all() as SharedItemRow[];
  for (const row of rows) {
    try {
      if (row.status !== 'active' || !isVisibleTo(row, username)) {
        unindexMirror(db, row);
      } else if (fs.existsSync(row.mirror_path)) {
        indexMirror(db, { skill: skillSpec, memory: memorySpec }, row);
      } else {
        db.prepare(`UPDATE shared_items SET last_seen_modified_at = NULL WHERE origin_id = ?`).run(row.origin_id);
      }
    } catch (err) {
      console.error(`[memory-bucket] failed to index shared item ${row.origin_id}:`, err);
    }
  }
}

/** Dismisses a revoked row from the "Shared with me" panel — no-ops (does not un-revoke) for a still-active row; use refreshSharedItems to detect revocation in the first place. */
export function dismissRevokedSharedItem(db: Database.Database, originId: string): void {
  db.prepare(`DELETE FROM shared_items WHERE origin_id = ? AND status = 'revoked'`).run(originId);
}

/**
 * Drops a shared item for good: removes this login from the share on folderfoo (a public-link item
 * has no share to leave — the link simply stops being followed), then deletes the local mirror,
 * its index rows, and the shared_items row.
 */
export async function leaveSharedItem(db: Database.Database, baseDir: string, originId: string, username: string | null): Promise<{ left: true } | { error: string }> {
  const row = getSharedItem(db, originId);
  if (!row || !isVisibleTo(row, username)) return { error: `no shared item found with origin_id "${originId}"` };
  if (row.status === 'active' && !row.public_token) {
    await leaveShare(row.server, baseDir, row.tenant_id, row.owner, row.remote_path, row.item_type);
  }
  removeMirror(db, baseDir, row);
  db.prepare(`DELETE FROM shared_items WHERE origin_id = ?`).run(originId);
  return { left: true };
}

export interface SharedItemView extends Omit<SharedItemRow, 'public_token'> {
  /** True for a public-link item. The link's own token is never exposed — it is the credential. */
  public: boolean;
  /**
   * The addressable id of the item's (first) doc — source_path for memory_docs, the skill's
   * frontmatter `name` for skills. null if nothing is indexed (indexing failed, or it's revoked).
   */
  entryId: string | null;
  /** How many docs the item holds — 1 for a file item, any number for a folder item. */
  docCount: number;
  /** The folder its cache rows are filed under (see sharedFolderName) — what skill_get/memory_get take as `folder`. */
  folder: string | null;
  /** A direct share nobody here accepted arrives paused — hidden from agent-facing list/search until unpaused. */
  paused: boolean;
}

/** Single-row lookup by origin_id. */
export function getSharedItem(db: Database.Database, originId: string): SharedItemRow | undefined {
  return db.prepare(`SELECT * FROM shared_items WHERE origin_id = ?`).get(originId) as SharedItemRow | undefined;
}

/**
 * The shared item a "fork to mine" may copy, or the reason it can't — shared by the web route and
 * bucket_fork_shared_item so a revoked item (mirror already evicted) or another login's item fails
 * with a clear message instead of a raw ENOENT from reading the missing mirror.
 */
export function getForkableSharedItem(db: Database.Database, originId: string, username: string | null): SharedItemRow | { error: string } {
  const item = getSharedItem(db, originId);
  if (!item || !isVisibleTo(item, username)) return { error: `no shared item found with origin_id "${originId}"` };
  if (item.status !== 'active') return { error: 'this item is no longer shared with you' };
  if (!fs.existsSync(item.mirror_path)) return { error: 'this shared item has no local copy yet — refresh "Shared with me" first' };
  return item;
}

/** The docs a shared item's mirror holds, for copying it (see sharing.ts's forkSharedItem). */
export function sharedItemDocs(item: SharedItemRow): string[] {
  if (item.item_type === 'file') return [item.mirror_path];
  const match = item.kind === 'skill' ? (f: string) => path.basename(f) === 'SKILL.md' : (f: string) => f.endsWith('.md');
  return [...walkMarkdownFiles(item.mirror_path)].filter(match);
}

export interface SharedWriteTarget {
  server: string;
  tenantId: string;
  owner: string;
  /** Folder on the OWNER's folderfoo the file is written into. */
  folderPath: string;
  /** The file's name there. */
  name: string;
}

/**
 * Where a write to `filePath` — any file inside a shared item's mirror (the doc, a skill sibling, an
 * attachment) — goes on the owner's folderfoo, or why it can't. Only an active, login-granted
 * 'editor' share is writable; a public-link item is always read-only.
 */
export function sharedItemWriteTarget(db: Database.Database, filePath: string, username: string | null): SharedWriteTarget | { error: string } {
  const rows = db.prepare(`SELECT * FROM shared_items WHERE status = 'active' AND public_token IS NULL`).all() as SharedItemRow[];
  const row = rows.find((r) => isVisibleTo(r, username) && (filePath === r.mirror_path || filePath.startsWith(itemRoot(r) + path.sep)));
  if (!row) return { error: 'not part of an item shared with you' };
  if (row.role !== 'editor') return { error: 'shared with you read-only' };
  const base = { server: row.server, tenantId: row.tenant_id, owner: row.owner };
  if (row.item_type === 'file' && filePath === row.mirror_path) {
    return { ...base, folderPath: dirname(row.remote_path), name: basename(row.remote_path) };
  }
  const rel = path.relative(itemRoot(row), filePath).split(path.sep).join('/');
  const relDir = dirname(rel);
  const remoteRoot = row.item_type === 'file' ? dirname(row.remote_path) : row.remote_path;
  const name = basename(rel);
  return { ...base, folderPath: joinRemoteFolderPath(remoteRoot, relDir), name: row.kind === 'skill' && name === 'SKILL.md' ? 'SKILL' : name };
}

export interface ShareTarget {
  server: string;
  tenantId: string;
  /** Path on the caller's own folderfoo, relative to their root. */
  path: string;
  type: 'file' | 'folder';
  kind: 'memory' | 'skill';
}

type RemoteRepos = { skill: { listRemoteFolders(): RemoteFolder[] }; memory: { listRemoteFolders(): RemoteFolder[] } };

/** A connected remote folder the caller may share, or why not. */
function ownRemote(remote: RemoteFolder | undefined): RemoteFolder | { error: string } {
  if (!remote) return { error: 'not connected to a folderfoo remote folder — sharing requires a remote-backed doc' };
  // folderfoo only lets an item's owner share it, and addressing remote.folderPath without the
  // owner would resolve inside the CALLER's own tree.
  if (remote.owner) {
    return { error: `lives in a folder ${remote.owner} shared with you — only ${remote.owner} can share it; fork it into your own folder first` };
  }
  return remote;
}

/**
 * Resolves a table/id doc into what folderfoo shares, or the reason it can't be shared. A memory doc
 * is its own file (its attachments ride along, see folderfoo's hasAccess). A skill is its whole
 * directory — SKILL.md, siblings, and attachments — shared as a folder. Used by the web UI's share
 * routes and the bucket_share_* tools alike (see sharing.ts). `folder` disambiguates a skill name
 * that exists in more than one folder (skill ids are unique per folder only); a memory doc's id is
 * its source_path, already unique.
 */
export function resolveShareTarget(db: Database.Database, repos: RemoteRepos, table: 'skills' | 'memory_docs', id: string, folder?: string): ShareTarget | { error: string } {
  const idCol = table === 'skills' ? 'id' : 'source_path';
  const rows = (
    folder !== undefined && table === 'skills'
      ? db.prepare(`SELECT source_path, folder FROM skills WHERE id = ? AND folder = ?`).all(id, folder)
      : db.prepare(`SELECT source_path, folder FROM ${table} WHERE ${idCol} = ?`).all(id)
  ) as Array<{ source_path: string; folder: string }>;
  // A same-named item someone shared with the caller is never the one meant here — it only
  // counts when it is the sole match, so the error below can say why it can't be shared.
  const own = rows.filter((r) => !isSharedFolderName(r.folder));
  const candidates = own.length > 0 ? own : rows;
  if (candidates.length === 0) return { error: 'not found' };
  if (candidates.length > 1) {
    return { error: `exists in more than one folder (${candidates.map((r) => r.folder).join(', ')}) — specify folder` };
  }
  const row = candidates[0]!;
  if (isSharedFolderName(row.folder)) {
    return { error: 'this item is shared with you, not yours to share — fork it into your own folder first' };
  }
  const repo = table === 'skills' ? repos.skill : repos.memory;
  const remote = ownRemote(repo.listRemoteFolders().find((f) => f.name === row.folder));
  if ('error' in remote) return remote;
  const kind: 'memory' | 'skill' = table === 'skills' ? 'skill' : 'memory';
  if (table === 'skills') {
    const relDir = path.relative(remote.mirrorDir, path.dirname(row.source_path)).split(path.sep).join('/');
    return { server: remote.server, tenantId: remote.tenantId, path: joinRemoteFolderPath(remote.folderPath, relDir), type: 'folder', kind };
  }
  const rel = path.relative(remote.mirrorDir, row.source_path).split(path.sep).join('/');
  return { server: remote.server, tenantId: remote.tenantId, path: joinRemoteFolderPath(remote.folderPath, rel), type: 'file', kind };
}

/** Resolves a whole configured folder (by name) into what folderfoo shares, or why it can't be shared. */
export function resolveFolderShareTarget(repos: RemoteRepos, kind: 'memory' | 'skill', folderName: string): ShareTarget | { error: string } {
  const remote = ownRemote(repos[kind].listRemoteFolders().find((f) => f.name === folderName));
  if ('error' in remote) return remote;
  if (!remote.folderPath) return { error: 'this folder is connected to your folderfoo root, which cannot be shared — connect a subfolder instead' };
  return { server: remote.server, tenantId: remote.tenantId, path: remote.folderPath, type: 'folder', kind };
}

/** Shared items the given login can see (its own, plus public-link items), newest first — never another login's. */
export function listSharedItems(db: Database.Database, username: string | null): SharedItemView[] {
  const rows = (db.prepare(`SELECT * FROM shared_items ORDER BY added_at DESC`).all() as SharedItemRow[]).filter((row) => isVisibleTo(row, username));
  return rows.map(({ public_token, ...row }) => {
    const table = tableFor(row.kind);
    const idCol = row.kind === 'memory' ? 'source_path' : 'id';
    const root = itemRoot(row);
    const found = db
      .prepare(`SELECT ${idCol} AS id, folder, paused FROM ${table} WHERE source_path = ? OR substr(source_path, 1, ?) = ? ORDER BY source_path`)
      .all(row.mirror_path, root.length + 1, root + path.sep) as Array<{ id: string; folder: string; paused: number }>;
    const first = found[0];
    return {
      ...row,
      public: public_token !== null,
      entryId: first?.id ?? null,
      docCount: found.length,
      folder: first?.folder ?? null,
      paused: found.length > 0 && found.every((f) => f.paused === 1),
    };
  });
}
