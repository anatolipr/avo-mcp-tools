import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  saveFolder,
  saveRemoteFolder,
  removeFolder as removeFolderFromConfig,
  sanitizeFolderName,
  mirrorDirFor,
  type BucketConfig,
  type RemoteFolder,
} from '../config.js';
import { initialScan, type TableSyncSpec } from '../store/sync.js';
import type { SkillRepository } from '../skills/repository.js';
import type { MemoryRepository } from '../memory/repository.js';
import { listFolders as listFolderfooFolders } from '../remote/folderfoo-client.js';
import { pollOne } from '../remote/remote-sync.js';
import type { IdentityTracker } from '../remote/identity.js';
import { TENANT_ID } from './folderfoo-tenant.js';

const KIND = z.enum(['skill', 'memory']);

export function registerBucketFolderTools(
  mcp: McpServer,
  config: BucketConfig,
  skillRepo: SkillRepository,
  memoryRepo: MemoryRepository,
  db: Database.Database,
  skillSpec: TableSyncSpec<any>,
  memorySpec: TableSyncSpec<any>,
  identity: IdentityTracker
): void {
  const repoFor = (kind: 'skill' | 'memory') => (kind === 'skill' ? skillRepo : memoryRepo);
  const specFor = (kind: 'skill' | 'memory') => (kind === 'skill' ? skillSpec : memorySpec);

  mcp.tool(
    'bucket_list_folders',
    'Lists the configured skill and memory folders (the named source directories skills/memory docs live under, e.g. "super-skills", "demo-skills", "builtin"), each tagged `remote: true/false` for whether it syncs with folderfoo — use this to see what folders exist before passing a `folder` argument to a create/list/search tool, or before adding/removing one. To see UNconnected folderfoo folders available to connect, use bucket_list_remote_folders instead.',
    {},
    async () => {
      const skill = skillRepo.listFoldersWithRemoteInfo().map((f) => ({ ...f, kind: 'skill' as const }));
      const memory = memoryRepo.listFoldersWithRemoteInfo().map((f) => ({ ...f, kind: 'memory' as const }));
      return { content: [{ type: 'text', text: JSON.stringify({ skill, memory }, null, 2) }] };
    }
  );

  mcp.tool(
    'bucket_create_folder',
    'Registers a new skill or memory folder: an existing absolute directory path becomes a new named source that skill_create/memory_create can target via `folder`. Scans it once and starts watching it live — never creates the directory itself, it must already exist.',
    {
      kind: KIND,
      path: z.string().describe('absolute path to an existing directory'),
      name: z.string().optional().describe('name for the folder; defaults to a sanitized version of the directory\'s basename'),
    },
    async ({ kind, path: dirPath, name }) => {
      try {
        if (!path.isAbsolute(dirPath)) {
          return { content: [{ type: 'text', text: 'path must be an absolute directory path' }], isError: true };
        }
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
          return { content: [{ type: 'text', text: `not a directory: ${dirPath}` }], isError: true };
        }
        const folderName = sanitizeFolderName(name || path.basename(dirPath));
        if (!folderName) {
          return { content: [{ type: 'text', text: 'could not derive a valid folder name — provide one explicitly' }], isError: true };
        }
        const repo = kind === 'skill' ? skillRepo : memoryRepo;
        repo.addFolder({ name: folderName, path: dirPath });
        saveFolder(config, kind, { name: folderName, path: dirPath });
        return { content: [{ type: 'text', text: JSON.stringify({ name: folderName, path: dirPath, kind }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'bucket_list_remote_folders',
    "Lists the current user's own folders on the connected folderfoo deployment, including ones not yet connected to this bucket — use this to pick a `folderPath` for bucket_connect_remote_folder. Each entry is tagged `connected` (the name it's already registered under, per kind, or null) so you don't connect the same remote folder twice. Errors with a clear message if folderfoo integration is off (needs --folderfoo-mode/FOLDERFOO_MODE) or nobody is logged in yet (log in via the web UI, bucket_open_ui, first — this tool cannot itself perform a folderfoo login).",
    {},
    async () => {
      if (config.folderfooMode === 'off' || !config.folderfooHost) {
        return {
          content: [{ type: 'text', text: 'folderfoo integration is off — restart with --folderfoo-mode dev|cloud (or set FOLDERFOO_MODE) to enable it' }],
          isError: true,
        };
      }
      const current = identity.current();
      if (!current.username) {
        return { content: [{ type: 'text', text: 'not logged in to folderfoo — open the web UI (bucket_open_ui) and log in first' }], isError: true };
      }
      try {
        const server = config.folderfooHost;
        const folders = await listFolderfooFolders(server, config.baseDir, TENANT_ID);
        const connectedFor = (kind: 'skill' | 'memory') =>
          new Map(
            repoFor(kind)
              .listRemoteFolders()
              .filter((f) => f.server === server && f.tenantId === TENANT_ID)
              .map((f) => [f.folderPath, f.name])
          );
        const skillConnected = connectedFor('skill');
        const memoryConnected = connectedFor('memory');
        const annotated = folders.map((f) => ({
          ...f,
          connected: { skill: skillConnected.get(f.path) ?? null, memory: memoryConnected.get(f.path) ?? null },
        }));
        return { content: [{ type: 'text', text: JSON.stringify(annotated, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'bucket_connect_remote_folder',
    "Connects one of the user's own folderfoo folders (see bucket_list_remote_folders for `folderPath` values) as a new skill or memory source — syncs like a folder added via bucket_create_folder, so skill_create/memory_create can target it via `folder` and edits push back to folderfoo automatically. Idempotent: if this exact folderPath is already connected under this kind, returns that existing folder instead of creating a duplicate. Same login requirement as bucket_list_remote_folders.",
    {
      kind: KIND,
      folderPath: z.string().describe("a `path` value from bucket_list_remote_folders ('' for the folderfoo root)"),
      name: z.string().optional().describe("name for the folder; defaults to a sanitized version of folderPath's last segment. Auto-suffixed with the connecting username if it collides with a folder connected under a different folderfoo login."),
    },
    async ({ kind, folderPath, name }) => {
      if (config.folderfooMode === 'off' || !config.folderfooHost) {
        return {
          content: [{ type: 'text', text: 'folderfoo integration is off — restart with --folderfoo-mode dev|cloud (or set FOLDERFOO_MODE) to enable it' }],
          isError: true,
        };
      }
      const current = identity.current();
      if (!current.username) {
        return { content: [{ type: 'text', text: 'not logged in to folderfoo — open the web UI (bucket_open_ui) and log in first' }], isError: true };
      }
      const server = config.folderfooHost;
      const repo = repoFor(kind);
      const already = repo.listRemoteFolders().find((f) => f.server === server && f.tenantId === TENANT_ID && f.folderPath === folderPath);
      if (already) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ name: already.name, server, tenantId: TENANT_ID, folderPath, kind, alreadyConnected: true }, null, 2) },
          ],
        };
      }
      const folderName = sanitizeFolderName(name || folderPath.split('/').filter(Boolean).pop() || TENANT_ID);
      if (!folderName) {
        return { content: [{ type: 'text', text: 'could not derive a valid folder name — provide one explicitly' }], isError: true };
      }
      try {
        // Resolved FIRST (before deriving mirrorDir) — auto-suffixes the requested name when it
        // collides with a folder connected under a DIFFERENT folderfoo login (e.g. two different users
        // each naturally wanting "bbbmemz"), still rejecting a collision against the CALLER's own
        // identity. Mirrors the web route's POST /api/remote-folders logic (routes.ts) — see
        // repo.resolveAvailableName's doc comment.
        const resolvedName = repo.resolveAvailableName(folderName, current.username);
        const mirrorDir = mirrorDirFor(config.baseDir, current.mode, current.username, resolvedName);
        const remote: RemoteFolder = { name: resolvedName, server, tenantId: TENANT_ID, folderPath, mirrorDir, mode: current.mode, username: current.username };
        repo.registerRemoteFolder(remote);
        saveRemoteFolder(config, kind, { name: resolvedName, server, tenantId: TENANT_ID, folderPath, mode: current.mode, username: current.username });
        await pollOne(db, specFor(kind), remote, config.baseDir);
        return { content: [{ type: 'text', text: JSON.stringify({ name: resolvedName, server, tenantId: TENANT_ID, folderPath, kind }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'bucket_delete_folder',
    'Unregisters a skill or memory folder by name — works for both local and folderfoo-connected (remote) folders. Stops watching it and drops its cached entries from the index; never touches the user\'s own files, on disk or on folderfoo — for a remote folder, only its local mirror cache is deleted, which is rebuilt fresh if reconnected.',
    { kind: KIND, name: z.string() },
    async ({ kind, name }) => {
      try {
        const repo = kind === 'skill' ? skillRepo : memoryRepo;
        repo.removeFolder(name);
        removeFolderFromConfig(config, kind, name);
        return { content: [{ type: 'text', text: `Removed ${kind} folder "${name}"` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'bucket_rebuild_cache',
    'EMERGENCY USE ONLY. Wipes the entire SQLite cache (all skills, memory docs, the full-text search index, and the date index) and rebuilds it from scratch by rescanning every configured folder from disk. Source markdown files on disk are never touched — this only affects the derived cache, which is always safe to discard and regenerate. Use this only when other tools return results that contradict what you can see in the actual files (e.g. stale search hits, a doc that clearly exists on disk but skill_get/memory_get can\'t find, or search_by_date returning wrong dates) and a normal create/update/relocate call hasn\'t resolved it — this is a last resort, not a routine maintenance step. Takes a moment to complete on a large folder; nothing else should be called until it returns.',
    {},
    async () => {
      try {
        db.exec(`DELETE FROM skills; DELETE FROM memory_docs; DELETE FROM search_index; DELETE FROM doc_dates;`);
        initialScan(db, skillSpec);
        initialScan(db, memorySpec);
        const skillCount = (db.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }).n;
        const memoryCount = (db.prepare(`SELECT COUNT(*) AS n FROM memory_docs`).get() as { n: number }).n;
        return {
          content: [
            { type: 'text', text: `Cache rebuilt from disk: ${skillCount} skill(s), ${memoryCount} memory doc(s) reindexed.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );
}
