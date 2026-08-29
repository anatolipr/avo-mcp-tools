import fs from 'node:fs';
import path from 'node:path';
import { resolveWithinBase } from '../store/safe-path.js';
import { ATTACHMENT_MAX_BYTES } from '../config.js';
import type { AttachmentEntry } from './types.js';

export type DocKind = 'memory' | 'skill';

export { ATTACHMENT_MAX_BYTES };

/**
 * Skills already live one-per-directory (<skillDir>/SKILL.md), so attachments
 * sit directly in that directory. Memory docs are flat files (<filename>.md)
 * with no per-doc directory, so attachments get a new sibling directory named
 * after the doc's own filename (stem, no extension), alongside the existing file.
 */
export function attachmentsDirFor(docSourcePath: string, kind: DocKind): string {
  if (kind === 'skill') {
    return path.join(path.dirname(docSourcePath), 'attachments');
  }
  const dir = path.dirname(docSourcePath);
  const stem = path.basename(docSourcePath, '.md');
  return path.join(dir, stem, 'attachments');
}

/**
 * True when a path (relative or absolute, either separator) has an `attachments` path segment —
 * i.e. it lives inside a directory produced by attachmentsDirFor, for either doc kind. This is the
 * SINGLE source of truth for "is this file an attachment, not a real doc" — every file-discovery
 * path that walks or diffs a folder's contents (local disk scan, the fs watcher, and the remote
 * folderfoo pull/reconcile paths) must run this check before treating a `.md` file as an indexable
 * doc. Attachments have no other marker distinguishing them from a real memory/skill doc — the
 * directory convention IS the only signal — so a walker that skips this check will silently ingest
 * attachment files as standalone docs (this happened once for the remote pull path; see
 * remote-sync.ts's pullFile/reconcileDeletions).
 */
export function isUnderAttachmentsDir(relOrAbsPath: string): boolean {
  return relOrAbsPath.split(/[/\\]/).includes('attachments');
}

const MIME_BY_EXT: Record<string, string> = {
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
};

// Extensions whose content isn't meaningfully viewable as text, so an unrecognized one among
// these should stay application/octet-stream rather than fall through to the text/plain default
// below — a spreadsheet or archive rendered as raw bytes in the inline preview is just noise;
// better to leave that preview blank and let the download button be the escape hatch.
const BINARY_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.bin', '.class', '.jar',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ogg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.sqlite', '.ico',
]);

/**
 * Attachments on skills/memory docs are overwhelmingly source/config/template files (the
 * generate-crud-entity-from-plop-templates skill's .hbs templates are a typical example) —
 * extensions with no dedicated MIME_BY_EXT entry default to text/plain so the inline preview
 * (src/web/routes.ts's /view route) can actually render them, instead of application/octet-stream
 * which browsers show as a blank iframe. Recognized binary formats stay opaque via BINARY_EXTENSIONS.
 */
export function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  return BINARY_EXTENSIONS.has(ext) ? 'application/octet-stream' : 'text/plain';
}

export function uniqueFilename(dir: string, filename: string): string {
  // Validate that the filename doesn't escape the directory
  resolveWithinBase(dir, undefined, filename);

  if (!fs.existsSync(path.join(dir, filename))) return filename;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let n = 2;
  while (fs.existsSync(path.join(dir, `${base}-${n}${ext}`))) n++;
  return `${base}-${n}${ext}`;
}

/**
 * Resolves the collision-avoided final filename and builds the resulting AttachmentEntry metadata
 * — WITHOUT touching disk. Split out from writeAttachmentFile so a caller can push this same
 * entry's content to a remote (folderfoo-backed) folder before writing locally, per the "remote is
 * the source of truth" ordering (remote/write-order.ts): the collision check (`uniqueFilename`) is
 * a pure disk STAT, not a write, so it's still safe to run before any write, remote or local.
 * `dir` is the attachments directory itself, as returned by attachmentsDirFor. Deliberately omits
 * mime_type/size — kept OUT of frontmatter so it stays cheap to hand-author/edit; both are cheaply
 * re-derivable at serve time (guessMimeType(filename), fs.statSync) and neither route
 * (web/routes.ts's download/view handlers) actually trusts a stored value already.
 */
