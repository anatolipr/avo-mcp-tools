import fs from 'node:fs';
import path from 'node:path';

/** Suffix of the temp file writeFileAtomic stages its content in — the watcher and every directory walk skip it (see sync.ts's isIgnoredFile). */
export const ATOMIC_TMP_SUFFIX = '.mbtmp';

export function isAtomicTempFile(filePath: string): boolean {
  return filePath.endsWith(ATOMIC_TMP_SUFFIX);
}

let tmpCounter = 0;

/**
 * Writes `data` to `filePath` so a crash or power loss mid-write leaves either the old content or
 * the new, never a truncated file: the bytes go to a temp file in the same directory, are fsynced,
 * then renamed over the target. Markdown docs, the config file and the credentials file are the
 * source of truth (the SQLite cache is rebuilt from them), so a torn write there loses real data.
 *
 * Never fails where a plain fs.writeFileSync would have succeeded — anything the atomic path
 * cannot do safely falls back to writing in place: a hard-linked file (a rename would detach the
 * other links), a dangling symlink, a directory that allows writing the file but not creating one.
 * A symlink is written through to its target, as before, rather than replaced by a regular file.
 * An existing file keeps its permission bits; `mode` applies to a new file, and overrides them.
 */
export function writeFileAtomic(filePath: string, data: string | Buffer, opts: { mode?: number } = {}): void {
  let tmpPath: string | undefined;
  try {
    let target = filePath;
    let existingMode: number | undefined;
    const linkStat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (linkStat) {
      if (linkStat.isSymbolicLink()) target = fs.realpathSync(filePath);
      const stat = linkStat.isSymbolicLink() ? fs.statSync(target) : linkStat;
      if (!stat.isFile() || stat.nlink > 1) throw new Error('not a plain single-link file');
      existingMode = stat.mode & 0o777;
    }
    const mode = opts.mode ?? existingMode;
    tmpPath = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${tmpCounter++}${ATOMIC_TMP_SUFFIX}`);
    const fd = fs.openSync(tmpPath, 'wx', mode ?? 0o666);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // open() masks the requested mode with the process umask — restore the exact bits.
    if (mode !== undefined) fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, target);
  } catch {
    if (tmpPath) fs.rmSync(tmpPath, { force: true });
    fs.writeFileSync(filePath, data, opts.mode !== undefined ? { mode: opts.mode } : undefined);
  }
}
