import path from 'node:path';
import type Database from 'better-sqlite3';
import { mirrorDirFor, saveRemoteFolder, sanitizeFolderName, updateRemoteFolderRole, type BucketConfig, type RemoteFolder } from '../config.js';
import type { SkillRepository } from '../skills/repository.js';
import type { MemoryRepository } from '../memory/repository.js';
import { walkMarkdownFiles, type TableSyncSpec } from '../store/sync.js';
import { getSharedWithMe, type SharedWithMeEntry } from './folderfoo-client.js';
import { pollOne } from './remote-sync.js';
import { isFolderVisible, type IdentityTracker } from './identity.js';

/** Everything connecting or sharing a folderfoo folder needs — built once in server.ts. */
export interface RemoteDeps {
  db: Database.Database;
  config: BucketConfig;
  skillRepo: SkillRepository;
  memoryRepo: MemoryRepository;
  skillSpec: TableSyncSpec<any>;
  memorySpec: TableSyncSpec<any>;
  identity: IdentityTracker;
  /** This app's own web UI origin, e.g. "http://localhost:8767" — share links land there. */
  appUrl: string;
}

/** An error carrying the HTTP status the web routes should answer with. */
export class SharingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const repoFor = (deps: RemoteDeps, kind: 'skill' | 'memory') => (kind === 'skill' ? deps.skillRepo : deps.memoryRepo);

/**
 * The role a folder share grants on `folderPath` inside `owner`'s tree: the strongest folder share
 * covering it (the folder itself or any ancestor). undefined when none does.
 */
export function sharedFolderRole(entries: SharedWithMeEntry[], owner: string, folderPath: string): 'member' | 'editor' | undefined {
  let role: 'member' | 'editor' | undefined;
  for (const entry of entries) {
    if (entry.type !== 'folder' || entry.owner !== owner) continue;
    if (folderPath !== entry.name && !folderPath.startsWith(`${entry.name}/`)) continue;
    if (entry.role === 'editor') return 'editor';
    role = 'member';
  }
  return role;
}

/**
 * Cheap best-effort "did the user pick the wrong kind" heuristic, checked once right after connect
 * (content is already mirrored locally by then, so this is a local directory walk). A skill's
 * remote content always lives under the literal filename "SKILL.md", so "every .md file mirrored is
 * literally named SKILL.md" is a strong skill-shaped signal. Returns undefined (no warning) for an
 * empty folder — nothing synced yet is not evidence of anything.
 */
export function detectKindMismatch(kind: 'skill' | 'memory', mirrorDir: string): string | undefined {
  let total = 0;
  let skillNamed = 0;
  for (const file of walkMarkdownFiles(mirrorDir)) {
    total++;
    if (path.basename(file) === 'SKILL.md') skillNamed++;
  }
  if (total === 0) return undefined;
  if (kind === 'memory' && skillNamed === total) {
    return `This folder looks like it contains skills (every file is a SKILL.md), not memory docs — you connected it as a memory folder. Remove and reconnect it as a skill folder instead.`;
  }
  if (kind === 'skill' && skillNamed === 0) {
    return `This folder looks like it contains memory docs, not skills (no SKILL.md files found) — you connected it as a skill folder. Remove and reconnect it as a memory folder instead.`;
  }
  return undefined;
}

export interface ConnectResult {
  name: string;
  server: string;
  tenantId: string;
  folderPath: string;
  kind: 'skill' | 'memory';
  owner?: string;
  role?: 'member' | 'editor';
  alreadyConnected?: boolean;
  kindMismatchWarning?: string;
}

/**
 * Connects a folderfoo folder as a new skill/memory source — one of the caller's own, or (with
 * `owner`) one someone shared with them, whose role is looked up and recorded so a read-only share
 * refuses local writes up front. Idempotent: an already-connected (server, tenant, folderPath,
 * owner) returns that source. Registers the mirror, saves the config entry, and pulls content once
 * so it shows up without waiting for the first poll tick. Shared by the web UI's connect route, the
 * bucket_connect_remote_folder tool, and accepting a folder invite link.
 */
