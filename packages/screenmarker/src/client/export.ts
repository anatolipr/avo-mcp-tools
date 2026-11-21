import { flattenPage, flattenPagesToCanvas } from './render.js';
import type { Page, Rect } from './types.js';

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

/** Mode 1: flat image only. Multiple pages are stacked into one image, dashed-line separated. */
export async function copyImageOnly(pages: Page[], background: string | null): Promise<void> {
  const canvas = await flattenPagesToCanvas(pages, background);
  const blob = await canvasToBlob(canvas);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export async function downloadImage(pages: Page[], background: string | null): Promise<void> {
  const canvas = await flattenPagesToCanvas(pages, background);
  const blob = await canvasToBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const name = pages.length === 1 ? 'screenmarker-page' : `screenmarker-${pages.length}-pages`;
  a.download = `${name}.png`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Copies region `r` of one page (image plus annotations, flattened) to the OS clipboard. */
export async function copyRegion(page: Page, r: Rect, background: string | null): Promise<void> {
  const { canvas: full, origin } = await flattenPage(page.shapes, { background });
  const canvas = document.createElement('canvas');
  canvas.width = r.w;
  canvas.height = r.h;
  const ctx = canvas.getContext('2d')!;
  // A selection can reach past the drawn scene into the empty margin.
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, r.w, r.h);
  }
  ctx.drawImage(full, -(r.x + origin.x), -(r.y + origin.y));
  const blob = await canvasToBlob(canvas);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
