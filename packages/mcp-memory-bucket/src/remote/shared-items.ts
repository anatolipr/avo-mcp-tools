import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  getSharedWithMe,
  readFile,
  fetchPublicLink,
  joinRemoteFolderPath,
  FolderfooAuthError,
  FolderfooRequestError,
  type SharedWithMeEntry,
} from './folderfoo-client.js';
import { upsertFile, removeFile, type TableSyncSpec } from '../store/sync.js';
import { sanitizeFolderName, type RemoteFolder } from '../config.js';
import type { SkillFrontmatter, MemoryFrontmatter } from '../types.js';

/**
 * Item-level shares (individual memory docs/skills shared directly with this
 * user, not a whole connected folder — see config.ts's RemoteFolder for
 * that separate mechanism) live in their own mirror directory, since a
 * shared item has no connected-folder home of its own and may come from any
 * number of different owners. Nested under {server}/{tenantId} the same way
 * mirrorDirFor nests remote folders under {mode}_{username}, so items from
 * two different folderfoo deployments/tenants never collide on disk.
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
 * repositories key their read-only guard on (see isSharedFolderName).
 */
const SHARED_FOLDER_PREFIX = 'shared-by-';

export function sharedFolderName(owner: string): string {
  return `${SHARED_FOLDER_PREFIX}${sanitizeFolderName(owner) || 'unknown'}`;
}

export function isSharedFolderName(folderName: string | undefined): boolean {
  return !!folderName && folderName.startsWith(SHARED_FOLDER_PREFIX);
}

/** Thrown by a repository write against a doc that is someone else's shared item. */
export function sharedItemReadOnlyError(name: string): Error {
  return new Error(`"${name}" is shared with you and read-only here — copy it into your own folder with bucket_fork_shared_item (or "Fork to mine" in the web UI) to edit it`);
}

