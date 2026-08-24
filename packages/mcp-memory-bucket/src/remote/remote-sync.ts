import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { TableSyncSpec } from '../store/sync.js';
import { upsertFile, removeFile, walkMarkdownFiles } from '../store/sync.js';
import type { RemoteFolder } from '../config.js';
import { getLastChanged, getChangedSince, readFile, FolderfooAuthError } from './folderfoo-client.js';

// Fixed for every remote source in v1 - no per-source tuning knob, per the
// settled design (Q15 in the grilling session).
const POLL_INTERVAL_MS = 60_000;

/**
 * Local, per-source last-synced watermark - NOT the sqlite cache itself
 * (that's a completely separate concept, mtime_ms per cached row). This is
 * a small sidecar file recording "the last folderfoo last-changed value
 * this poller has successfully synced up through", so a restart doesn't
 * re-pull everything from since=0.
 */
function watermarkPath(mirrorDir: string): string {
  return path.join(mirrorDir, '.last-synced');
}

function readLocalWatermark(mirrorDir: string): number {
  try {
    return Number(fs.readFileSync(watermarkPath(mirrorDir), 'utf-8')) || 0;
  } catch {
    return 0;
  }
}

function writeLocalWatermark(mirrorDir: string, value: number): void {
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.writeFileSync(watermarkPath(mirrorDir), String(value));
}

/**
 * folderfoo's GET /folders/changed-since (and GET /folders in general)
 * report folderPath ABSOLUTE FROM THE TENANT ROOT (server.js's walk()
 * seeds its relPath accumulator with the queried folderPath itself) - e.g.
 * querying folderPath=memz for a root-level file returns folderPath:
 * "memz", not "". That's a DIFFERENT coordinate system than mirror-
 * relative (where the mirror root already IS memz, so a root-level file's
 * mirror-relative dir is ""). Joining a tenant-root-absolute folderPath
 * directly onto folder.mirrorDir double-nests it (mirrorDir/memz/...
 * instead of mirrorDir/...) - this strips remote.folderPath back off to
 * recover the true mirror-relative subpath. Every caller that turns a
 * changed-since response entry into a local mirror path must go through
 * this, not path.join the raw folderPath directly.
 */
function toMirrorRelativeDir(remoteFolderPath: string, absoluteFolderPath: string): string {
  if (!absoluteFolderPath) return '';
  if (absoluteFolderPath === remoteFolderPath) return '';
  if (remoteFolderPath && absoluteFolderPath.startsWith(`${remoteFolderPath}/`)) {
    return absoluteFolderPath.slice(remoteFolderPath.length + 1);
  }
  // Shouldn't happen (changed-since was queried with remoteFolderPath, so
  // every entry should be that path or nested under it) - fall back to the
  // raw value rather than silently losing the file, but this indicates a
  // mismatch worth knowing about.
  console.error(
    `[memory-bucket] unexpected folderPath "${absoluteFolderPath}" from folderfoo outside queried folder "${remoteFolderPath}" - using it as-is`
  );
  return absoluteFolderPath;
}

/**
 * Reconciles deletions: getChangedSince only reports additions/
 * modifications (files with mtime > since), never "this file no longer
 * exists" - there's no tombstone protocol on the folderfoo side (see the
 * implementation plan's flagged gap). Resolved here via a full-listing
 * comparison instead: ask folderfoo for every file under the folder
 * (changed-since?since=0, which is exactly "everything"), diff that
 * against what's currently mirrored on disk, and remove any mirror file
 * that's no longer in the remote listing. Run once per poll tick
 * alongside the incremental pull, not in place of it - the incremental
 * pull still avoids re-fetching unchanged file CONTENT, this only avoids
 * missing deletions.
 */
async function reconcileDeletions<TFrontmatter>(
  db: Database.Database,
  spec: TableSyncSpec<TFrontmatter>,
  folder: RemoteFolder,
  credentialsBaseDir: string
): Promise<void> {
  const remoteFiles = await getChangedSince(folder.server, credentialsBaseDir, folder.tenantId, folder.folderPath, 0);
  const remoteRelPaths = new Set(
    remoteFiles.map((f) => {
      const mirrorRelativeDir = toMirrorRelativeDir(folder.folderPath, f.folderPath);
      return mirrorRelativeDir ? path.join(mirrorRelativeDir, f.name) : f.name;
    })
  );

  if (!fs.existsSync(folder.mirrorDir)) return;
  for (const mirrorFilePath of walkMarkdownFiles(folder.mirrorDir)) {
    const relPath = path.relative(folder.mirrorDir, mirrorFilePath);
    // remoteFiles' entries are keyed by folderfoo's own filename grammar
    // (no .md suffix - folderfoo doesn't know about markdown, it stores
    // opaque names), while the mirror stores real .md files so upsertFile/
    // matchesFile work unchanged - strip the extension before comparing.
    const relPathNoExt = relPath.endsWith('.md') ? relPath.slice(0, -3) : relPath;
    if (!remoteRelPaths.has(relPathNoExt)) {
      fs.unlinkSync(mirrorFilePath);
      removeFile(db, spec.table, mirrorFilePath);
    }
  }
}