export async function connectRemoteFolder(
  deps: RemoteDeps,
  input: { kind: 'skill' | 'memory'; name?: string; server: string; tenantId: string; folderPath: string; owner?: string }
): Promise<ConnectResult> {
  const { config, identity } = deps;
  const { kind, server, tenantId, folderPath } = input;
  const owner = input.owner || undefined;
  const current = identity.current();
  if (!current.username) throw new SharingError('not logged in to folderfoo — open the web UI (bucket_open_ui) and log in first', 401);
  if (owner === current.username) throw new SharingError('that folder is your own — connect it without an owner', 400);

  const repo = repoFor(deps, kind);
  const already = repo
    .listRemoteFolders()
    .find((f) => f.server === server && f.tenantId === tenantId && f.folderPath === folderPath && (f.owner ?? undefined) === owner && isFolderVisible(f, current));
  if (already) return { name: already.name, server, tenantId, folderPath, kind, owner, role: already.role, alreadyConnected: true };

  const folderName = sanitizeFolderName(input.name || folderPath.split('/').filter(Boolean).pop() || tenantId);
  if (!folderName) throw new SharingError('could not derive a valid folder name — provide one explicitly', 400);

  const role = owner ? sharedFolderRole(await getSharedWithMe(server, config.baseDir, tenantId), owner, folderPath) : undefined;
  if (owner && !role) throw new SharingError(`${owner} has not shared "${folderPath}" (or a folder containing it) with you`, 403);

  // Resolved FIRST (before deriving mirrorDir) — auto-suffixes the requested name when it collides
  // with a folder connected under a DIFFERENT folderfoo login, still rejecting a collision against
  // the caller's own identity (see repo.resolveAvailableName). Everything downstream uses this name.
  let resolvedName: string;
  try {
    resolvedName = repo.resolveAvailableName(folderName, current.username);
  } catch (err) {
    throw new SharingError((err as Error).message, 409);
  }
  const mirrorDir = mirrorDirFor(config.baseDir, current.mode, current.username, resolvedName, owner);
  const remote: RemoteFolder = { name: resolvedName, server, tenantId, folderPath, mirrorDir, mode: current.mode, username: current.username, owner, role };
  repo.registerRemoteFolder(remote);
  saveRemoteFolder(config, kind, { name: resolvedName, server, tenantId, folderPath, mode: current.mode, username: current.username, owner, role });
  await pollOne(deps.db, kind === 'skill' ? deps.skillSpec : deps.memorySpec, remote, config.baseDir);
  return { name: resolvedName, server, tenantId, folderPath, kind, owner, role, kindMismatchWarning: detectKindMismatch(kind, mirrorDir) };
}

/**
 * Re-reads the role of every visible connected folder someone else shared, and records any change
 * (memory and config). One GET /shared-with-me per server+tenant. Failures are left for the next
 * check — a folder that is gone entirely is pruned elsewhere (routes.ts's pruneDeletedRemoteFolders).
 */
export async function refreshSharedFolderRoles(deps: RemoteDeps): Promise<void> {
  const current = deps.identity.current();
  const groups = new Map<string, Array<{ kind: 'skill' | 'memory'; remote: RemoteFolder }>>();
  for (const kind of ['skill', 'memory'] as const) {
    for (const remote of repoFor(deps, kind).listRemoteFolders()) {
      if (!remote.owner || !isFolderVisible(remote, current)) continue;
      const key = `${remote.server}::${remote.tenantId}`;
      groups.set(key, [...(groups.get(key) ?? []), { kind, remote }]);
    }
  }
  for (const sources of groups.values()) {
    const { server, tenantId } = sources[0]!.remote;
    let entries: SharedWithMeEntry[];
    try {
      entries = await getSharedWithMe(server, deps.config.baseDir, tenantId);
    } catch {
      continue;
    }
    for (const { kind, remote } of sources) {
      const role = sharedFolderRole(entries, remote.owner!, remote.folderPath);
      if (role && repoFor(deps, kind).setRemoteRole(remote.name, role)) updateRemoteFolderRole(deps.config, kind, remote.name, role);
    }
  }
}
