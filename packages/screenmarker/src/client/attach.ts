import type { Point, Shape } from './types.js';
import { shapeBounds } from './render.js';

/**
 * Arrow/line ends snapped to text, tags, pictures, rectangles, and ellipses. An attached end is
 * stored as a spot on its target, in fractions of the target's box, so it
 * follows the target when it moves or is resized (and the text grows).
 */

const TEXTLIKE = new Set(['text', 'tag']);
const CONNECTORS = new Set(['arrow', 'line']);

function inside(p: Point, s: Shape): boolean {
  const b = shapeBounds(s);
  return p.x >= b.x && p.y >= b.y && p.x <= b.x + b.width && p.y <= b.y + b.height;
}

const BOXES = new Set(['picture', 'rect', 'ellipse']);

/** What an end at `p` snaps to: the topmost text or tag there, else the topmost picture, rectangle, or ellipse. */
function targetAt(p: Point, shapes: Shape[], self: string): Shape | null {
  let picture: Shape | null = null;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i]!;
    if (s.id === self || !inside(p, s)) continue;
    if (TEXTLIKE.has(s.type)) return s;
    if (BOXES.has(s.type)) picture ??= s;
  }
  return picture;
}

/**
 * Re-decides what `shape`'s ends are attached to from where they are now
 * (an end attaches to what it sits on, or comes loose). Non-connectors come
 * back unchanged.
 */
export function snapEnds(shape: Shape, shapes: Shape[]): Shape {
  if (!CONNECTORS.has(shape.type)) return shape;
  const ends = shape.points.slice(0, 2).map((p) => {
    const t = targetAt(p, shapes, shape.id);
    if (!t) return null;
    const b = shapeBounds(t);
    return { id: t.id, fx: b.width ? (p.x - b.x) / b.width : 0.5, fy: b.height ? (p.y - b.y) / b.height : 0.5 };
  });
  const next: Shape = { ...shape };
  if (ends.some(Boolean)) next.ends = [ends[0] ?? null, ends[1] ?? null];
  else delete next.ends;
  return next;
}

/** Drops a connector's attachments (snapping is off, or it was moved on its own). */
export function unsnap(shape: Shape): Shape {
  if (!shape.ends) return shape;
  const next = { ...shape };
  delete next.ends;
  return next;
}

/**
 * Moves every attached end onto its target, and forgets attachments whose
 * target is gone. Returns the same array when nothing changed.
 */
export function followAttachments(shapes: Shape[]): Shape[] {
  if (!shapes.some((s) => s.ends)) return shapes;
  const byId = new Map(shapes.map((s) => [s.id, s]));
  let changed = false;
  const next = shapes.map((s) => {
    if (!s.ends) return s;
    const points = [...s.points];
    const ends: Shape['ends'] = [s.ends[0], s.ends[1]];
    let moved = false;
    for (const i of [0, 1] as const) {
      const end = ends[i];
      if (!end) continue;
      const t = byId.get(end.id);
      if (!t) {
        ends[i] = null;
        moved = true;
        continue;
      }
      const b = shapeBounds(t);
      const p = { x: b.x + end.fx * b.width, y: b.y + end.fy * b.height };
      const cur = points[i];
      if (!cur || Math.abs(cur.x - p.x) > 0.01 || Math.abs(cur.y - p.y) > 0.01) {
        points[i] = p;
        moved = true;
      }
    }
    if (!moved) return s;
    changed = true;
    const out: Shape = { ...s, points };
    if (ends[0] || ends[1]) out.ends = ends;
    else delete out.ends;
    return out;
  });
  return changed ? next : shapes;
}
