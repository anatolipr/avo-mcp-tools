import type { Page, Point, Rect, Shape, TagArrow } from './types.js';
import { drawRich, layoutRich, LINE_HEIGHT, type RichLayout } from './richtext.js';

const DEFAULT_FONT_SIZE = 18;
const TEXT_PAD_RATIO = 0.25;

function textFont(fontSize: number): string {
  return `bold ${fontSize}px system-ui, sans-serif`;
}

export interface TextLayout {
  rich: RichLayout;
  // The text block (where lines are aligned), and the outer box (with the fill's padding).
  inner: Rect;
  box: Rect;
}

/** Where a text shape's lines go: its label laid out at its anchor, wrapped at its width if it has one. */
export function layoutText(shape: Shape): TextLayout {
  const a = shape.points[0] ?? { x: 0, y: 0 };
  const fontSize = shape.fontSize ?? DEFAULT_FONT_SIZE;
  const rich = layoutRich(shape.label ?? '', fontSize, shape.textStyle, shape.width ?? Infinity);
  const w = shape.width ?? Math.max(fontSize, rich.width);
  const h = Math.max(fontSize * LINE_HEIGHT, rich.height, shape.height ?? 0);
  const pad = shape.fill ? fontSize * TEXT_PAD_RATIO : 0;
  return { rich, inner: { x: a.x, y: a.y, w, h }, box: { x: a.x - pad, y: a.y - pad, w: w + pad * 2, h: h + pad * 2 } };
}

/** Black or white, whichever reads better on `color` (a #rrggbb hex). */
export function contrastColor(color: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return '#ffffff';
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16));
  const luminance = (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255;
  return luminance > 0.6 ? '#000000' : '#ffffff';
}

// Decoded picture-shape images by data URL. drawShape is synchronous, so
// callers await preloadPictures() before drawing; a picture whose image is
// not decoded yet is skipped for that frame.
const pictureCache = new Map<string, HTMLImageElement>();

/** Decodes every picture shape's image into the cache. */
export async function preloadPictures(shapes: Shape[]): Promise<void> {
  const pending = shapes.filter((s) => s.type === 'picture' && s.src && !pictureCache.has(s.src));
  await Promise.all(
    pending.map(async (s) => {
      try {
        pictureCache.set(s.src!, await loadImage(s.src!));
      } catch {
        // Undecodable data: the picture draws as an empty box.
      }
    })
  );
}

export const DEFAULT_MAGNIFY = 2;

/** Lens radius and source-spot radius of a magnifier, in image pixels. */
export function magnifierRadii(shape: Shape): { lens: number; source: number } {
  const lens = shape.lensRadius ?? 80;
  return { lens, source: lens / (shape.magnify ?? DEFAULT_MAGNIFY) };
}

/**
 * Callout magnifier: a ring around the spot, a connector, and a round lens
 * showing that spot enlarged. Like blur, it samples whatever is already
 * painted (the image plus shapes drawn before it).
 */
