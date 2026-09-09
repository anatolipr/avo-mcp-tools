import type { DashboardToolEntry } from './types.js';

// Mirrors screenmarker's save-load.ts pattern (format/version envelope,
// serialize/parse, Blob-download, FileReader-based read) for the same
// reason: a small self-contained JSON file a human can save, hand to
// someone else, or re-import later, with just enough validation on read to
// reject a file that isn't one of these.
const FILE_FORMAT = 'js-bridge-mcp-tool';
const FILE_VERSION = 1;

export type ToolOrigin = NonNullable<DashboardToolEntry['origin']>;

export interface ToolFile {
  format: typeof FILE_FORMAT;
  version: typeof FILE_VERSION;
  name: string;
  description: string;
  origin: ToolOrigin;
}

export function serializeTool(name: string, description: string, origin: ToolOrigin): string {
  const file: ToolFile = { format: FILE_FORMAT, version: FILE_VERSION, name, description, origin };
  return JSON.stringify(file, null, 2);
}

export function parseToolFile(json: string): ToolFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('not valid JSON');
  }
  const p = parsed as Record<string, unknown> | null;
  const origin = p?.origin as Record<string, unknown> | undefined;
  const originOk =
    !!origin &&
    ((origin.kind === 'code' && typeof origin.code === 'string') ||
      (origin.kind === 'path' && typeof origin.path === 'string'));
  if (
    typeof p !== 'object' ||
    p === null ||
    p.format !== FILE_FORMAT ||
    typeof p.name !== 'string' ||
    typeof p.description !== 'string' ||
    !originOk
  ) {
    throw new Error('not a js-bridge-mcp tool file');
  }
  return parsed as ToolFile;
}

/** Strips path separators and anything but a conservative filename charset, so a tool name with e.g. slashes can't escape the intended download location. */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'tool';
}

/** Downloads one tool as a standalone `<name>.tool.json` file — the save button on a dynamic tool's row. */
export function downloadTool(name: string, description: string, origin: ToolOrigin): void {
  const json = serializeTool(name, description, origin);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFileName(name)}.tool.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function readToolFile(file: File): Promise<ToolFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseToolFile(reader.result as string));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsText(file);
  });
}
