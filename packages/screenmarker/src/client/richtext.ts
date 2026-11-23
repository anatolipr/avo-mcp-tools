import type { Point, TextFont, TextStyle } from './types.js';

/**
 * Rich text for text boxes and tags. A label is plain text with a small
 * Markdown subset, drawn formatted on the canvas:
 *
 * - inline: **bold**, *italic*, __underline__, ~~strike~~, `code`; a
 *   backslash escapes a marker (\*)
 * - line starts: "# ", "## ", "### " headings; "- " or "* " bullets (indent
 *   with two spaces per level); "1. " numbered items; "[ ] " / "[x] " checkboxes
 *
 * The shape's TextStyle sets the base (bold, italic, underline, font, align)
 * for the whole label. Lines wrap at word boundaries when a width is given.
 */

export const FONT_FAMILIES: Record<TextFont, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, Menlo, Consolas, monospace',
  hand: '"Segoe Print", "Bradley Hand", "Chalkboard SE", "Comic Sans MS", cursive',
};

export const FONT_LABELS: Record<TextFont, string> = { sans: 'Sans', serif: 'Serif', mono: 'Mono', hand: 'Hand' };

/** Line height as a multiple of the line's font size. */
export const LINE_HEIGHT = 1.2;

interface Marks {
  bold: boolean;
  // **bold** inside an already-bold label: an extra-heavy weight so it still stands out.
  heavy?: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
}

export interface Run extends Marks {
  text: string;
  font: string;
  size: number;
  x: number;
  width: number;
}

export interface RichLine {
  runs: Run[];
  // Bullet / number / checkbox drawn in the gutter before the first line of an item.
  marker: { text: string; x: number; font: string } | null;
  // x of the text start (after indent and marker), relative to the line's left edge.
  indent: number;
  width: number;
  size: number;
  height: number;
  y: number;
}