function drawMagnifier(ctx: CanvasRenderingContext2D, shape: Shape): void {
  const [s, l] = shape.points;
  if (!s || !l) return;
  const { lens: R, source: r } = magnifierRadii(shape);
  const t = ctx.getTransform();
  // Sample before drawing anything of our own, in raw canvas pixels (see pixelate).
  const sample = document.createElement('canvas');
  sample.width = Math.max(1, Math.round(R * 2));
  sample.height = sample.width;
  const sctx = sample.getContext('2d')!;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(ctx.canvas, (s.x - r) * t.a + t.e, (s.y - r) * t.d + t.f, r * 2 * t.a, r * 2 * t.d, 0, 0, sample.width, sample.height);

  const width = Math.max(2, shape.lineWidth);
  const d = Math.hypot(l.x - s.x, l.y - s.y);
  if (d > R + r) {
    const ux = (l.x - s.x) / d;
    const uy = (l.y - s.y) / d;
    ctx.beginPath();
    ctx.moveTo(s.x + ux * r, s.y + uy * r);
    ctx.lineTo(l.x - ux * R, l.y - uy * R);
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.lineWidth = width;
  ctx.stroke();

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = R * 0.25;
  ctx.beginPath();
  ctx.arc(l.x, l.y, R, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(l.x, l.y, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(sample, l.x - R, l.y - R, R * 2, R * 2);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(l.x, l.y, R, 0, Math.PI * 2);
  ctx.lineWidth = width * 1.5;
  ctx.stroke();
}

export function stepRadius(shape: Shape): number {
  return (shape.fontSize ?? DEFAULT_FONT_SIZE) * 0.85;
}

/** The normalized box spanned by a two-point shape's corners. */
function cornerBox(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function drawArrowhead(ctx: CanvasRenderingContext2D, from: Point, to: Point, lineWidth: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const headLen = 10 + lineWidth * 2.5;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6), to.y - headLen * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6), to.y - headLen * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

/**
 * Pixelates box `r` of whatever is already painted on ctx's canvas (the
 * image plus any shapes drawn before this one): downscale into a tiny
 * canvas, then scale back up with smoothing off so each source block
 * becomes one flat square.
 */
function pixelate(ctx: CanvasRenderingContext2D, r: Rect, blockSize: number): void {
  // The context may be translated (the editor and exports draw the scene
  // with its origin offset); reading back from ctx.canvas needs raw device
  // pixels, so undo that translation for the source rect only.
  const t = ctx.getTransform();
  const rx = r.x * t.a + t.e;
  const ry = r.y * t.d + t.f;
  const x = Math.max(0, Math.floor(rx));
  const y = Math.max(0, Math.floor(ry));
  const w = Math.min(ctx.canvas.width - x, Math.ceil(r.w * t.a + (rx - x)));
  const h = Math.min(ctx.canvas.height - y, Math.ceil(r.h * t.d + (ry - y)));
  blockSize *= t.a;
  if (w < 1 || h < 1) return;
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.ceil(w / blockSize));
  small.height = Math.max(1, Math.ceil(h / blockSize));
  const sctx = small.getContext('2d')!;
  sctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.restore();
}

// ---------- tags (speech-bubble callouts) ----------

export const DEFAULT_TAG_ARROW: TagArrow = 'bottom-center';

export interface TagLayout {
  box: Rect;
  tip: Point;
  // The pointer triangle's two base corners on the bubble edge; null for 'none'.
  base: [Point, Point] | null;
  rich: RichLayout;
  fontSize: number;
  padX: number;
  padY: number;
  lineHeight: number;
  radius: number;
}

/** Where a tag's bubble and pointer sit, given its tip point, text, size, and arrow position. */
export function layoutTag(shape: Shape): TagLayout {
  const fontSize = shape.fontSize ?? DEFAULT_FONT_SIZE;
  const tip = shape.points[0] ?? { x: 0, y: 0 };
  const padX = fontSize * 0.6;
  const padY = fontSize * 0.4;
  const lineHeight = fontSize * LINE_HEIGHT;
  const radius = fontSize * 0.45;
  const rich = layoutRich(shape.label || ' ', fontSize, shape.textStyle, fontSize * 16);
  const w = Math.max(fontSize * 2, rich.width + padX * 2);
  const h = Math.max(lineHeight, rich.height) + padY * 2;
  const arrow = shape.tagArrow ?? DEFAULT_TAG_ARROW;
  const base = { fontSize, padX, padY, lineHeight, radius, rich, tip };
  if (arrow === 'none') return { ...base, box: { x: tip.x, y: tip.y, w, h }, base: null };

  const len = fontSize * 0.75;
  const half = fontSize * 0.5;
  const [side, part] = arrow.split('-') as ['top' | 'right' | 'bottom' | 'left', string];
  const span = side === 'top' || side === 'bottom' ? w : h;
  const inset = Math.min(radius + half + fontSize * 0.2, span / 2);
  const along = part === 'center' ? span / 2 : part === 'left' || part === 'top' ? inset : span - inset;
  let box: Rect;
  let b: [Point, Point];
  switch (side) {
    case 'top':
      box = { x: tip.x - along, y: tip.y + len, w, h };
      b = [{ x: tip.x - half, y: box.y }, { x: tip.x + half, y: box.y }];
      break;
    case 'bottom':
      box = { x: tip.x - along, y: tip.y - len - h, w, h };
      b = [{ x: tip.x - half, y: box.y + h }, { x: tip.x + half, y: box.y + h }];
      break;
    case 'left':
      box = { x: tip.x + len, y: tip.y - along, w, h };
      b = [{ x: box.x, y: tip.y - half }, { x: box.x, y: tip.y + half }];
      break;
    case 'right':
      box = { x: tip.x - len - w, y: tip.y - along, w, h };
      b = [{ x: box.x + w, y: tip.y - half }, { x: box.x + w, y: tip.y + half }];
      break;
  }
  return { ...base, box, base: b };
}

function drawTag(ctx: CanvasRenderingContext2D, shape: Shape): void {
  const L = layoutTag(shape);
  const { box } = L;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
  ctx.shadowBlur = L.fontSize * 0.5;
  ctx.shadowOffsetY = L.fontSize * 0.12;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, L.radius);
  if (L.base) {
    ctx.moveTo(L.base[0].x, L.base[0].y);
    ctx.lineTo(L.tip.x, L.tip.y);
    ctx.lineTo(L.base[1].x, L.base[1].y);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
  const inner = box.w - L.padX * 2;
  drawRich(ctx, L.rich, { x: box.x + L.padX, y: box.y + L.padY }, inner, shape.textStyle?.align, contrastColor(shape.color));
}

/**
 * Draws one shape. `pictureShadow` (blur radius, in canvas units) gives
 * pictures a soft drop shadow, so the editor shows where each one ends.
 */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, pictureShadow = 0): void {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (shape.type) {
    case 'rect': {
      const [a, b] = shape.points;
      if (!a || !b) break;
      if (shape.fill) ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      else ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      break;
    }
    case 'ellipse': {
      const [a, b] = shape.points;
      if (!a || !b) break;
      const r = cornerBox(a, b);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      if (shape.fill) ctx.fill();
      else ctx.stroke();
      break;
    }
    case 'arrow':
    case 'line': {
      const [a, b] = shape.points;
      if (!a || !b) break;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (shape.type === 'arrow') drawArrowhead(ctx, a, b, shape.lineWidth);
      break;
    }
    case 'highlight': {
      const [a, b] = shape.points;
      if (!a || !b) break;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      break;
    }
    case 'blur': {
      const [a, b] = shape.points;
      if (!a || !b) break;
      pixelate(ctx, cornerBox(a, b), Math.max(6, shape.lineWidth * 4));
      break;
    }
    case 'pen': {
      if (shape.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(shape.points[0]!.x, shape.points[0]!.y);
      for (const pt of shape.points.slice(1)) ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      break;
    }
    case 'text': {
      if (!shape.points[0] || !shape.label) break;
      const fontSize = shape.fontSize ?? DEFAULT_FONT_SIZE;
      const L = layoutText(shape);
      if (shape.fill) {
        ctx.beginPath();
        ctx.roundRect(L.box.x, L.box.y, L.box.w, L.box.h, fontSize * 0.2);
        ctx.fill();
      }
      drawRich(ctx, L.rich, L.inner, L.inner.w, shape.textStyle?.align, shape.fill ? contrastColor(shape.color) : shape.color);
      break;
    }
    case 'tag': {
      if (shape.points[0]) drawTag(ctx, shape);
      break;
    }
    case 'magnifier': {
      drawMagnifier(ctx, shape);
      break;
    }
    case 'picture': {
      const [a, b] = shape.points;
      if (!a || !b) break;
      const r = cornerBox(a, b);
      const img = shape.src ? pictureCache.get(shape.src) : undefined;
      if (img) {
        if (pictureShadow) {
          ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
          ctx.shadowBlur = pictureShadow;
        }
        ctx.drawImage(img, r.x, r.y, r.w, r.h);
      } else {
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
      break;
    }
    case 'step': {
      const [c] = shape.points;
      if (!c) break;
      const r = stepRadius(shape);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.12);
      ctx.strokeStyle = contrastColor(shape.color);
      ctx.stroke();
      ctx.fillStyle = contrastColor(shape.color);
      const label = String(shape.stepNumber ?? 1);
      // Shrink longer numbers so 2-3 digits still fit the circle.
      ctx.font = textFont(r * (label.length <= 1 ? 1.1 : label.length === 2 ? 0.95 : 0.72));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, c.x, c.y + r * 0.06);
      break;
    }
  }
  ctx.restore();
}

export function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], pictureShadow = 0): void {
  for (const shape of shapes) drawShape(ctx, shape, pictureShadow);
}