interface SharedItemRow {
  origin_id: string;
  owner: string;
  server: string;
  tenant_id: string;
  kind: 'memory' | 'skill';
  role: 'member' | 'editor';
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

function indexMirror(db: Database.Database, specs: Specs, row: Pick<SharedItemRow, 'kind' | 'owner' | 'mirror_path'>): void {
  const folder = sharedFolderName(row.owner);
  const table = row.kind === 'skill' ? 'skills' : 'memory_docs';
  // upsertFile skips a file whose mtime it has already seen, so a row filed under a different
  // folder (e.g. '' from before shared items had their own) would otherwise keep it forever.
  const existing = db.prepare(`SELECT folder FROM ${table} WHERE source_path = ?`).get(row.mirror_path) as { folder: string } | undefined;
  if (existing && existing.folder !== folder) removeFile(db, table, row.mirror_path);
  // Branched (not a single `const spec = kind === 'skill' ? ... : ...`) because upsertFile<T> is
  // generic over TFrontmatter and the ternary's union type satisfies neither call signature.
  if (row.kind === 'skill') upsertFile(db, specs.skill, row.mirror_path, folder);
  else upsertFile(db, specs.memory, row.mirror_path, folder);
}

function removeMirror(db: Database.Database, baseDir: string, row: Pick<SharedItemRow, 'kind' | 'mirror_path'>): void {
  removeFile(db, row.kind === 'skill' ? 'skills' : 'memory_docs', row.mirror_path);
  const dir = path.resolve(path.dirname(row.mirror_path));
  const root = path.resolve(sharedItemsMirrorRoot(baseDir));
  if (dir.startsWith(root + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

function publicContentToMarkdown(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

/**
 * Registers a share into shared_items and pulls its content immediately. Called for an accepted
 * share/public link (the explicit act of accepting — see routes.ts) and by refreshSharedItems for
 * a direct share it just discovered. Idempotent on origin_id: re-adding an already-tracked share
 * (or one previously revoked and re-shared) just refreshes it.
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
    role?: 'member' | 'editor';
    username?: string | null;
    publicToken?: string;
    modifiedAt?: string;
    paused?: boolean;
  }
): Promise<void> {
  if (!ORIGIN_ID_PATTERN.test(entry.originId)) throw new Error('invalid originId');
  const role = entry.publicToken ? 'member' : (entry.role ?? 'member');
  const mirrorDir = sharedItemsMirrorDir(baseDir, entry.server, entry.tenantId);
  const remoteName = path.basename(entry.path);
  if (!remoteName || remoteName === '.' || remoteName === '..') throw new Error('invalid shared item path');
  // A memory doc pushed before remote names kept their extension has none (see memorySyncSpec's
  // remoteFilename.toLocal) — its mirror still needs one to be addressable by filename.
  const localFilename = entry.kind === 'skill' ? 'SKILL.md' : remoteName.endsWith('.md') ? remoteName : `${remoteName}.md`;
  // One subdirectory per origin_id — a skill's SKILL.md needs its own parent
  // directory anyway (skill identity is (folder, id), i.e. the containing
  // directory's name), and giving every shared item (memory or skill) the
  // same shape keeps this code path uniform instead of branching on kind.
  const mirrorPath = path.join(mirrorDir, entry.originId, localFilename);

  const content = entry.publicToken
    ? publicContentToMarkdown((await fetchPublicLink(entry.server, entry.publicToken)).content)
    : await readFile(entry.server, baseDir, entry.tenantId, dirname(entry.path), remoteName, entry.owner);
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  fs.writeFileSync(mirrorPath, content);

  db.prepare(
    `INSERT INTO shared_items (origin_id, owner, server, tenant_id, kind, role, remote_path, mirror_path, last_seen_modified_at, status, added_at, username, public_token)
     VALUES (@origin_id, @owner, @server, @tenant_id, @kind, @role, @remote_path, @mirror_path, @last_seen_modified_at, 'active', @added_at, @username, @public_token)
     ON CONFLICT(origin_id) DO UPDATE SET
       owner = excluded.owner, kind = excluded.kind, role = excluded.role, remote_path = excluded.remote_path,
       mirror_path = excluded.mirror_path, last_seen_modified_at = excluded.last_seen_modified_at, status = 'active',
       username = excluded.username, public_token = excluded.public_token`
  ).run({
    origin_id: entry.originId,
    owner: entry.owner,
    server: entry.server,
    tenant_id: entry.tenantId,
    kind: entry.kind,
    role,
    remote_path: entry.path,
    mirror_path: mirrorPath,
    last_seen_modified_at: entry.modifiedAt ?? null,
    added_at: new Date().toISOString(),
    username: entry.publicToken ? '' : (entry.username ?? ''),
    public_token: entry.publicToken ?? null,
  });

  indexMirror(db, { skill: skillSpec, memory: memorySpec }, { kind: entry.kind, owner: entry.owner, mirror_path: mirrorPath });
  if (entry.paused) {
    db.prepare(`UPDATE ${entry.kind === 'skill' ? 'skills' : 'memory_docs'} SET paused = 1 WHERE source_path = ?`).run(mirrorPath);
  }
}

/** folderfoo's `path` field for a file is relative to the owner's root — everything but the last segment is its containing folder path. */
function dirname(remotePath: string): string {
  const idx = remotePath.lastIndexOf('/');
  return idx === -1 ? '' : remotePath.slice(0, idx);
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
 * Brings shared_items in line with folderfoo for the CURRENT login — called from the web UI's
 * recycle-icon button and once when the "Shared with me" panel opens. Still no poller/timer:
 * this is "refresh on demand," not a background sync.
 *
 * Login-granted items: one GET /shared-with-me per server+tenant in `servers` (plus any already
 * tracked), diffed by origin_id against the rows granted to `username`. Rows granted to a
 * different login are never touched — the other login's shares are simply absent from this
 * response, which is not a revocation.
 *  - live but not tracked → a direct share nobody here accepted; added PAUSED, so content someone
 *    else chose to push is not agent-visible until the user unpauses it.
 *  - tracked but not live → revoked (or deleted); evicted from the cache and mirror, row kept as
 *    'revoked' for the UI's dismissible "no longer shared with you" entry.
 *  - newer modifiedAt, or the mirror file is gone → refetched and reindexed.
 *  - otherwise only the bookkeeping columns (role, remote_path) are brought up to date — an
 *    owner-side rename or role change does not move modifiedAt.
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
  username: string | null
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
      const content = publicContentToMarkdown((await fetchPublicLink(row.server, row.public_token!)).content);
      const current = fs.existsSync(row.mirror_path) ? fs.readFileSync(row.mirror_path, 'utf-8') : null;
      if (current === content) {
        summary.unchanged++;
        continue;
      }
      fs.mkdirSync(path.dirname(row.mirror_path), { recursive: true });
      fs.writeFileSync(row.mirror_path, content);
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
      const role = liveEntry.role ?? row.role;
      try {
        if (liveEntry.modifiedAt !== row.last_seen_modified_at || !fs.existsSync(row.mirror_path)) {
          const content = await readFile(server, baseDir, tenantId, dirname(liveEntry.name), path.basename(liveEntry.name), liveEntry.owner);
          fs.mkdirSync(path.dirname(row.mirror_path), { recursive: true });
          fs.writeFileSync(row.mirror_path, content);
          const mtimeDate = new Date(liveEntry.modifiedAt);
          fs.utimesSync(row.mirror_path, mtimeDate, mtimeDate);
          indexMirror(db, specs, row);
          summary.updated++;
        } else {
          summary.unchanged++;
        }
        db.prepare(`UPDATE shared_items SET remote_path = ?, last_seen_modified_at = ?, role = ?, username = ? WHERE origin_id = ?`).run(
          liveEntry.name,
          liveEntry.modifiedAt,
          role,
          username,
          row.origin_id
        );
      } catch (err) {
        noteError(`failed to refresh shared item ${row.origin_id}`, err);
      }
    }

    // kind-filtered: a plain (non-mcp-memory-bucket) file/folder share has kind:null and nothing
    // here knows how to mirror it.
    for (const entry of live) {
      if (entry.type !== 'file' || !entry.originId || !entry.kind || trackedOrigins.has(entry.originId)) continue;
      try {
        await addSharedItem(db, baseDir, skillSpec, memorySpec, {
          owner: entry.owner,
          server,
          tenantId,
          path: entry.name,
          originId: entry.originId,
          kind: entry.kind,
          role: entry.role ?? 'member',
          username,
          modifiedAt: entry.modifiedAt,
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
 * login can see is indexed from its mirror file, anything else (another login's item, a revoked
 * one) is evicted. Run at startup, on every login/logout, and after a cache rebuild — the rebuild
 * wipes both tables and rescans only the configured source directories, which never include the
 * shared mirror. A visible item whose mirror file is gone is marked for refetch on the next refresh.
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
        removeFile(db, row.kind === 'skill' ? 'skills' : 'memory_docs', row.mirror_path);
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

export interface SharedItemRowWithEntryId extends Omit<SharedItemRow, 'public_token'> {
  /** True for a public-link item. The link's own token is never exposed — it is the credential. */
  public: boolean;
  /**
   * The row's addressable id in its table — source_path (== mirror_path) for memory_docs, or the
   * skill's frontmatter `name` for skills. null if the item isn't indexed (indexing failed, or
   * it's revoked and its cache row was evicted).
   */
  entryId: string | null;
  /** The folder its cache row is filed under (see sharedFolderName) — what skill_get/memory_get take as `folder`. */
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
 * with a clear message instead of a raw ENOENT from reading the missing mirror file.
 */
export function getForkableSharedItem(db: Database.Database, originId: string, username: string | null): SharedItemRow | { error: string } {
  const item = getSharedItem(db, originId);
  if (!item || !isVisibleTo(item, username)) return { error: `no shared item found with origin_id "${originId}"` };
  if (item.status !== 'active') return { error: 'this item is no longer shared with you' };
  if (!fs.existsSync(item.mirror_path)) return { error: 'this shared item has no local copy yet — refresh "Shared with me" in the web UI first' };
  return item;
}

export interface ShareTarget {
  server: string;
  tenantId: string;
  folderPath: string;
  name: string;
  kind: 'memory' | 'skill';
}

/**
 * Resolves a table/id doc into the folderfoo coordinates (folderPath, name — the name folderfoo
 * actually stores it under) needed to call shareWithUser/unshareWithUser/createShareLink/
 * createPublicLink, or the reason it can't be shared. Shared by the web UI's share routes
 * (routes.ts) AND the bucket_share_item/bucket_unshare_item MCP tools so this resolution lives in
 * exactly one place. `folder` disambiguates a skill name that exists in more than one folder
 * (skill ids are unique per folder only); a memory doc's id is its source_path, already unique.
 */
export function resolveShareTarget(
  db: Database.Database,
  repos: { skill: { listRemoteFolders(): RemoteFolder[] }; memory: { listRemoteFolders(): RemoteFolder[] } },
  table: 'skills' | 'memory_docs',
  id: string,
  folder?: string
): ShareTarget | { error: string } {
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
  const remote = repo.listRemoteFolders().find((f) => f.name === row.folder);
  if (!remote) return { error: 'not connected to a folderfoo remote folder — sharing requires a remote-backed doc' };
  // folderfoo only lets a file's owner share it (POST /share rejects any other caller), and
  // addressing remote.folderPath without the owner would resolve inside the CALLER's own tree.
  if (remote.owner) {
    return { error: `lives in a folder ${remote.owner} shared with you — only ${remote.owner} can share it; fork it into your own folder first` };
  }
  // Skills push to folderfoo under the fixed remote name "SKILL" regardless of local filename
  // (see sync.ts's remoteFilename.toRemote) — the folderfoo-relative NAME is therefore the
  // skill's containing directory, with "SKILL" as the addressed file, while memory docs keep
  // their own filename unchanged. relDir is the local-mirror-relative directory component
  // either way (dirname for a skill, since SKILL.md's own dirname IS the skill's folder).
  const relDir = path.relative(remote.mirrorDir, path.dirname(row.source_path));
  const kind: 'memory' | 'skill' = table === 'skills' ? 'skill' : 'memory';
  const name = table === 'skills' ? 'SKILL' : path.basename(row.source_path);
  const folderPath = relDir && relDir !== '.' ? joinRemoteFolderPath(remote.folderPath, relDir) : remote.folderPath;
  return { server: remote.server, tenantId: remote.tenantId, folderPath, name, kind };
}

/** Shared items the given login can see (its own, plus public-link items), newest first — never another login's. */
export function listSharedItems(db: Database.Database, username: string | null): SharedItemRowWithEntryId[] {
  const rows = (db.prepare(`SELECT * FROM shared_items ORDER BY added_at DESC`).all() as SharedItemRow[]).filter((row) => isVisibleTo(row, username));
  return rows.map(({ public_token, ...row }) => {
    const table = row.kind === 'memory' ? 'memory_docs' : 'skills';
    const idCol = row.kind === 'memory' ? 'source_path' : 'id';
    const found = db.prepare(`SELECT ${idCol} AS id, folder, paused FROM ${table} WHERE source_path = ?`).get(row.mirror_path) as
      | { id: string; folder: string; paused: number }
      | undefined;
    return { ...row, public: public_token !== null, entryId: found?.id ?? null, folder: found?.folder ?? null, paused: found?.paused === 1 };
  });
}
