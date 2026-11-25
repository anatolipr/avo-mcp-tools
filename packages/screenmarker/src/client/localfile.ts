/**
 * Documents as files on this computer (".screenmarker", JSON — the same
 * content as a cloud document; ".json" files open too). Like htmlpaint:
 * with the File System Access API (Chromium) the document is bound to the
 * file it was opened from or saved to, so Save (and autosave) write it in
 * place. Elsewhere it falls back to the browser's own open dialog and a
 * download.
 */

export const EXT = '.screenmarker';

const TYPES = [{ description: 'screenmarker document', accept: { 'application/json': [EXT, '.json'] } }];

type PickerWindow = Window & {
  showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
};

type PermissionHandle = FileSystemFileHandle & {
  queryPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
};

const w = window as PickerWindow;

export const fileHandlesSupported = typeof w.showSaveFilePicker === 'function' && typeof w.showOpenFilePicker === 'function';

export function withExt(name: string): string {
  const n = name.trim().replace(/[/\\]/g, '-') || 'screenmarker';
  return /\.(screenmarker|json)$/i.test(n) ? n : n + EXT;
}

export function baseName(name: string): string {
  return name.replace(/\.(screenmarker|json)$/i, '');
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

/** Asks for a document file. Null if cancelled. The handle is null without the File System Access API. */
export async function pickFileToOpen(): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
  if (fileHandlesSupported) {
    try {
      const [handle] = await w.showOpenFilePicker!({ types: TYPES, excludeAcceptAllOption: false, multiple: false });
      return handle ? { file: await handle.getFile(), handle } : null;
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${EXT},.json,application/json`;
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? { file, handle: null } : null);
    };
    // No change event on cancel in every browser; a later pick still resolves a fresh promise.
    input.click();
  });
}

/** Asks where to save. Null if cancelled or unsupported (use downloadFile then). */
export async function pickFileToSave(suggestedName: string): Promise<FileSystemFileHandle | null> {
  if (!fileHandlesSupported) return null;
  try {
    return await w.showSaveFilePicker!({ suggestedName: withExt(suggestedName), types: TYPES });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

/** Whether we may write to the file; `ask` prompts the user (needs a click or key press). */
export async function canWrite(handle: FileSystemFileHandle, ask: boolean): Promise<boolean> {
  const h = handle as PermissionHandle;
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return ask && !!h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export async function writeFile(handle: FileSystemFileHandle, text: string): Promise<void> {
  const out = await handle.createWritable();
  await out.write(text);
  await out.close();
}

/** Fallback save: the browser downloads the document. */
export function downloadFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = withExt(name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function sameFile(a: FileSystemFileHandle | null | undefined, b: FileSystemFileHandle | null | undefined): Promise<boolean> {
  if (!a || !b) return false;
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
}