const HIT_PADDING = 8;

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

export function shapeBounds(shape: Shape): { x: number; y: number; width: number; height: number } {
  if (shape.type === 'text') {
    const { box } = layoutText(shape);
    return { x: box.x, y: box.y, width: box.w, height: box.h };
  }
  if (shape.type === 'tag') {
    const { box, tip } = layoutTag(shape);
    const x = Math.min(box.x, tip.x);
    const y = Math.min(box.y, tip.y);
    return { x, y, width: Math.max(box.x + box.w, tip.x) - x, height: Math.max(box.y + box.h, tip.y) - y };
  }
  if (shape.type === 'magnifier') {
    const s = shape.points[0] ?? { x: 0, y: 0 };
    const l = shape.points[1] ?? s;
    const { lens, source } = magnifierRadii(shape);
    const x = Math.min(s.x - source, l.x - lens);
    const y = Math.min(s.y - source, l.y - lens);
    return { x, y, width: Math.max(s.x + source, l.x + lens) - x, height: Math.max(s.y + source, l.y + lens) - y };
  }
  if (shape.type === 'step') {
    const c = shape.points[0] ?? { x: 0, y: 0 };
    const r = stepRadius(shape);
    return { x: c.x - r, y: c.y - r, width: r * 2, height: r * 2 };
  }
  const xs = shape.points.map((p) => p.x);
  const ys = shape.points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

export function hitTestShape(shape: Shape, point: Point): boolean {
  switch (shape.type) {
    case 'rect':
    case 'ellipse':
    case 'highlight':
    case 'blur':
    case 'text':
    case 'step':
    case 'tag':
    case 'picture': {
      const b = shapeBounds(shape);
      return (
        point.x >= b.x - HIT_PADDING &&
        point.x <= b.x + b.width + HIT_PADDING &&
        point.y >= b.y - HIT_PADDING &&
        point.y <= b.y + b.height + HIT_PADDING
      );
    }
    case 'arrow':
    case 'line': {
      const [a, b] = shape.points;
      if (!a || !b) return false;
      return distanceToSegment(point, a, b) <= HIT_PADDING + shape.lineWidth / 2;
    }
    case 'magnifier': {
      const [s, l] = shape.points;
      if (!s || !l) return false;
      const { lens, source } = magnifierRadii(shape);
      return (
        Math.hypot(point.x - l.x, point.y - l.y) <= lens + HIT_PADDING ||
        Math.hypot(point.x - s.x, point.y - s.y) <= source + HIT_PADDING ||
        distanceToSegment(point, s, l) <= HIT_PADDING + shape.lineWidth / 2
      );
    }
    case 'pen': {
      for (let i = 0; i < shape.points.length - 1; i++) {
        if (distanceToSegment(point, shape.points[i]!, shape.points[i + 1]!) <= HIT_PADDING + shape.lineWidth / 2) {
          return true;
        }
      }
      return false;
    }
  }
}

/** Returns the topmost (last-drawn) shape under the point, or null. */
export function hitTestShapes(shapes: Shape[], point: Point): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitTestShape(shapes[i]!, point)) return shapes[i]!;
  }
  return null;
}

