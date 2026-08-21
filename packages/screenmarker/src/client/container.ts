import type { Page, Shape } from './types.js';

const MAGIC = 'SMK1';
const FORMAT = 'screenmarker-container';
const VERSION = 1;

interface DocumentMeta {
  format: typeof FORMAT;
  version: typeof VERSION;
  activePageId: string;
  pages: Array<{ id: string; name: string; hasImage: boolean; shapes: Shape[] }>;
}

async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  const buf = await (await fetch(dataUrl)).arrayBuffer();
  return new Uint8Array(buf);
}

function bytesToDataUrl(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('failed to encode image'));
    reader.readAsDataURL(new Blob([bytes.slice()], { type: 'image/png' }));
  });
}

/** Serializes pages + shapes into a single `.smk` binary container Blob. */
export async function serializeContainer(pages: Page[], activePageId: string): Promise<Blob> {
  const images: Uint8Array[] = [];
  const metaPages: DocumentMeta['pages'] = [];

  for (const page of pages) {
    const hasImage = page.imageDataUrl !== null;
    if (hasImage) images.push(await dataUrlToBytes(page.imageDataUrl!));
    metaPages.push({ id: page.id, name: page.name, hasImage, shapes: page.shapes });
  }

  const meta: DocumentMeta = { format: FORMAT, version: VERSION, activePageId, pages: metaPages };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));

  const headerLen = 4 + 4 + metaBytes.length + 4;
  const imagesLen = images.reduce((sum, img) => sum + 4 + img.length, 0);
  const out = new Uint8Array(headerLen + imagesLen);
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(new TextEncoder().encode(MAGIC), offset);
  offset += 4;
  view.setUint32(offset, metaBytes.length, true);
  offset += 4;
  out.set(metaBytes, offset);
  offset += metaBytes.length;
  view.setUint32(offset, images.length, true);
  offset += 4;

  for (const img of images) {
    view.setUint32(offset, img.length, true);
    offset += 4;
    out.set(img, offset);
    offset += img.length;
  }

  return new Blob([out], { type: 'application/octet-stream' });
}

/** Parses a `.smk` binary container back into pages + activePageId. */
export async function parseContainer(buf: ArrayBuffer): Promise<{ pages: Page[]; activePageId: string }> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  function requireBytes(offset: number, length: number, what: string): void {
    if (offset + length > bytes.length) {
      throw new Error(`corrupt screenmarker file (truncated while reading ${what})`);
    }
  }

  requireBytes(0, 4, 'magic');
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== MAGIC) {
    throw new Error('not a screenmarker document file');
  }

  let offset = 4;
  requireBytes(offset, 4, 'metadata length');
  const metaLen = view.getUint32(offset, true);
  offset += 4;

  requireBytes(offset, metaLen, 'metadata');
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + metaLen))) as DocumentMeta;
  offset += metaLen;

  if (meta.format !== FORMAT || !Array.isArray(meta.pages)) {
    throw new Error('not a screenmarker document file');
  }

  requireBytes(offset, 4, 'page count');
  const pageCount = view.getUint32(offset, true);
  offset += 4;

  const images: Uint8Array[] = [];
  for (let i = 0; i < pageCount; i++) {
    requireBytes(offset, 4, `image ${i} length`);
    const imgLen = view.getUint32(offset, true);
    offset += 4;
    requireBytes(offset, imgLen, `image ${i} data`);
    images.push(bytes.subarray(offset, offset + imgLen));
    offset += imgLen;
  }

  let imageIndex = 0;
  const pages: Page[] = [];
  for (const p of meta.pages) {
    const imageDataUrl = p.hasImage ? await bytesToDataUrl(images[imageIndex++]!) : null;
    pages.push({ id: p.id, name: p.name, imageDataUrl, shapes: p.shapes });
  }

  const activePageId = pages.find((p) => p.id === meta.activePageId)?.id ?? pages[0]?.id ?? '';
  return { pages, activePageId };
}

function defaultDocumentName(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `screenmarker-${stamp}`;
}

/** Sanitizes a user-supplied filename: strips path separators/traversal and any existing .smk extension. */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, '-')
    .replace(/\.smk$/i, '')
    .trim();
}

export function promptForFileName(): string | null {
  const typed = window.prompt('File name:', defaultDocumentName());
  if (typed === null) return null;
  const cleaned = sanitizeFileName(typed);
  return cleaned || defaultDocumentName();
}