export interface RichLayout {
  lines: RichLine[];
  width: number;
  height: number;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

export function cssFont(size: number, style: TextStyle | undefined, marks?: Partial<Marks>): string {
  const bold = marks?.bold ?? style?.bold ?? true;
  const italic = marks?.italic ?? style?.italic ?? false;
  const family = marks?.code ? FONT_FAMILIES.mono : FONT_FAMILIES[style?.font ?? 'sans'];
  return `${italic ? 'italic ' : ''}${marks?.heavy ? '900' : bold ? 'bold' : 'normal'} ${size}px ${family}`;
}

const INLINE_MARKERS = ['**', '__', '~~', '`', '*'] as const;
type Marker = (typeof INLINE_MARKERS)[number];
const MARK_OF: Record<Marker, Exclude<keyof Marks, 'heavy'>> = { '**': 'bold', __: 'underline', '~~': 'strike', '`': 'code', '*': 'italic' };

/** Whether `m` at `i` can close: it follows a non-space character. */
function canClose(text: string, i: number): boolean {
  return i > 0 && !/\s/.test(text[i - 1]!);
}

/** Whether `m` at `i` opens a span: a non-space follows, and a closing `m` comes later on the line. */
function canOpen(text: string, i: number, m: string): boolean {
  const after = text[i + m.length];
  if (!after || (m !== '`' && /\s/.test(after))) return false;
  for (let j = text.indexOf(m, i + m.length + 1); j !== -1; j = text.indexOf(m, j + 1)) {
    if (m === '`' || canClose(text, j)) return true;
  }
  return false;
}

/** Splits one line into styled pieces. Markers that do not form a span (see canOpen) are literal text. */
function parseInline(text: string, base: Marks): { text: string; marks: Marks }[] {
  const out: { text: string; marks: Marks }[] = [];
  const marks = { ...base };
  const open = new Set<Marker>();
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, marks: { ...marks } });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && '*_~`\\'.includes(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    const m = INLINE_MARKERS.find((mk) => text.startsWith(mk, i) && (!marks.code || mk === '`'));
    if (m) {
      const closing = open.has(m) && (m === '`' || canClose(text, i));
      if (closing || (!open.has(m) && canOpen(text, i, m))) {
        flush();
        const key = MARK_OF[m];
        if (closing) {
          open.delete(m);
          marks[key] = !!base[key];
          if (key === 'bold') marks.heavy = false;
        } else {
          open.add(m);
          marks[key] = true;
          if (key === 'bold' && base.bold) marks.heavy = true;
        }
        i += m.length;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

interface Block {
  pieces: { text: string; marks: Marks }[];
  size: number;
  level: number;
  marker: string | null;
}

function parseBlock(line: string, fontSize: number, base: Marks, plain: boolean): Block {
  if (plain) return { pieces: [{ text: line, marks: base }], size: fontSize, level: 0, marker: null };
  let m = /^(#{1,3})\s+(.*)$/.exec(line);
  if (m) {
    const size = fontSize * [1.8, 1.45, 1.2][m[1]!.length - 1]!;
    return { pieces: parseInline(m[2]!, { ...base, bold: true }), size, level: 0, marker: null };
  }
  m = /^(\s*)(?:[-*]\s+)?\[( |x|X)\]\s+(.*)$/.exec(line);
  if (m) {
    const done = m[2] !== ' ';
    return {
      pieces: parseInline(m[3]!, { ...base, strike: base.strike || done }),
      size: fontSize,
      level: Math.floor(m[1]!.length / 2),
      marker: done ? '☑' : '☐',
    };
  }
  m = /^(\s*)[-*•]\s+(.*)$/.exec(line);
  if (m) {
    const level = Math.floor(m[1]!.length / 2);
    return { pieces: parseInline(m[2]!, base), size: fontSize, level, marker: ['•', '◦', '▪'][level % 3]! };
  }
  m = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
  if (m) return { pieces: parseInline(m[3]!, base), size: fontSize, level: Math.floor(m[1]!.length / 2), marker: m[2]! };
  return { pieces: parseInline(line, base), size: fontSize, level: 0, marker: null };
}

const cache = new Map<string, RichLayout>();

/**
 * Lays out `label` in lines and runs. `maxWidth` wraps lines (Infinity: only
 * explicit newlines break). `plain` skips Markdown (the raw text, as typed).
 * Positions are relative to the block's top-left; alignment is applied
 * against `alignWidth` (default: the widest line).
 */
export function layoutRich(label: string, fontSize: number, style: TextStyle | undefined, maxWidth = Infinity, plain = false): RichLayout {
  const key = `${fontSize}|${maxWidth}|${plain ? 1 : 0}|${style?.bold}|${style?.italic}|${style?.underline}|${style?.font}|${label}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const base: Marks = { bold: style?.bold ?? true, italic: !!style?.italic, underline: !!style?.underline, strike: false, code: false };
  const lines: RichLine[] = [];
  let y = 0;
  for (const raw of label.split('\n')) {
    const block = parseBlock(raw, fontSize, base, plain);
    const size = block.size;
    const markerFont = cssFont(size, style, { bold: base.bold, italic: false });
    const gutter = block.marker ? Math.max(size * 1.1, measure(block.marker, markerFont) + size * 0.4) : 0;
    const indent = block.level * size * 1.2 + gutter;
    const avail = Math.max(size * 2, maxWidth - indent);
    // Words keep their styling; whitespace tokens let lines break.
    const tokens: { text: string; marks: Marks; font: string; size: number }[] = [];
    for (const p of block.pieces) {
      const pieceSize = p.marks.code ? size * 0.9 : size;
      const font = cssFont(pieceSize, style, p.marks);
      for (const t of p.text.split(/(\s+)/)) if (t) tokens.push({ text: t, marks: p.marks, font, size: pieceSize });
    }
    let runs: Run[] = [];
    let x = 0;
    let first = true;
    const push = () => {
      // Trailing spaces don't count toward the width.
      while (runs.length && !runs[runs.length - 1]!.text.trim()) x -= runs.pop()!.width;
      const last = runs[runs.length - 1];
      if (last && last.text !== last.text.trimEnd()) {
        last.text = last.text.trimEnd();
        last.width = measure(last.text, last.font);
        x = last.x + last.width;
      }
      lines.push({
        runs,
        marker: first && block.marker ? { text: block.marker, x: block.level * size * 1.2, font: markerFont } : null,
        indent,
        width: indent + Math.max(0, x),
        size,
        height: size * LINE_HEIGHT,
        y,
      });
      y += size * LINE_HEIGHT;
      runs = [];
      x = 0;
      first = false;
    };
    for (const t of tokens) {
      const space = !t.text.trim();
      if (space && !runs.length && !first) continue;
      const w = measure(t.text, t.font);
      if (!space && runs.length && x + w > avail) {
        push();
      }
      // Merge with the previous run when the styling matches (fewer fillText calls).
      const prev = runs[runs.length - 1];
      if (prev && prev.font === t.font && sameMarks(prev, t.marks)) {
        prev.text += t.text;
        prev.width = measure(prev.text, prev.font);
        x = prev.x + prev.width;
      } else {
        runs.push({ ...t.marks, text: t.text, font: t.font, size: t.size, x, width: w });
        x += w;
      }
    }
    push();
  }
  const layout = { lines, width: Math.max(0, ...lines.map((l) => l.width)), height: y };
  if (cache.size > 400) cache.clear();
  cache.set(key, layout);
  return layout;
}

function sameMarks(a: Marks, b: Marks): boolean {
  return a.bold === b.bold && !!a.heavy === !!b.heavy && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.code === b.code;
}

/** Draws a layout with its top-left at `at`, lines aligned within `boxWidth`. */
export function drawRich(ctx: CanvasRenderingContext2D, layout: RichLayout, at: Point, boxWidth: number, align: TextStyle['align'], color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.textBaseline = 'middle';
  for (const line of layout.lines) {
    const shift = align === 'center' ? (boxWidth - line.width) / 2 : align === 'right' ? boxWidth - line.width : 0;
    const left = at.x + Math.max(0, shift);
    const mid = at.y + line.y + line.height / 2;
    if (line.marker) {
      ctx.font = line.marker.font;
      ctx.fillText(line.marker.text, left + line.marker.x, mid);
    }
    for (const r of line.runs) {
      const x = left + line.indent + r.x;
      if (r.code) {
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.beginPath();
        ctx.roundRect(x - r.size * 0.15, mid - r.size * 0.65, r.width + r.size * 0.3, r.size * 1.3, r.size * 0.2);
        ctx.fill();
        ctx.restore();
      }
      ctx.font = r.font;
      ctx.fillText(r.text, x, mid);
      const thick = Math.max(1, r.size / 14);
      if (r.underline) ctx.fillRect(x, mid + r.size * 0.45, r.width, thick);
      if (r.strike) ctx.fillRect(x, mid - thick / 2 + r.size * 0.02, r.width, thick);
    }
  }
  ctx.restore();
}
