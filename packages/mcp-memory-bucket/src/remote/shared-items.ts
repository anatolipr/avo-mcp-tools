import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSharedWithMe, readFile, joinRemoteFolderPath, type SharedWithMeEntry } from './folderfoo-client.js';
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
export function sharedItemsMirrorDir(baseDir: string, server: string, tenantId: string): string {
  const serverSegment = sanitizeFolderName(server.replace(/^https?:\/\//, ''));
  return path.join(baseDir, '.memory-bucket-shared-items', serverSegment, sanitizeFolderName(tenantId));
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
}

/**
 * Registers a newly-accepted share (from the share-link accept flow, or a
 * direct username share the user just picked up) into shared_items and pulls
 * its content immediately — this one fetch is the explicit act of accepting
 * a share, not a background resync, so it doesn't violate "refresh is a
 * UI-only action" (see refreshSharedItems below, which IS that action).
 * Idempotent on origin_id: re-adding an already-tracked share just refreshes
 * its content once, e.g. if `addSharedItem` is called again by mistake, or
 * the item was previously revoked and got re-shared with the same origin.
 */
export async function addSharedItem(
  db: Database.Database,
  baseDir: string,
  skillSpec: TableSyncSpec<SkillFrontmatter>,
  memorySpec: TableSyncSpec<MemoryFrontmatter>,
  entry: { owner: string; server: string; tenantId: string; path: string; originId: string; kind: 'memory' | 'skill'; role?: 'member' | 'editor' }
): Promise<void> {
  const role = entry.role ?? 'member';
  const mirrorDir = sharedItemsMirrorDir(baseDir, entry.server, entry.tenantId);
  const localFilename = entry.kind === 'skill' ? 'SKILL.md' : path.basename(entry.path);
  // One subdirectory per origin_id — a skill's SKILL.md needs its own parent
  // directory anyway (skill identity is (folder, id), i.e. the containing
  // directory's name), and giving every shared item (memory or skill) the
  // same shape keeps this code path uniform instead of branching on kind.
  const mirrorPath = path.join(mirrorDir, entry.originId, localFilename);
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });

  const content = await readFile(entry.server, baseDir, entry.tenantId, dirname(entry.path), path.basename(entry.path));
  fs.writeFileSync(mirrorPath, content);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO shared_items (origin_id, owner, server, tenant_id, kind, role, remote_path, mirror_path, last_seen_modified_at, status, added_at)
     VALUES (@origin_id, @owner, @server, @tenant_id, @kind, @role, @remote_path, @mirror_path, @last_seen_modified_at, 'active', @added_at)
     ON CONFLICT(origin_id) DO UPDATE SET
       owner = excluded.owner, kind = excluded.kind, role = excluded.role, remote_path = excluded.remote_path,
       mirror_path = excluded.mirror_path, last_seen_modified_at = excluded.last_seen_modified_at, status = 'active'`
  ).run({
    origin_id: entry.originId,
    owner: entry.owner,
    server: entry.server,
    tenant_id: entry.tenantId,
    kind: entry.kind,
    role,
    remote_path: entry.path,
    mirror_path: mirrorPath,
    last_seen_modified_at: null,
    added_at: now,
  });

  // Branched (not a single `const spec = kind === 'skill' ? skillSpec : memorySpec`) because
  // upsertFile<T> is generic over TFrontmatter — a ternary's inferred union type
  // TableSyncSpec<SkillFrontmatter> | TableSyncSpec<MemoryFrontmatter> doesn't satisfy either
  // single-generic call signature, even though each branch alone is perfectly type-safe.
  if (entry.kind === 'skill') upsertFile(db, skillSpec, mirrorPath);
  else upsertFile(db, memorySpec, mirrorPath);
}

/** folderfoo's `path` field for a file is relative to the owner's root — everything but the last segment is its containing folder path. */
function dirname(remotePath: string): string {
  const idx = remotePath.lastIndexOf('/');
  return idx === -1 ? '' : remotePath.slice(0, idx);
}

export interface RefreshSummary {
  updated: number;
  revoked: number;
  unchanged: number;
}

/**
 * The ONLY place shared_items ever changes after the initial addSharedItem —
 * called exclusively from the web UI's refresh-button handler (see
 * web/routes.ts's POST /api/shared-items/refresh). No poller, no timer, no
 * auto-refresh on focus/load/tool-call: per the settled design, staleness is
 * fully manual, same as a GitHub list you refresh by hand. Diffs
 * GET /shared-with-me (one call per distinct server+tenant, covering every
 * owner at once) against locally-tracked origin_ids:
 *  - origin_id missing from the response → the share was revoked (or the
 *    item deleted) — evict from the cache/search-index via removeFile and
 *    mark the row 'revoked' (kept for the UI's dismissible "no longer
 *    shared with you" row, not silently dropped — see routes.ts).
 *  - origin_id present with a newer modifiedAt → refetch content, rewrite
 *    the mirror file, re-run upsertFile (which auto-invalidates search_index
 *    for the new content).
 *  - origin_id present with an unchanged modifiedAt → left alone.
 * A rename on the owner's side is NOT distinguished from a content edit
 * here — both just mean "modifiedAt moved and remote_path may differ" — the
 * mirror_path is deliberately kept path-independent (path.join(mirrorDir,
 * originId, filename)) so a rename never needs a file move, only the
 * `remote_path` bookkeeping column changes.
 */
export async function refreshSharedItems(
  db: Database.Database,
  baseDir: string,
  skillSpec: TableSyncSpec<SkillFrontmatter>,
  memorySpec: TableSyncSpec<MemoryFrontmatter>
): Promise<RefreshSummary> {
  const summary: RefreshSummary = { updated: 0, revoked: 0, unchanged: 0 };
  const tracked = db.prepare(`SELECT * FROM shared_items WHERE status = 'active'`).all() as SharedItemRow[];
  if (tracked.length === 0) return summary;

  const byServerTenant = new Map<string, SharedItemRow[]>();
  for (const row of tracked) {
    const key = `${row.server}::${row.tenant_id}`;
    const list = byServerTenant.get(key) ?? [];
    list.push(row);
    byServerTenant.set(key, list);
  }

  for (const [key, rows] of byServerTenant) {
    const sepIdx = key.indexOf('::');
    const server = key.slice(0, sepIdx);
    const tenantId = key.slice(sepIdx + 2);
    let live: SharedWithMeEntry[];
    try {
      live = await getSharedWithMe(server, baseDir, tenantId);
    } catch (err) {
      console.error(`[memory-bucket] failed to refresh shared items for ${server}:`, err);
      continue;
    }
    const liveByOrigin = new Map(live.filter((e) => e.originId).map((e) => [e.originId as string, e]));

    for (const row of rows) {
      const liveEntry = liveByOrigin.get(row.origin_id);
      if (!liveEntry) {
        removeFile(db, row.kind === 'skill' ? 'skills' : 'memory_docs', row.mirror_path);
        db.prepare(`UPDATE shared_items SET status = 'revoked' WHERE origin_id = ?`).run(row.origin_id);
        fs.rmSync(path.dirname(row.mirror_path), { recursive: true, force: true });
        summary.revoked++;
        continue;
      }
      if (liveEntry.modifiedAt === row.last_seen_modified_at) {
        summary.unchanged++;
        continue;
      }
      try {
        const content = await readFile(server, baseDir, tenantId, dirname(liveEntry.name), path.basename(liveEntry.name));
        fs.writeFileSync(row.mirror_path, content);
        const mtimeDate = new Date(liveEntry.modifiedAt);
        fs.utimesSync(row.mirror_path, mtimeDate, mtimeDate);
        if (row.kind === 'skill') upsertFile(db, skillSpec, row.mirror_path);
        else upsertFile(db, memorySpec, row.mirror_path);
        db.prepare(
          `UPDATE shared_items SET remote_path = ?, last_seen_modified_at = ?, role = ? WHERE origin_id = ?`
        ).run(liveEntry.name, liveEntry.modifiedAt, liveEntry.role ?? row.role, row.origin_id);
        summary.updated++;
      } catch (err) {
        console.error(`[memory-bucket] failed to refresh shared item ${row.origin_id}:`, err);
      }
    }
  }

  return summary;
}

/** Dismisses a revoked row from the "Shared with me" panel — no-ops (does not un-revoke) for a still-active row; use refreshSharedItems to detect revocation in the first place. */
export function dismissRevokedSharedItem(db: Database.Database, originId: string): void {
  db.prepare(`DELETE FROM shared_items WHERE origin_id = ? AND status = 'revoked'`).run(originId);
}

export interface SharedItemRowWithEntryId extends SharedItemRow {
  /**
   * The row's addressable id in its table — source_path (== mirror_path)
   * for memory_docs, or the skill's frontmatter `name` for skills (skills'
   * real id, NOT mirror_path — see sync.ts's getId). This is what a
   * Selection{table, id} needs to open the item in the existing
   * detail-panel; null if the item hasn't been indexed yet (e.g. the very
   * first upsertFile from addSharedItem raced with this read, or indexing
   * failed) or if it's revoked and its cache row was already evicted.
   */
  entryId: string | null;
}

/** Single-row lookup by origin_id — used by the "fork to mine" route (routes.ts) to read the
 * mirror_path/kind it needs before handing off to MemoryRepository.create/SkillRepository.create. */
export function getSharedItem(db: Database.Database, originId: string): SharedItemRow | undefined {
  return db.prepare(`SELECT * FROM shared_items WHERE origin_id = ?`).get(originId) as SharedItemRow | undefined;
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
 * createPublicLink. Shared by the web UI's share routes (routes.ts) AND the bucket_share_item/
 * bucket_unshare_item/bucket_fork_shared_item MCP tools (shared/bucket-share-tool.ts) so the "must
 * be remote, must exist under a connected folder" resolution logic lives in exactly one place.
 * Returns null if the doc isn't remote (a purely local doc has nothing on folderfoo to address).
 */
export function resolveShareTarget(
  db: Database.Database,
  repos: { skill: { listRemoteFolders(): RemoteFolder[] }; memory: { listRemoteFolders(): RemoteFolder[] } },
  table: 'skills' | 'memory_docs',
  id: string
): ShareTarget | null {
  const idCol = table === 'skills' ? 'id' : 'source_path';
  const row = db.prepare(`SELECT source_path, folder FROM ${table} WHERE ${idCol} = ?`).get(id) as
    | { source_path: string; folder: string }
    | undefined;
  if (!row) return null;
  const repo = table === 'skills' ? repos.skill : repos.memory;
  const remote = repo.listRemoteFolders().find((f) => f.name === row.folder);
  if (!remote) return null;
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

export function listSharedItems(db: Database.Database): SharedItemRowWithEntryId[] {
  const rows = db.prepare(`SELECT * FROM shared_items ORDER BY added_at DESC`).all() as SharedItemRow[];
  return rows.map((row) => {
    if (row.kind === 'memory') {
      const found = db.prepare(`SELECT source_path FROM memory_docs WHERE source_path = ?`).get(row.mirror_path) as
        | { source_path: string }
        | undefined;
      return { ...row, entryId: found?.source_path ?? null };
    }
    const found = db.prepare(`SELECT id FROM skills WHERE source_path = ?`).get(row.mirror_path) as { id: string } | undefined;
    return { ...row, entryId: found?.id ?? null };
  });
}