/** Shapes whose bounds intersect box `r` — the rubber-band multi-select test. */
export function shapesInRect(shapes: Shape[], r: Rect): Shape[] {
  return shapes.filter((s) => {
    const b = shapeBounds(s);
    return b.x <= r.x + r.w && b.x + b.width >= r.x && b.y <= r.y + r.h && b.y + b.height >= r.y;
  });
}

/**
 * Strokes the current path twice with the same dash pattern, phase-shifted
 * by exactly one dash length — black dashes fill the gaps left by white
 * ones (and vice versa), giving a "marching ants" zebra effect that reads
 * clearly against any background, light or dark or photographic.
 */
function strokeZebraDashes(ctx: CanvasRenderingContext2D, draw: () => void, lineWidth: number, dash: number, gap: number): void {
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([dash, gap]);

  ctx.strokeStyle = '#ffffff';
  ctx.lineDashOffset = 0;
  draw();

  ctx.strokeStyle = '#000000';
  ctx.lineDashOffset = dash;
  draw();

  ctx.restore();
}

/** `unit` is one CSS pixel in canvas pixels, so the outline stays the same on-screen weight at any zoom. */
export function drawSelectionOutline(ctx: CanvasRenderingContext2D, shape: Shape, unit = 1): void {
  const b = shapeBounds(shape);
  const pad = HIT_PADDING;
  strokeZebraDashes(
    ctx,
    () => ctx.strokeRect(b.x - pad, b.y - pad, b.width + pad * 2, b.height + pad * 2),
    1.5 * unit,
    6 * unit,
    6 * unit
  );
}

