import type { Page, Point, Shape } from './types.js';

function drawArrowhead(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, lineWidth: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const headLen = 10 + lineWidth * 2.5;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6), to.y - headLen * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6), to.y - headLen * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
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
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      break;
    }
    case 'arrow': {
      const [a, b] = shape.points;
      if (!a || !b) break;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      drawArrowhead(ctx, a, b, shape.lineWidth);
      break;
    }
    case 'highlight': {
      const [a, b] = shape.points;
      if (!a || !b) break;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
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
      const [a] = shape.points;
      if (!a || !shape.label) break;
      ctx.font = `bold ${shape.fontSize ?? 18}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(shape.label, a.x, a.y);
      break;
    }
  }
  ctx.restore();
}

export function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[]): void {
  for (const shape of shapes) drawShape(ctx, shape);
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
  const xs = shape.points.map((p) => p.x);
  const ys = shape.points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  if (shape.type === 'text') {
    const fontSize = shape.fontSize ?? 18;
    const width = Math.max(40, (shape.label?.length ?? 8) * fontSize * 0.6);
    return { x: minX, y: minY, width, height: fontSize * 1.3 };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function hitTestShape(shape: Shape, point: Point): boolean {
  switch (shape.type) {
    case 'rect':
    case 'highlight':
    case 'text': {
      const b = shapeBounds(shape);
      return (
        point.x >= b.x - HIT_PADDING &&
        point.x <= b.x + b.width + HIT_PADDING &&
        point.y >= b.y - HIT_PADDING &&
        point.y <= b.y + b.height + HIT_PADDING
      );
    }
    case 'arrow': {
      const [a, b] = shape.points;
      if (!a || !b) return false;
      return distanceToSegment(point, a, b) <= HIT_PADDING;
    }
    case 'pen': {
      for (let i = 0; i < shape.points.length - 1; i++) {
        if (distanceToSegment(point, shape.points[i]!, shape.points[i + 1]!) <= HIT_PADDING) return true;
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

export function drawSelectionOutline(ctx: CanvasRenderingContext2D, shape: Shape): void {
  const b = shapeBounds(shape);
  const x = b.x - HIT_PADDING;
  const y = b.y - HIT_PADDING;
  const w = b.width + HIT_PADDING * 2;
  const h = b.height + HIT_PADDING * 2;
  strokeZebraDashes(ctx, () => ctx.strokeRect(x, y, w, h), 1.5, 6, 6);
}

export function drawImageSelectionOutline(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const inset = 3;
  strokeZebraDashes(
    ctx,
    () => ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2),
    3,
    10,
    10
  );
}

export async function flattenToCanvas(imageDataUrl: string, shapes: Shape[]): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = imageDataUrl;
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  drawShapes(ctx, shapes);
  return canvas;
}

const SEPARATOR_LINE_WIDTH = 3;

/**
 * Stacks each page's flattened image vertically, one directly under the
 * other (no gap), with a zebra-dashed line drawn right at each seam — so
 * multiple annotated pages become one pasteable image, and the separator
 * reads clearly against any page content instead of needing a plain-white
 * buffer around it. Pages without an image are skipped.
 */
export async function flattenPagesToCanvas(pages: Page[]): Promise<HTMLCanvasElement> {
  const withImages = pages.filter((p): p is Page & { imageDataUrl: string } => p.imageDataUrl !== null);
  if (withImages.length === 0) throw new Error('no pages with an image');

  const flattened = await Promise.all(withImages.map((p) => flattenToCanvas(p.imageDataUrl, p.shapes)));

  if (flattened.length === 1) return flattened[0]!;

  const width = Math.max(...flattened.map((c) => c.width));
  const height = flattened.reduce((sum, c) => sum + c.height, 0);

  const combined = document.createElement('canvas');
  combined.width = width;
  combined.height = height;
  const ctx = combined.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

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
