import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { TableSyncSpec } from '../store/sync.js';
import { upsertFile, removeFile, walkMarkdownFiles, walkAttachmentFiles } from '../store/sync.js';
import type { RemoteFolder } from '../config.js';
import { getLastChanged, getChangedSince, readFile, FolderfooAuthError } from './folderfoo-client.js';
import { isUnderAttachmentsDir } from '../attachments/storage.js';

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
    // remoteFiles' entries are keyed by folderfoo's own filename grammar, which may differ from
    // the local mirror's filename (see spec.remoteFilename's doc comment — skills push under the
    // fixed name "SKILL", memory docs push under their own filename unchanged).
    const dir = path.dirname(relPath);
    const baseName = path.basename(relPath);
    const expectedRemoteName = spec.remoteFilename.toRemote(baseName);
    // Also accept the LEGACY extensionless form (baseName with its .md suffix stripped) — a memory
    // doc pushed before the extension-preserving fix still sits on folderfoo under that bare name
    // and always will, until it's renamed/re-saved. Without this, a correctly-pulled local mirror
    // file for such a doc looks "no longer present remotely" (its exact new-convention name was
    // never actually on folderfoo to begin with) and gets wrongly deleted here.
    const legacyRemoteName = baseName.endsWith('.md') ? baseName.slice(0, -3) : baseName;
    const candidates = [expectedRemoteName, legacyRemoteName];
    const stillPresentRemotely = candidates.some((name) => remoteRelPaths.has(dir === '.' ? name : path.join(dir, name)));
    if (!stillPresentRemotely) {
      fs.unlinkSync(mirrorFilePath);
      removeFile(db, spec.table, mirrorFilePath);
    }
  }

  // Prunes a stale ATTACHMENT file from the local mirror once it's gone from folderfoo's own
  // listing (e.g. trashed and never restored) — walkMarkdownFiles above deliberately can't see
  // these paths at all (that's what keeps attachments from being indexed as standalone docs), so
  // they'd otherwise never be detected as deleted and would sit in the mirror forever, making
  // AttachmentRepository.reconcileToDisk (which trusts the local mirror as truth) keep declaring
  // them as still-present on the parent doc. Unlike doc files above, an attachment is pushed under
  // its own literal filename with no remoteFilename translation/legacy-name fallback (see
  // pushAttachmentIfNeeded/writeBinaryFile) — a plain relative-path membership check is enough.
  for (const mirrorFilePath of walkAttachmentFiles(folder.mirrorDir)) {
    const relPath = path.relative(folder.mirrorDir, mirrorFilePath);
    if (!remoteRelPaths.has(relPath)) fs.unlinkSync(mirrorFilePath);
  }

  if (spec.table === 'memory_docs') {
    reconcileOrphanedAttachmentWrappers(folder.mirrorDir);
    reconcileMisindexedAttachmentRows(db, folder.mirrorDir);
  }
}

/**
 * One-time cleanup for rows indexed by a since-fixed pullFile bug: before pullFile checked
 * isUnderAttachmentsDir, an attachment saved with a .md extension (e.g. "attachment-1.md") was
 * pulled down and inserted into memory_docs as an ordinary standalone doc. Those mirror files
 * physically live under an attachments/ dir, so walkMarkdownFiles (used just above) never visits
 * them and the normal deletion-reconciliation loop can't clean up their stale rows. Sweep
 * memory_docs directly for any source_path already under this folder's mirror that falls inside an
 * attachments/ segment, and evict it — the mirror file itself is left alone (it's still a real,
 * live attachment on disk) since only its wrongful top-level index row needs to go.
 */
function reconcileMisindexedAttachmentRows(db: Database.Database, mirrorDir: string): void {
  const rows = db.prepare(`SELECT source_path FROM memory_docs WHERE source_path LIKE ?`).all(`${mirrorDir}${path.sep}%`) as Array<{
    source_path: string;
  }>;
  for (const { source_path: sourcePath } of rows) {
    const relPath = path.relative(mirrorDir, sourcePath);
    if (isUnderAttachmentsDir(relPath)) removeFile(db, 'memory_docs', sourcePath);
  }
}

