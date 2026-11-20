import { flattenPage } from './render.js';
import type { Page } from './types.js';

/**
 * Small rendered previews of pages (image + annotations), for the page
 * strip and the Recent list. Pages are immutable — every edit replaces the
 * Page object — so caching by object identity is exact: an edited page is
 * a new key and gets a fresh thumbnail, and old ones are collected.
 */
const cache = new WeakMap<Page, Promise<string | null>>();

export function pageThumbnail(page: Page, maxSide = 180, type = 'image/png'): Promise<string | null> {
  let hit = cache.get(page);
  if (!hit) {
    hit = render(page, maxSide, type);
    cache.set(page, hit);
  }
  return hit;
}

async function render(page: Page, maxSide: number, type: string): Promise<string | null> {
  if (!page.imageDataUrl) return null;
  const { canvas } = await flattenPage(page.imageDataUrl, page.shapes);
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL(type, 0.8);
}

// Recent-document thumbnails live in this browser only (localStorage), keyed
// by cloud document name and written on each cloud save — reading every
// document's full JSON just to draw a preview would be far too heavy.
const RECENT_THUMBS_KEY = 'screenmarker_recent_thumbs';
const MAX_RECENT_THUMBS = 40;

type ThumbMap = Record<string, { url: string; at: number }>;

function readThumbs(): ThumbMap {
  try {
    return JSON.parse(localStorage.getItem(RECENT_THUMBS_KEY) ?? '{}') as ThumbMap;
  } catch {
    return {};
  }
}

export function recentThumbnail(name: string): string | null {
  return readThumbs()[name]?.url ?? null;
}

export async function rememberRecentThumbnail(name: string, page: Page | undefined): Promise<void> {
  if (!page) return;
  try {
    const url = await pageThumbnail(page, 320, 'image/jpeg');
    if (!url) return;
    const map = readThumbs();
    map[name] = { url, at: Date.now() };
    const keep = Object.entries(map)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_RECENT_THUMBS);
    localStorage.setItem(RECENT_THUMBS_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // quota / blocked storage: previews are a nicety
  }
}
