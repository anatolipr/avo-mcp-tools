import { flattenPagesToCanvas } from './render.js';
import type { Page } from './types.js';

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

/** Mode 1: flat image only. Multiple pages are stacked into one image, dashed-line separated. */
export async function copyImageOnly(pages: Page[]): Promise<void> {
  const canvas = await flattenPagesToCanvas(pages);
  const blob = await canvasToBlob(canvas);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export async function downloadImage(pages: Page[]): Promise<void> {
  const canvas = await flattenPagesToCanvas(pages);
  const blob = await canvasToBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const name = pages.length === 1 ? 'screenmarker-page' : `screenmarker-${pages.length}-pages`;
  a.download = `${name}.png`;
  a.click();
  URL.revokeObjectURL(url);
}