/**
 * Sweeps a memory-doc mirror tree for a sibling <stem>/attachments/ wrapper directory (see
 * attachmentsDirFor) whose <stem>.md file no longer exists — left behind whenever a doc's .md file
 * is deleted out from under its wrapper WITHOUT going through MemoryRepository.delete() (which
 * already cleans this up for an in-tool delete), e.g. the .md deletion loop above reconciling a
 * remote deletion/rename, or a doc removed directly on folderfoo before this cleanup existed.
 * Catches every existing orphan on each pass, not just ones deleted in THIS run — a wrapper left
 * over from a much earlier reconcileDeletions run (before this sweep existed) gets cleaned up too.
 */
function reconcileOrphanedAttachmentWrappers(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'attachments') continue;
    const wrapperDir = path.join(dir, entry.name);
    // A wrapper dir looks like <parentDir>/<stem>/attachments/... alongside a sibling
    // <parentDir>/<stem>.md — recurse into subfolders too (a memory doc can live in a subfolder of
    // the connected remote source), then check THIS directory itself: it's an orphan if it holds
    // an attachments/ subfolder but has no matching <stem>.md sibling anymore.
    reconcileOrphanedAttachmentWrappers(wrapperDir);
    const hasAttachmentsSubdir = fs.existsSync(path.join(wrapperDir, 'attachments'));
    const hasMatchingDoc = fs.existsSync(`${wrapperDir}.md`);
    if (hasAttachmentsSubdir && !hasMatchingDoc) {
      fs.rmSync(wrapperDir, { recursive: true, force: true });
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
  const localFilename = spec.remoteFilename.toLocal(changedFile.name);
  const relPath = mirrorRelativeDir ? path.join(mirrorRelativeDir, localFilename) : localFilename;
  const mirrorPath = path.join(folder.mirrorDir, relPath);
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  fs.writeFileSync(mirrorPath, content);
  // Preserves the remote mtime on the mirror file so upsertFile's own
  // mtime-based skip check (existing.mtime_ms === parsed.mtimeMs) stays
  // meaningful on a later poll tick, rather than every mirrored file
  // always reporting "just now" and getting needlessly reprocessed.
  const mtimeDate = new Date(changedFile.mtime);
  fs.utimesSync(mirrorPath, mtimeDate, mtimeDate);
  if (!isUnderAttachmentsDir(relPath) && spec.matchesFile(mirrorPath)) upsertFile(db, spec, mirrorPath);
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
  options: { force?: boolean } = {},
  // Called when this poll discovers the stored credential is dead (refresh failed, or a second
  // 401 after refresh) — server.ts wires this to identity.clearUsername(). Without it, a dead JWT
  // (e.g. revoked server-side, or expired past its refresh window) leaves IdentityTracker still
  // reporting the OLD username as logged in forever, since nothing previously told it the
  // credential folderfoo-client.ts already gave up on and cleared. That mismatch is exactly what
  // let a remote folder keep showing as visible (isFolderVisible checks identity.current(), not
  // whether the credential still works) even though every real read/write against it was already
  // failing loudly with its own FolderfooAuthError — the folder list and the actual login state
  // silently disagreed until the user manually re-logged-in. Only called once per poll failure,
  // not per retry inside withAuth itself, since pollOne is the layer that already decides to
  // swallow-and-log rather than propagate.
  onAuthExpired?: () => void
): Promise<{ ok: boolean }> {
  try {
    const lastChanged = await getLastChanged(folder.server, credentialsBaseDir, folder.tenantId, folder.folderPath);
    const localWatermark = readLocalWatermark(folder.mirrorDir);
    // force (manual resync, or rebuild-cache) always does real work,
    // including reconcileDeletions - a user explicitly asking to resync
    // shouldn't silently no-op just because folderfoo's watermark happens
    // to equal what we last saw; the whole point of a manual resync is to
    // re-verify against the live state, not trust the cheap check alone.
    if (!options.force && lastChanged <= localWatermark) return { ok: true }; // cheap path: nothing changed since our last sync, no listing call

    // force must query since=0, not localWatermark - getChangedSince filters strictly by
    // mtime > since, so a file whose mtime happens to equal (or predate) the local watermark -
    // e.g. a rename/move on folderfoo that doesn't bump mtime, or a file that was wrongly deleted
    // locally by a prior reconcileDeletions bug while the watermark stayed put - would otherwise
    // be silently invisible to EVERY future poll, forced or not, forever. A real "force resync"
    // has to mean "re-verify everything against the live listing," matching what
    // reconcileDeletions already does unconditionally below.
    const changed = await getChangedSince(folder.server, credentialsBaseDir, folder.tenantId, folder.folderPath, options.force ? 0 : localWatermark);
    for (const file of changed) {
      await pullFile(db, spec, folder, credentialsBaseDir, file);
    }
    await reconcileDeletions(db, spec, folder, credentialsBaseDir);
    writeLocalWatermark(folder.mirrorDir, lastChanged);
    return { ok: true };
  } catch (err) {
    if (err instanceof FolderfooAuthError) {
      // Per the settled design: fail loudly per-call, but a poll tick
      // failing auth shouldn't crash the whole poller loop - the next
      // tick tries again (and any live skill_get/memory_get call against
      // this source will surface its own FolderfooAuthError directly to
      // the caller regardless of poller state).
      console.error(`[memory-bucket] ${err.message}`);
      onAuthExpired?.();
      // { ok: false } tells pollAndNotify to skip onSynced for this folder this tick — onSynced
      // (server.ts's onAttachmentSync) calls memoryRepo.get()/skillRepo.get(), which are gated by
      // isFolderNameVisible/identity.current(). Calling onAuthExpired above can flip that gate to
      // "invisible" in this exact tick, so firing onSynced right after would make a perfectly
      // real, still-on-disk doc look "not found" (a confusing symptom of the SAME auth failure,
      // not a second bug) rather than the original, more informative FolderfooAuthError.
      return { ok: false };
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
  credentialsBaseDir: string,
  // Called after every successful pollOne for a folder (interval tick, resyncNow, or resyncAll) —
  // NOT called on a failed poll, since nothing changed to reconcile against. Lets a caller layered
  // above this module (server.ts, once MemoryRepository/SkillRepository/AttachmentRepository all
  // exist) run its own post-sync work without remote-sync.ts needing to depend on those repos
  // itself — see healAttachmentsAfterSync's doc comment for what server.ts actually wires in here.
  onSynced?: (folder: RemoteFolder) => void | Promise<void>,
  // True when `folder` should actually be reached over the network right now — server.ts wires this
  // to isFolderVisible(folder, identity.current()). A folder connected under a DIFFERENT mode/user
  // than the one currently logged in (e.g. a `dev` folder left over from a previous
  // --folderfoo-mode session, while this run is `cloud`) is skipped entirely here, not just hidden
  // from tools afterward — without this, every interval tick, the startup resyncAll, and the web
  // UI's "resync all" button would all still try to reach that folder's server and throw a raw
  // fetch/ECONNREFUSED (or worse, succeed against a DIFFERENT server that happens to be listening on
  // that host:port right now) for a source nothing can currently see anyway. Defaults to "always
  // visible" so existing callers/tests that don't care about identity keep working unchanged.
  isVisible: (folder: RemoteFolder) => boolean = () => true,
  // Forwarded straight through to every pollOne call this handle makes — see pollOne's own doc
  // comment for why this exists. server.ts wires this to identity.clearUsername().
  onAuthExpired?: () => void
): RemotePollerHandle {
  const byName = new Map(remoteFolders.map((f) => [f.name, f]));

  async function pollAndNotify(folder: RemoteFolder, options?: { force?: boolean }): Promise<void> {
    const { ok } = await pollOne(db, spec, folder, credentialsBaseDir, options, onAuthExpired);
    // Matches this function's own long-standing doc comment above ("NOT called on a failed poll")
    // — previously not actually enforced, since pollOne swallowed a FolderfooAuthError internally
    // and returned normally either way, so onSynced fired even on a failed poll. Surfaced as a
    // real bug once onAuthExpired started clearing identity mid-tick (see pollOne's { ok: false }
    // comment) — onSynced's memoryRepo.get()/skillRepo.get() calls are gated by that same identity,
    // so firing it right after a just-failed poll could report a perfectly real doc as "not found".
    if (ok) await onSynced?.(folder);
  }

  const interval = setInterval(() => {
    for (const folder of remoteFolders) {
      if (!isVisible(folder)) continue;
      pollAndNotify(folder).catch((err) => console.error(`[memory-bucket] remote poll failed for ${folder.name}:`, err));
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
      if (!isVisible(folder)) throw new Error(`remote source "${folderName}" is not visible under the current login — reconnect or log in as the identity it was connected under`);
      await pollAndNotify(folder, { force: true });
    },
    resyncAll: async () => {
      for (const folder of remoteFolders) {
        if (!isVisible(folder)) continue;
        await pollAndNotify(folder, { force: true });
      }
    },
  };
}