async function pullFile<TFrontmatter>(
  db: Database.Database,
  spec: TableSyncSpec<TFrontmatter>,
  folder: RemoteFolder,
  credentialsBaseDir: string,
  changedFile: { name: string; folderPath: string; mtime: number }
): Promise<void> {
  // changedFile.folderPath is tenant-root-absolute (folderfoo's own
  // convention - see toMirrorRelativeDir's doc comment), so it's the
  // correct value to pass straight through to readFile (folderfoo expects
  // that same absolute form for GET /data/:filename), but it must be
  // converted to mirror-relative before joining onto folder.mirrorDir.
  const content = await readFile(folder.server, credentialsBaseDir, folder.tenantId, changedFile.folderPath, changedFile.name);
  const mirrorRelativeDir = toMirrorRelativeDir(folder.folderPath, changedFile.folderPath);
  const relPath = mirrorRelativeDir ? path.join(mirrorRelativeDir, changedFile.name) : changedFile.name;
  const mirrorPath = path.join(folder.mirrorDir, `${relPath}.md`);
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  fs.writeFileSync(mirrorPath, content);
  // Preserves the remote mtime on the mirror file so upsertFile's own
  // mtime-based skip check (existing.mtime_ms === parsed.mtimeMs) stays
  // meaningful on a later poll tick, rather than every mirrored file
  // always reporting "just now" and getting needlessly reprocessed.
  const mtimeDate = new Date(changedFile.mtime);
  fs.utimesSync(mirrorPath, mtimeDate, mtimeDate);
  if (spec.matchesFile(mirrorPath)) upsertFile(db, spec, mirrorPath);
}

/**
 * credentialsBaseDir is the memory-bucket PROCESS's own base directory
 * (where memory-bucket.config.json and .memory-bucket-credentials.json
 * live) - deliberately NOT folder.mirrorDir, which is just this one
 * source's local content cache. All remote sources share one credentials
 * file at credentialsBaseDir, keyed by server URL (see credentials.ts).
 */
export async function pollOne<TFrontmatter>(
  db: Database.Database,
  spec: TableSyncSpec<TFrontmatter>,
  folder: RemoteFolder,
  credentialsBaseDir: string,
  options: { force?: boolean } = {}
): Promise<void> {
  try {
    const lastChanged = await getLastChanged(folder.server, credentialsBaseDir, folder.tenantId, folder.folderPath);
    const localWatermark = readLocalWatermark(folder.mirrorDir);
    // force (manual resync, or rebuild-cache) always does real work,
    // including reconcileDeletions - a user explicitly asking to resync
    // shouldn't silently no-op just because folderfoo's watermark happens
    // to equal what we last saw; the whole point of a manual resync is to
    // re-verify against the live state, not trust the cheap check alone.
    if (!options.force && lastChanged <= localWatermark) return; // cheap path: nothing changed since our last sync, no listing call

    const changed = await getChangedSince(folder.server, credentialsBaseDir, folder.tenantId, folder.folderPath, localWatermark);
    for (const file of changed) {
      await pullFile(db, spec, folder, credentialsBaseDir, file);
    }
    await reconcileDeletions(db, spec, folder, credentialsBaseDir);
    writeLocalWatermark(folder.mirrorDir, lastChanged);
  } catch (err) {
    if (err instanceof FolderfooAuthError) {
      // Per the settled design: fail loudly per-call, but a poll tick
      // failing auth shouldn't crash the whole poller loop - the next
      // tick tries again (and any live skill_get/memory_get call against
      // this source will surface its own FolderfooAuthError directly to
      // the caller regardless of poller state).
      console.error(`[memory-bucket] ${err.message}`);
      return;
    }
    throw err;
  }
}

export interface RemotePollerHandle {
  stop: () => void;
  /** Triggers one immediate out-of-cycle poll for a single named source - backs the web UI's per-source "resync now" button. */
  resyncNow: (folderName: string) => Promise<void>;
  /**
   * Triggers one immediate poll for EVERY remote source this handle covers -
   * used by /api/rebuild-cache so a full cache rebuild also picks up
   * remote deletions/changes first, not just whatever's stale on local
   * mirror disk. Without this, rebuild-cache's local-only re-scan would
   * silently resurrect a file that was deleted on folderfoo but whose
   * stale mirror copy hadn't been reconciled away yet (e.g. because the
   * poller's next tick hadn't fired) - a real bug this exists to close.
   */
  resyncAll: () => Promise<void>;
}

export function startRemotePolling<TFrontmatter>(
  db: Database.Database,
  spec: TableSyncSpec<TFrontmatter>,
  remoteFolders: RemoteFolder[],
  credentialsBaseDir: string
): RemotePollerHandle {
  const byName = new Map(remoteFolders.map((f) => [f.name, f]));

  const interval = setInterval(() => {
    for (const folder of remoteFolders) {
      pollOne(db, spec, folder, credentialsBaseDir).catch((err) =>
        console.error(`[memory-bucket] remote poll failed for ${folder.name}:`, err)
      );
    }
  }, POLL_INTERVAL_MS);
  // Node's default keep-alive behavior would hold the process open just for
  // this interval - unref so remote polling never blocks a clean process exit.
  interval.unref();

  return {
    stop: () => clearInterval(interval),
    resyncNow: async (folderName: string) => {
      const folder = byName.get(folderName);
      if (!folder) throw new Error(`no remote source configured with name "${folderName}"`);
      await pollOne(db, spec, folder, credentialsBaseDir, { force: true });
    },
    resyncAll: async () => {
      for (const folder of remoteFolders) {
        await pollOne(db, spec, folder, credentialsBaseDir, { force: true });
      }
    },
  };
}