export function buildAttachmentEntry(dir: string, filename: string, data: Buffer): AttachmentEntry {
  if (data.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error(`attachment "${filename}" (${data.byteLength} bytes) exceeds the ${ATTACHMENT_MAX_BYTES}-byte limit`);
  }
  const finalName = uniqueFilename(dir, filename);
  return {
    filename: finalName,
    path: path.join('attachments', finalName),
    added_at: new Date().toISOString(),
  };
}

/** `dir` is the attachments directory itself, as returned by attachmentsDirFor. */
export function writeAttachmentFile(dir: string, filename: string, data: Buffer): AttachmentEntry {
  const entry = buildAttachmentEntry(dir, filename, data);
  fs.mkdirSync(dir, { recursive: true });
  const safePath = resolveWithinBase(dir, undefined, entry.filename);
  fs.writeFileSync(safePath, data);
  return entry;
}

export function listAttachmentFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile());
}

/**
 * Reconciles a memory doc's attachments wrapper directory after an EXTERNAL rename (the file was
 * renamed outside this tool — Finder, `mv`, another agent editing the filesystem directly — not
 * via `memory_rename`, which already moves the wrapper dir itself as part of the rename). The
 * chokidar watcher's unlink+add pair reindexes the doc's own row/search entry fine on its own (see
 * store/sync.ts), but nothing tells it the wrapper dir needs to move too — left alone, the doc's
 * declared attachments become orphaned under the OLD filename's wrapper dir forever.
 *
 * Only acts when `declaredAttachmentCount > 0` (the doc's own frontmatter says it should have
 * attachments) AND the wrapper dir this filename would now resolve to is missing. Scoped to a
 * single unambiguous case: exactly one OTHER subdirectory in the same parent contains an
 * `attachments/` folder with files but has no `<name>.md` sibling of its own (i.e. it's plausibly
 * this doc's own leftover, not some other doc's wrapper or an unrelated directory) — anything less
 * certain (zero or 2+ candidates) is left alone rather than guessing wrong.
 */
export function reconcileRenamedAttachmentsDir(docSourcePath: string, declaredAttachmentCount: number): void {
  if (declaredAttachmentCount === 0) return;
  const expectedDir = attachmentsDirFor(docSourcePath, 'memory');
  if (fs.existsSync(expectedDir)) return; // already in the right place, nothing to reconcile

  const parentDir = path.dirname(docSourcePath);
  if (!fs.existsSync(parentDir)) return;

  const candidates = fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parentDir, entry.name))
    .filter((wrapperDir) => {
      const attachmentsSubdir = path.join(wrapperDir, 'attachments');
      if (!fs.existsSync(attachmentsSubdir) || listAttachmentFiles(attachmentsSubdir).length === 0) return false;
      // Not this doc's own (already-correctly-named) wrapper, and no OTHER .md file in the parent
      // claims this wrapper dir as its own — an unclaimed wrapper is the signature of a leftover
      // from a rename, not a currently-live doc's attachments.
      const wrapperName = path.basename(wrapperDir);
      return !fs.existsSync(path.join(parentDir, `${wrapperName}.md`));
    });

  if (candidates.length !== 1) return; // ambiguous or nothing found — don't guess
  // Move the whole WRAPPER directory (candidates[0], e.g. "old-name/", which already contains its
  // own "attachments/" subfolder) to the new wrapper path (e.g. "new-name/") — not onto
  // expectedDir itself, which IS the "attachments" subfolder path one level deeper; renaming onto
  // that would double-nest the existing attachments/ subfolder inside itself.
  const expectedWrapperDir = path.dirname(expectedDir);
  fs.mkdirSync(path.dirname(expectedWrapperDir), { recursive: true });
  fs.renameSync(candidates[0]!, expectedWrapperDir);
}
