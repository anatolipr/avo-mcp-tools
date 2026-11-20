import type { Rect } from './types.js';

const CELL = 8; // grid cell size in pixels
const PIXEL_THRESHOLD = 48; // summed |ΔR|+|ΔG|+|ΔB| above which a pixel counts as changed
const CELL_MIN_PIXELS = 3; // changed pixels a cell needs (ignores lone anti-aliasing specks)
const MERGE_GAP = 2; // cells: changes this close together become one box
const PAD = 4; // pixels around each box

async function load(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

function pixels(img: HTMLImageElement, w: number, h: number, scaleToFit: boolean): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (scaleToFit) ctx.drawImage(img, 0, 0, w, h);
  else ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * Boxes around the areas where image `b` differs from image `a`, in `a`'s
 * pixel coordinates. Images of the same proportions are compared at `a`'s
 * size (e.g. the same screen captured at another zoom); otherwise their
 * overlapping top-left area is compared and anything outside it counts as
 * changed only if it falls inside `a`.
 */
export async function diffRegions(aSrc: string, bSrc: string): Promise<Rect[]> {
  const [a, b] = await Promise.all([load(aSrc), load(bSrc)]);
  const W = a.naturalWidth;
  const H = a.naturalHeight;
  const sameShape = Math.abs(W / H - b.naturalWidth / b.naturalHeight) < 0.01;
  const pa = pixels(a, W, H, false);
  const pb = pixels(b, W, H, sameShape);
  const bw = sameShape ? W : Math.min(W, b.naturalWidth);
  const bh = sameShape ? H : Math.min(H, b.naturalHeight);

  const cols = Math.ceil(W / CELL);
  const rows = Math.ceil(H / CELL);
  const count = new Uint16Array(cols * rows);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Outside b's area, a's pixels have nothing to match: changed.
      const changed =
        x >= bw ||
        y >= bh ||
        Math.abs(pa[i]! - pb[i]!) + Math.abs(pa[i + 1]! - pb[i + 1]!) + Math.abs(pa[i + 2]! - pb[i + 2]!) > PIXEL_THRESHOLD;
      if (changed) count[((y / CELL) | 0) * cols + ((x / CELL) | 0)]!++;
    }
  }
  const hot = new Uint8Array(cols * rows);
  for (let i = 0; i < hot.length; i++) hot[i] = count[i]! >= CELL_MIN_PIXELS ? 1 : 0;

  // Flood-fill connected hot cells, treating cells up to MERGE_GAP apart as connected.
  const seen = new Uint8Array(cols * rows);
  const boxes: Rect[] = [];
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start] || seen[start]) continue;
    let minC = cols;
    let minR = rows;
    let maxC = -1;
    let maxR = -1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const c = i % cols;
      const r = (i / cols) | 0;
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      for (let dr = -MERGE_GAP; dr <= MERGE_GAP; dr++) {
        for (let dc = -MERGE_GAP; dc <= MERGE_GAP; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const j = nr * cols + nc;
          if (hot[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    const x = Math.max(0, minC * CELL - PAD);
    const y = Math.max(0, minR * CELL - PAD);
    boxes.push({ x, y, w: Math.min(W, (maxC + 1) * CELL + PAD) - x, h: Math.min(H, (maxR + 1) * CELL + PAD) - y });
  }
  return mergeOverlapping(boxes);
}

/** Merges boxes that overlap (padding can make neighbors touch) until none do. */
function mergeOverlapping(boxes: Rect[]): Rect[] {
  const out = [...boxes];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        if (a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h) {
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          out[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
          out.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return out;
}
