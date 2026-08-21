import type { Page } from './types.js';
import { parseContainer, promptForFileName, serializeContainer } from './container.js';

/** Prompts for a file name, then downloads the document as a `.smk` binary container. Returns false if the user cancelled the prompt. */
export async function downloadDocument(pages: Page[], activePageId: string): Promise<boolean> {
  const name = promptForFileName();
  if (name === null) return false; // user cancelled the prompt — don't save

  const blob = await serializeContainer(pages, activePageId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.smk`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

export async function readDocumentFile(file: File): Promise<{ pages: Page[]; activePageId: string }> {
  const buf = await file.arrayBuffer();
  return parseContainer(buf);
}
