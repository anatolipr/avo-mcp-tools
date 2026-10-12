import fs from 'node:fs';
import path from 'node:path';

/**
 * Local undo for skill_* / memory_* writes: every delete moves what it removes, and every update
 * copies the previous file, into `<baseDir>/.memory-bucket-trash/<timestamp>-<reason>-<label>/`
 * next to an `origin.txt` naming the path it came from. Restoring is copying it back. Lives under
 * baseDir, outside every source folder, so nothing here is indexed, watched or pushed to a remote
 * (and sync.ts skips the directory by name for the case where baseDir itself is a source folder).
 *
 * Strictly best-effort — a failure here is logged and the write it was guarding proceeds exactly as
 * it did before the trash existed.
 */
export const TRASH_DIRNAME = '.memory-bucket-trash';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Rapid successive edits of one file (an agent applying several body_edits) keep one snapshot — the state before the burst. */
const UPDATE_SNAPSHOT_INTERVAL_MS = 60_000;

/** Days an entry is kept; MEMORY_BUCKET_TRASH_DAYS=0 (or "off") turns the trash off entirely. */
function retentionDays(): number {
  const raw = process.env.MEMORY_BUCKET_TRASH_DAYS;
  if (raw === undefined || raw === '') return 30;
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

export function trashDirFor(baseDir: string): string {
  return path.join(baseDir, TRASH_DIRNAME);
}

export function isUnderTrashDir(filePath: string): boolean {
  return filePath.split(/[/\\]/).includes(TRASH_DIRNAME);
}

let entryCounter = 0;
const lastPrunedAt = new Map<string, number>();
const lastUpdateSnapshotAt = new Map<string, number>();

function createEntryDir(baseDir: string, reason: string, sourcePath: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  // Every skill's file is SKILL.md — its directory name is what tells entries apart.
  const name = path.basename(sourcePath) === 'SKILL.md' ? path.basename(path.dirname(sourcePath)) : path.basename(sourcePath);
  const label = name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);
  const entryDir = path.join(trashDirFor(baseDir), `${stamp}-${process.pid}-${entryCounter++}-${reason}-${label}`);
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'origin.txt'), `${sourcePath}\n`);
  return entryDir;
}

/** Removes entries older than the retention window — at most once per PRUNE_INTERVAL_MS per baseDir, so a write never pays for a directory listing. */
export function pruneTrash(baseDir: string, force = false): void {
  const days = retentionDays();
  if (days === 0) return;
  const now = Date.now();
  if (!force && now - (lastPrunedAt.get(baseDir) ?? 0) < PRUNE_INTERVAL_MS) return;
  lastPrunedAt.set(baseDir, now);
  try {
    const trashDir = trashDirFor(baseDir);
    if (!fs.existsSync(trashDir)) return;
    for (const entry of fs.readdirSync(trashDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryDir = path.join(trashDir, entry.name);
      // origin.txt is written once, when the entry is created — its mtime is the entry's age.
      const stat = fs.statSync(path.join(entryDir, 'origin.txt'), { throwIfNoEntry: false }) ?? fs.statSync(entryDir);
      if (now - stat.mtimeMs > days * DAY_MS) fs.rmSync(entryDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[memory-bucket] trash prune failed:`, (err as Error).message);
  }
}

/**
 * Moves `paths` (files or directories about to be deleted) into one new trash entry. A move within
 * one filesystem is a rename — cheaper than the recursive delete it replaces; across filesystems it
 * falls back to a copy and leaves the original for the caller's own delete. Missing paths are skipped.
 */
export function moveToTrash(baseDir: string | undefined, paths: string[]): void {
  if (!baseDir || retentionDays() === 0) return;
  try {
    const existing = paths.filter((p) => fs.existsSync(p));
    if (existing.length === 0) return;
    const entryDir = createEntryDir(baseDir, 'delete', existing[0]!);
    for (const source of existing) {
      const dest = path.join(entryDir, path.basename(source));
      try {
        fs.renameSync(source, dest);
      } catch {
        fs.cpSync(source, dest, { recursive: true });
      }
    }
    pruneTrash(baseDir);
  } catch (err) {
    console.error(`[memory-bucket] could not move ${paths[0]} to trash (deleting without a copy):`, (err as Error).message);
  }
}

/** Copies a file that is about to be overwritten into a new trash entry. */
export function snapshotToTrash(baseDir: string | undefined, filePath: string): void {
  if (!baseDir || retentionDays() === 0) return;
  try {
    const now = Date.now();
    if (now - (lastUpdateSnapshotAt.get(filePath) ?? 0) < UPDATE_SNAPSHOT_INTERVAL_MS) return;
    if (!fs.existsSync(filePath)) return;
    const entryDir = createEntryDir(baseDir, 'update', filePath);
    fs.copyFileSync(filePath, path.join(entryDir, path.basename(filePath)));
    lastUpdateSnapshotAt.set(filePath, now);
    pruneTrash(baseDir);
  } catch (err) {
    console.error(`[memory-bucket] could not snapshot ${filePath} to trash (writing without a copy):`, (err as Error).message);
  }
}