/** Zebra-dashed box with no handles — the in-progress rubber-band selection. */
export function drawMarquee(ctx: CanvasRenderingContext2D, r: Rect, unit = 1): void {
  strokeZebraDashes(ctx, () => ctx.strokeRect(r.x, r.y, r.w, r.h), 1.5 * unit, 5 * unit, 5 * unit);
}

/** Square handles (white fill, black outline) centered on each point. `size` is in canvas pixels. */
export function drawHandles(ctx: CanvasRenderingContext2D, points: Point[], size: number): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = size / 5;
  const half = size / 2;
  for (const p of points) {
    ctx.fillRect(p.x - half, p.y - half, size, size);
    ctx.strokeRect(p.x - half, p.y - half, size, size);
  }
  ctx.restore();
}

/** The 8 resize-handle positions (corners + edge midpoints) of a box. */
export function boxHandlePoints(r: Rect): Point[] {
  const pts: Point[] = [];
  for (const hx of [r.x, r.x + r.w / 2, r.x + r.w]) {
    for (const hy of [r.y, r.y + r.h / 2, r.y + r.h]) {
      if (hx === r.x + r.w / 2 && hy === r.y + r.h / 2) continue;
      pts.push({ x: hx, y: hy });
    }
  }
  return pts;
}

/**
 * Region-select overlay: dims everything outside the region, outlines it
 * with zebra dashes, and draws eight resize handles. `handleSize` is in
 * canvas pixels so callers can keep handles a constant on-screen size
 * regardless of zoom / devicePixelRatio.
 */
export function drawRegionOverlay(ctx: CanvasRenderingContext2D, r: Rect, handleSize: number, area: Rect): void {
  const right = area.x + area.w;
  const bottom = area.y + area.h;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(area.x, area.y, area.w, r.y - area.y);
  ctx.fillRect(area.x, r.y + r.h, area.w, bottom - r.y - r.h);
  ctx.fillRect(area.x, r.y, r.x - area.x, r.h);
  ctx.fillRect(r.x + r.w, r.y, right - r.x - r.w, r.h);
  ctx.restore();

  const lineWidth = handleSize / 5;
  strokeZebraDashes(ctx, () => ctx.strokeRect(r.x, r.y, r.w, r.h), lineWidth, lineWidth * 4, lineWidth * 4);
  drawHandles(ctx, boxHandlePoints(r), handleSize);
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return img;
}

/** A picture's image decoded, for its natural (own pixel) size. */
export function decodePicture(src: string): Promise<HTMLImageElement> {
  return loadImage(src);
}

/**
 * Cuts picture `shape` down to where it overlaps `r` (page coordinates):
 * its image is cropped to match, so it keeps its scale. Null when they do
 * not overlap.
 */
export async function cropPicture(shape: Shape, r: Rect): Promise<Shape | null> {
  const b = shapeBounds(shape);
  const x1 = Math.max(b.x, r.x);
  const y1 = Math.max(b.y, r.y);
  const x2 = Math.min(b.x + b.width, r.x + r.w);
  const y2 = Math.min(b.y + b.height, r.y + r.h);
  if (x2 - x1 < 1 || y2 - y1 < 1 || !shape.src || !b.width || !b.height) return null;
  const img = await loadImage(shape.src);
  const sx = img.naturalWidth / b.width;
  const sy = img.naturalHeight / b.height;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((x2 - x1) * sx));
  canvas.height = Math.max(1, Math.round((y2 - y1) * sy));
  canvas.getContext('2d')!.drawImage(img, -(x1 - b.x) * sx, -(y1 - b.y) * sy);
  return { ...shape, src: canvas.toDataURL('image/png'), points: [{ x: x1, y: y1 }, { x: x2, y: y2 }] };
}

/** Rotates or flips picture `shape`'s image, and its box about its center. */
export async function transformPicture(shape: Shape, transform: ImageTransform): Promise<Shape> {
  if (!shape.src) return shape;
  const { dataUrl } = await transformImageDataUrl(shape.src, transform);
  const b = shapeBounds(shape);
  const rotates = transform === 'rotate-cw' || transform === 'rotate-ccw';
  const w = rotates ? b.height : b.width;
  const h = rotates ? b.width : b.height;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return { ...shape, src: dataUrl, points: [{ x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy + h / 2 }] };
}

export type ImageTransform = 'rotate-cw' | 'rotate-ccw' | 'flip-h' | 'flip-v';

