import type { Page } from './types.js';

const FILE_FORMAT = 'screenmarker-document';
const FILE_VERSION = 1;

export interface DocumentFile {
  format: typeof FILE_FORMAT;
  version: typeof FILE_VERSION;
  pages: Page[];
  activePageId: string;
}

export function serializeDocument(pages: Page[], activePageId: string): string {
  const file: DocumentFile = { format: FILE_FORMAT, version: FILE_VERSION, pages, activePageId };
  return JSON.stringify(file, null, 2);
}

export function parseDocument(json: string): { pages: Page[]; activePageId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('not valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>).format !== FILE_FORMAT ||
    !Array.isArray((parsed as Record<string, unknown>).pages)
  ) {
    throw new Error('not a screenmarker document file');
  }
  const file = parsed as DocumentFile;
  const activePageId =
    file.pages.find((p) => p.id === file.activePageId)?.id ?? file.pages[0]?.id ?? '';
  return { pages: file.pages, activePageId };
}

function defaultDocumentName(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `screenmarker-${stamp}`;
}

/** Sanitizes a user-supplied filename: strips path separators/traversal and any existing .json extension. */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, '-')
    .replace(/\.json$/i, '')
    .trim();
}

/** Prompts for a file name, then downloads the document. Returns false if the user cancelled the prompt. */
export function downloadDocument(pages: Page[], activePageId: string): boolean {
  const typed = window.prompt('File name:', defaultDocumentName());
  if (typed === null) return false; // user cancelled the prompt — don't save

  const cleaned = sanitizeFileName(typed);
  const name = cleaned || defaultDocumentName();

  const json = serializeDocument(pages, activePageId);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

export function readDocumentFile(file: File): Promise<{ pages: Page[]; activePageId: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseDocument(reader.result as string));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsText(file);
  });
}
