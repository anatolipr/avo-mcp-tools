import fs from 'node:fs';
import path from 'node:path';
import { resolveWithinBase } from '../store/safe-path.js';
import { ATTACHMENT_MAX_BYTES } from '../config.js';
import type { AttachmentEntry } from './types.js';

export type DocKind = 'memory' | 'skill';

export { ATTACHMENT_MAX_BYTES };

/**
 * Skills already live one-per-directory (<skillDir>/SKILL.md), so attachments
 * sit directly in that directory. Memory docs are flat files (<id>.md) with no
 * per-doc directory, so attachments get a new sibling directory named after
 * the doc's id, alongside the existing file.
 */
export function attachmentsDirFor(docSourcePath: string, kind: DocKind): string {
  if (kind === 'skill') {
    return path.join(path.dirname(docSourcePath), 'attachments');
  }
  const dir = path.dirname(docSourcePath);
  const id = path.basename(docSourcePath, '.md');
  return path.join(dir, id, 'attachments');
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

export function guessMimeType(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function uniqueFilename(dir: string, filename: string): string {
  // Validate that the filename doesn't escape the directory
  resolveWithinBase(dir, undefined, filename);

  if (!fs.existsSync(path.join(dir, filename))) return filename;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let n = 2;
  while (fs.existsSync(path.join(dir, `${base}-${n}${ext}`))) n++;
  return `${base}-${n}${ext}`;
}

/** `dir` is the attachments directory itself, as returned by attachmentsDirFor. */
export function writeAttachmentFile(dir: string, filename: string, data: Buffer): AttachmentEntry {
  if (data.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error(`attachment "${filename}" (${data.byteLength} bytes) exceeds the ${ATTACHMENT_MAX_BYTES}-byte limit`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const finalName = uniqueFilename(dir, filename);
  const safePath = resolveWithinBase(dir, undefined, finalName);
  fs.writeFileSync(safePath, data);
  return {
    filename: finalName,
    path: path.join('attachments', finalName),
    mime_type: guessMimeType(finalName),
    size: data.byteLength,
    added_at: new Date().toISOString(),
  };
}

export function listAttachmentFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile());
}