/** Rotates or flips the background image only; returns the new data URL and its size. */
export async function transformImageDataUrl(
  imageDataUrl: string,
  transform: ImageTransform
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(imageDataUrl);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const rotates = transform === 'rotate-cw' || transform === 'rotate-ccw';
  const canvas = document.createElement('canvas');
  canvas.width = rotates ? H : W;
  canvas.height = rotates ? W : H;
  const ctx = canvas.getContext('2d')!;
  switch (transform) {
    case 'rotate-cw':
      ctx.setTransform(0, 1, -1, 0, H, 0);
      break;
    case 'rotate-ccw':
      ctx.setTransform(0, -1, 1, 0, 0, W);
      break;
    case 'flip-h':
      ctx.setTransform(-1, 0, 0, 1, W, 0);
      break;
    case 'flip-v':
      ctx.setTransform(1, 0, 0, -1, 0, H);
      break;
  }
  ctx.drawImage(img, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

/** Maps one point through the same transform transformImageDataUrl applies to an image of size W×H. */
export function transformPoint(p: Point, transform: ImageTransform, W: number, H: number): Point {
  switch (transform) {
    case 'rotate-cw':
      return { x: H - p.y, y: p.x };
    case 'rotate-ccw':
      return { x: p.y, y: W - p.x };
    case 'flip-h':
      return { x: W - p.x, y: p.y };
    case 'flip-v':
      return { x: p.x, y: H - p.y };
  }
}

/**
 * Moves a shape along with its image under `transform`. Text stays
 * upright, so its anchor is re-derived from the transformed center of its
 * box (mapping the top-left corner directly would shift the label).
 */
export function transformShape(shape: Shape, transform: ImageTransform, W: number, H: number): Shape {
  if (shape.type === 'text') {
    const b = shapeBounds(shape);
    const a = shape.points[0]!;
    const c = transformPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, transform, W, H);
    // Offset from box center back to the anchor is unchanged by an upright move.
    const ox = a.x - (b.x + b.width / 2);
    const oy = a.y - (b.y + b.height / 2);
    return { ...shape, points: [{ x: c.x + ox, y: c.y + oy }] };
  }
  if (shape.type === 'picture') {
    // A picture moves with the page but stays upright and unmirrored, at its own size.
    const b = shapeBounds(shape);
    const c = transformPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, transform, W, H);
    return {
      ...shape,
      points: [
        { x: c.x - b.width / 2, y: c.y - b.height / 2 },
        { x: c.x + b.width / 2, y: c.y + b.height / 2 },
      ],
    };
  }
  return { ...shape, points: shape.points.map((p) => transformPoint(p, transform, W, H)) };
}

/**
 * The page's content box: every shape, pictures included, with room for
 * what draws past a shape's points. Integer-aligned; empty for no shapes.
 */
export function sceneBounds(shapes: Shape[]): Rect {
  if (!shapes.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const s of shapes) {
    const b = shapeBounds(s);
    // Room for what draws past a shape's points: a tag's pointer, an arrowhead's wings, a lens shadow.
    const pad =
      s.type === 'tag'
        ? (s.fontSize ?? DEFAULT_FONT_SIZE) * 0.6
        : s.type === 'arrow'
          ? s.lineWidth / 2 + 12 + s.lineWidth * 2.5
          : s.type === 'magnifier'
            ? magnifierRadii(s).lens * 0.3
            : s.type === 'picture'
              ? 0
              : s.lineWidth / 2 + 2;
    x1 = Math.min(x1, b.x - pad);
    y1 = Math.min(y1, b.y - pad);
    x2 = Math.max(x2, b.x + b.width + pad);
    y2 = Math.max(y2, b.y + b.height + pad);
  }
  x1 = Math.floor(x1);
  y1 = Math.floor(y1);
  return { x: x1, y: y1, w: Math.ceil(x2) - x1, h: Math.ceil(y2) - y1 };
}

export interface FlattenOptions {
  background?: string | null;
  sceneShapes?: Shape[];
  centered?: boolean;
  // With `centered`: center on this point (a page's saved view) instead of the images.
  center?: Point;
  // Canvas pixels per page pixel (2 renders text-only slides crisply on HiDPI screens).
  pixelRatio?: number;
  // Exactly this box of the page, instead of one sized by the content.
  area?: Rect;
}

/** Every picture on the page (or, with none, all its content): what a slide centers on. Integer-aligned. */
export function focusBounds(shapes: Shape[]): Rect {
  const pictures = shapes.filter((s) => s.type === 'picture');
  if (!pictures.length) return sceneBounds(shapes);
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const s of pictures) {
    const b = shapeBounds(s);
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  x1 = Math.floor(x1);
  y1 = Math.floor(y1);
  return { x: x1, y: y1, w: Math.ceil(x2) - x1, h: Math.ceil(y2) - y1 };
}

/** Outside the image, exported pages are white rather than transparent, so pasted results read the same everywhere. */
const SCENE_BACKGROUND = '#ffffff';

/**
 * Renders a page's shapes (pictures and annotations) to a canvas covering
 * its full scene. `origin` is where page (0, 0) landed, for callers that
 * need to map page coordinates (e.g. a region) onto the result.
 * `background` fills the scene behind the content; `null` leaves it
 * transparent. `sceneShapes`
 * sizes the scene when it should cover more than the shapes drawn (reveal
 * steps keep one size while shapes are hidden). `centered` grows the scene
 * evenly on both sides so the image and pictures (`focus`) sit in its middle:
 * slides keep them in place wherever the tags go.
 */
export async function flattenPage(
  shapes: Shape[],
  { background = SCENE_BACKGROUND, sceneShapes = shapes, centered = false, center, pixelRatio = 1, area: fixedArea }: FlattenOptions = {}
): Promise<{ canvas: HTMLCanvasElement; origin: Point; focus: Rect }> {
  await preloadPictures(shapes);
  let area = sceneBounds(sceneShapes);
  const focus = focusBounds(sceneShapes);
  if (fixedArea) {
    area = fixedArea;
  } else if (centered && center) {
    const cx = Math.round(center.x);
    const cy = Math.round(center.y);
    const dx = Math.max(cx - area.x, area.x + area.w - cx);
    const dy = Math.max(cy - area.y, area.y + area.h - cy);
    area = { x: cx - dx, y: cy - dy, w: 2 * dx, h: 2 * dy };
  } else if (centered) {
    const dx = Math.max(focus.x - area.x, area.x + area.w - (focus.x + focus.w));
    const dy = Math.max(focus.y - area.y, area.y + area.h - (focus.y + focus.h));
    area = { x: focus.x - dx, y: focus.y - dy, w: focus.w + 2 * dx, h: focus.h + 2 * dy };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(area.w * pixelRatio));
  canvas.height = Math.max(1, Math.round(area.h * pixelRatio));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(pixelRatio, pixelRatio);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, area.w, area.h);
  }
  ctx.translate(-area.x, -area.y);
  drawShapes(ctx, shapes);
  return { canvas, origin: { x: -area.x, y: -area.y }, focus };
}

export async function flattenToCanvas(shapes: Shape[], background: string | null = SCENE_BACKGROUND): Promise<HTMLCanvasElement> {
  return (await flattenPage(shapes, { background })).canvas;
}

const SEPARATOR_LINE_WIDTH = 3;

/**
 * Stacks each page's flattened image vertically, one directly under the
 * other (no gap), with a zebra-dashed line drawn right at each seam — so
 * multiple annotated pages become one pasteable image, and the separator
 * reads clearly against any page content instead of needing a plain-white
 * buffer around it. Empty pages are skipped. `background` fills
 * outside the images (null: transparent).
 */
export async function flattenPagesToCanvas(pages: Page[], background: string | null = SCENE_BACKGROUND): Promise<HTMLCanvasElement> {
  const withContent = pages.filter((p) => p.shapes.length > 0);
  if (withContent.length === 0) throw new Error('no pages with content');

  const flattened = await Promise.all(withContent.map((p) => flattenToCanvas(p.shapes, background)));

  if (flattened.length === 1) return flattened[0]!;

  const width = Math.max(...flattened.map((c) => c.width));
  const height = flattened.reduce((sum, c) => sum + c.height, 0);

  const combined = document.createElement('canvas');
  combined.width = width;
  combined.height = height;
  const ctx = combined.getContext('2d')!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  let y = 0;
  flattened.forEach((c, i) => {
    ctx.drawImage(c, 0, y);
    y += c.height;

    if (i < flattened.length - 1) {
      strokeZebraDashes(
        ctx,
        () => {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        },
        SEPARATOR_LINE_WIDTH,
        10,
        10
      );
    }
  });

  return combined;
}
