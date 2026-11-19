import { LitElement, html } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import { live } from 'lit/directives/live.js';
import { SignalWatcher } from 'avosignals';
import { AnnotatorStore, makeId, type ShapeStyle } from './store.js';
import {
  boxHandlePoints,
  contrastColor,
  cropImageDataUrl,
  drawHandles,
  drawImageSelectionOutline,
  drawMarquee,
  drawRegionOverlay,
  drawSelectionOutline,
  drawShapes,
  flattenPagesToCanvas,
  hitTestShapes,
  shapeBounds,
  shapesInRect,
  transformImageDataUrl,
  transformShape,
  type ImageTransform,
} from './render.js';
import { copyImageOnly, copyRegion, downloadImage } from './export.js';
import { downloadDocument, readDocumentFile } from './save-load.js';
import { screenMarkerStyles } from './styles.js';
import type { Point, Rect, Shape, ShapeType, Tool } from './types.js';

const TOOLS: { type: Tool; label: string; icon: string; key: string }[] = [
  { type: 'select', label: 'Select', icon: '↖', key: 'v' },
  { type: 'region', label: 'Region', icon: '⬚', key: 'm' },
  { type: 'rect', label: 'Rectangle', icon: '▭', key: 'r' },
  { type: 'ellipse', label: 'Ellipse', icon: '◯', key: 'o' },
  { type: 'arrow', label: 'Arrow', icon: '↗', key: 'a' },
  { type: 'line', label: 'Line', icon: '╱', key: 'l' },
  { type: 'text', label: 'Text', icon: 'T', key: 't' },
  { type: 'step', label: 'Step', icon: '①', key: 'n' },
  { type: 'pen', label: 'Pen', icon: '✎', key: 'p' },
  { type: 'highlight', label: 'Highlight', icon: '▮', key: 'h' },
  { type: 'blur', label: 'Blur', icon: '▦', key: 'b' },
];

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#007aff', '#000000', '#ffffff'];
const LINE_WIDTHS = [1, 2, 3, 5, 8, 12];
const FONT_SIZES = [12, 14, 18, 24, 32, 48, 64];

// Below this drag distance (in canvas pixels), a pointerdown→pointerup is
// treated as a click rather than a drag (no zero-size shapes, no 1px moves).
const CLICK_THRESHOLD = 3;

// Resize handles, in CSS pixels (converted to canvas pixels per zoom).
const HANDLE_CSS_PX = 9;

const FILLABLE: ShapeType[] = ['rect', 'ellipse', 'text'];
const SIZED_BY_FONT: ShapeType[] = ['text', 'step'];
const BOX_RESIZABLE: ShapeType[] = ['rect', 'ellipse', 'highlight', 'blur', 'pen'];

/** Which part of a box a drag grabbed: an edge/corner (compass letters) or the body. */
type BoxGrab = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const GRAB_CURSOR: Record<BoxGrab, string> = {
  move: 'move',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

type ShapeDrag =
  | { kind: 'move'; ids: string[]; start: Point; delta: Point; selectOnlyOnClick: string | null }
  | { kind: 'resize'; orig: Shape; grab: BoxGrab | 0 | 1; start: Point; draft: Shape | null };

type TextEdit = { id: string | null; anchor: Point; value: string; color: string; fontSize: number; fill: boolean };

function sortedRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function clampedRect(x1: number, y1: number, x2: number, y2: number, maxW: number, maxH: number): Rect {
  const r = sortedRect(
    Math.max(0, Math.min(maxW, x1)),
    Math.max(0, Math.min(maxH, y1)),
    Math.max(0, Math.min(maxW, x2)),
    Math.max(0, Math.min(maxH, y2))
  );
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

/** Applies an edge/corner drag of (dx, dy) to box `o`. Dragging past the opposite side flips it. */
function resizeBox(o: Rect, grab: Exclude<BoxGrab, 'move'>, dx: number, dy: number): [number, number, number, number] {
  let left = o.x;
  let top = o.y;
  let right = o.x + o.w;
  let bottom = o.y + o.h;
  if (grab.includes('w')) left += dx;
  if (grab.includes('e')) right += dx;
  if (grab.includes('n')) top += dy;
  if (grab.includes('s')) bottom += dy;
  return [left, top, right, bottom];
}

/** What part of box `r` is under `pt` (within `tol`): a corner, an edge, the body, or nothing. */
function boxGrabAt(r: Rect, pt: Point, tol: number): BoxGrab | null {
  const inX = pt.x >= r.x - tol && pt.x <= r.x + r.w + tol;
  const inY = pt.y >= r.y - tol && pt.y <= r.y + r.h + tol;
  if (!inX || !inY) return null;
  const v = Math.abs(pt.y - r.y) <= tol ? 'n' : Math.abs(pt.y - (r.y + r.h)) <= tol ? 's' : '';
  const h = Math.abs(pt.x - r.x) <= tol ? 'w' : Math.abs(pt.x - (r.x + r.w)) <= tol ? 'e' : '';
  return v || h ? ((v + h) as BoxGrab) : 'move';
}

function boundsRect(shape: Shape): Rect {
  const b = shapeBounds(shape);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/** Linearly maps all of a shape's points from box `from` to box `to` — resizes rects, ellipses, and pen strokes alike. */
function mapShapeToBox(shape: Shape, from: Rect, to: Rect): Shape {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  return {
    ...shape,
    points: shape.points.map((p) => ({ x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy })),
  };
}

function offsetShape(shape: Shape, dx: number, dy: number): Shape {
  return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Whether a keyboard/clipboard event started in an editable field — checked via composedPath since targets inside the shadow root are retargeted to the host at window level. */
function fromEditable(e: Event): boolean {
  const el = e.composedPath()[0] as HTMLElement | undefined;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function fromControl(e: Event): boolean {
  const el = e.composedPath()[0] as HTMLElement | undefined;
  return !!el && (el.tagName === 'BUTTON' || el.tagName === 'SELECT');
}

type ThemeMode = 'system' | 'light' | 'dark';
const THEME_STORAGE_KEY = 'screenmarker-theme';
const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark'];
const THEME_ICON: Record<ThemeMode, string> = { system: '◐', light: '☀', dark: '☾' };
const THEME_LABEL: Record<ThemeMode, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

function loadTheme(): ThemeMode {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

function applyTheme(mode: ThemeMode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}

interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>;
}
const EyeDropperCtor = (window as unknown as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;

export class ScreenMarker extends LitElement {
  static styles = screenMarkerStyles;

  #store = new AnnotatorStore();
  #canvasRef = createRef<HTMLCanvasElement>();
  #stageRef = createRef<HTMLDivElement>();
  #textInputRef = createRef<HTMLInputElement>();
  #loadDocumentInputRef = createRef<HTMLInputElement>();
  #image: { src: string; img: HTMLImageElement } | null = null;

  // Transient interaction state — never part of the document or undo history.
  #drawing = false;
  #currentPoints: Point[] = [];
  #dragStart: Point | null = null;
  #shapeDrag: ShapeDrag | null = null;
  #marquee: { start: Point; rect: Rect; additive: boolean } | null = null;
  // Region select is tied to a page id so it never leaks onto another page after switching tabs.
  #region: { pageId: string; rect: Rect } | null = null;
  #regionDrag: { grab: BoxGrab | 'create'; start: Point; orig: Rect } | null = null;
  #textEdit: TextEdit | null = null;
  #focusTextEdit = false;
  #spaceHeld = false;
  #spacePanned = false;
  #pan: { x: number; y: number; left: number; top: number } | null = null;
  #canvasCursor = '';

  #statusMsg = '';
  #previewUrl: string | null = null;
  #previewSize: { width: number; height: number } | null = null;
  #draggingPageId: string | null = null;
  #dragOverPageId: string | null = null;
  #dragOverSide: 'before' | 'after' | null = null;
  #justMovedPageId: string | null = null;
  #theme: ThemeMode = loadTheme();

  constructor() {
    super();
    new SignalWatcher(this);
    applyTheme(this.#theme);
  }

  #setTheme(mode: ThemeMode): void {
    this.#theme = mode;
    localStorage.setItem(THEME_STORAGE_KEY, mode);
    applyTheme(mode);
    this.requestUpdate();
  }

  #cycleTheme(): void {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(this.#theme) + 1) % THEME_CYCLE.length]!;
    this.#setTheme(next);
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('paste', this.#onPaste);
    window.addEventListener('keydown', this.#onKeydown);
    window.addEventListener('keyup', this.#onKeyup);
    window.addEventListener('blur', this.#onWindowBlur);
    this.addEventListener('dragover', this.#onDragOver);
    this.addEventListener('drop', this.#onDrop);
    this.#store.restore().then(async () => {
      this.requestUpdate();
      await this.updateComplete;
      await this.#redraw();
      this.#fitToWindow();
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('paste', this.#onPaste);
    window.removeEventListener('keydown', this.#onKeydown);
    window.removeEventListener('keyup', this.#onKeyup);
    window.removeEventListener('blur', this.#onWindowBlur);
  }

  #onDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  #onDrop = async (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) await this.#loadImageFile(file);
  };

  #onPaste = async (e: ClipboardEvent) => {
    if (fromEditable(e)) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) await this.#loadImageFile(file);
        return;
      }
    }
  };

  #onWindowBlur = () => {
    this.#spaceHeld = false;
    this.#pan = null;
    this.requestUpdate();
  };

  #onKeyup = (e: KeyboardEvent) => {
    if (e.key !== ' ' || !this.#spaceHeld) return;
    this.#spaceHeld = false;
    // A Space tap (no drag) still toggles the preview, as before Space+drag panning existed.
    if (!this.#spacePanned && this.#store.activePage.imageDataUrl) this.#openPreview();
    this.requestUpdate();
  };

  #onKeydown = (e: KeyboardEvent) => {
    const typing = fromEditable(e);
    const mod = e.metaKey || e.ctrlKey;

    if (e.key === 'Escape' && this.#previewUrl) {
      e.preventDefault();
      this.#closePreview();
      return;
    }

    if (e.key === ' ' && !mod && !e.altKey) {
      if (typing || fromControl(e)) return;
      e.preventDefault();
      if (e.repeat) return;
      if (this.#previewUrl) {
        this.#closePreview();
        return;
      }
      this.#spaceHeld = true;
      this.#spacePanned = false;
      this.requestUpdate();
      return;
    }

    if (typing) return;

    const region = this.#activeRegion();
    if (region) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.#clearRegion();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.#cropRegion();
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void this.#copyRegion();
        return;
      }
    }

    const selectedIds = this.#store.selectedIds;

    if (e.key === 'Escape' && this.#store.selection.value) {
      e.preventDefault();
      this.#store.selection.set(null);
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
      const sel = this.#store.selection.value;
      if (selectedIds.length) {
        e.preventDefault();
        this.#store.deleteSelectedShapes();
      } else if (sel?.type === 'image' && this.#store.activePage.shapes.length === 0) {
        // Image selected with no other annotations on the page: delete the
        // whole page (or, if it's the only page left, reset to a blank
        // fresh-load state) rather than leaving an empty selected image.
        // Same confirmation as the tab's × button.
        e.preventDefault();
        this.#closePageWithConfirm(this.#store.activePageId.value);
      }
      return;
    }

    if (e.key.startsWith('Arrow') && !mod && !e.altKey) {
      if (selectedIds.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        this.#store.moveShapes(selectedIds, dx, dy);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.#gotoAdjacentPage(e.key === 'ArrowLeft' ? -1 : 1);
      }
      return;
    }

    if (!mod && !e.altKey) {
      const tool = TOOLS.find((t) => t.key === e.key.toLowerCase());
      if (tool && !e.shiftKey) {
        e.preventDefault();
        this.#setTool(tool.type);
        return;
      }
      switch (e.key) {
        case ',':
        case '.': {
          e.preventDefault();
          const moved = this.#store.moveActivePage(e.key === ',' ? -1 : 1);
          if (moved) this.#flashMovedTab(this.#store.activePageId.value);
          return;
        }
        case '[':
        case ']': {
          e.preventDefault();
          const dir = e.key === '[' ? -1 : 1;
          if (this.#styleContextIsText()) this.#adjustFontSize(dir * 2);
          else this.#adjustLineWidth(dir);
          return;
        }
        case '+':
        case '=':
          e.preventDefault();
          this.#store.zoomIn();
          return;
        case '-':
          e.preventDefault();
          this.#store.zoomOut();
          return;
        case '0':
          e.preventDefault();
          this.#store.zoomReset();
          return;
        case 'f':
          e.preventDefault();
          this.#fitToWindow();
          return;
      }
    }

    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.#store.redo();
      else this.#store.undo();
      this.#clearRegion();
    } else if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      this.#store.zoomIn();
    } else if (e.key === '-') {
      e.preventDefault();
      this.#store.zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      this.#store.zoomReset();
    } else if (key === 'a') {
      e.preventDefault();
      this.#store.selectShapes(this.#store.activePage.shapes.map((s) => s.id));
    } else if (key === 'd') {
      e.preventDefault();
      this.#store.duplicateSelectedShapes();
    } else if (e.key === ']' || e.key === '[') {
      e.preventDefault();
      this.#store.reorderSelectedShapes(e.key === ']' ? 'front' : 'back');
    } else if (key === 'c') {
      e.preventDefault();
      const sel = this.#store.selection.value;
      if (selectedIds.length) {
        // In-app clipboard copy — pastes back as new, still-editable shapes.
        this.#store.copySelection();
        this.#flashStatus(selectedIds.length === 1 ? 'Shape copied' : `${selectedIds.length} shapes copied`);
      } else if (sel?.type === 'image') {
        // The image is selected: copy the page to the OS clipboard AND the
        // in-app clipboard, so Cmd+V can still duplicate it onto another page.
        this.#store.copySelection();
        void this.#copyCurrentPage();
      } else if (this.#store.activePage.imageDataUrl) {
        // Nothing selected: copy the whole scene (all pages) to the OS clipboard.
        void this.#copyImage();
      }
    } else if (key === 'v' && this.#store.hasClipboard()) {
      e.preventDefault();
      this.#store.paste();
    } else if (key === 's') {
      e.preventDefault();
      this.#saveDocument();
    } else if (key === 'o') {
      e.preventDefault();
      this.#loadDocumentInputRef.value?.click();
    }
  };

  #setTool(tool: Tool): void {
    this.#commitTextEdit();
    this.#store.activeTool.set(tool);
    this.#canvasCursor = '';
  }

  async #loadImageFile(file: File): Promise<void> {
    const dataUrl = await fileToDataUrl(file);
    this.#store.setImage(this.#store.activePageId.value, dataUrl);
    this.#clearRegion();
    await this.updateComplete;
    await this.#redraw();
    this.#fitToWindow();
  }

  #onFilePick = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) await this.#loadImageFile(file);
    input.value = '';
  };

  #saveDocument = () => {
    const saved = downloadDocument(this.#store.pages.value, this.#store.activePageId.value);
    if (saved) this.#flashStatus('Document saved');
  };

  #onLoadDocumentPick = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    const hasContent =
      this.#store.pages.value.length > 1 ||
      this.#store.pages.value.some((p) => p.imageDataUrl !== null || p.shapes.length > 0);
    if (hasContent && !window.confirm('Load this document? It will replace everything currently open. You can Undo (Cmd/Ctrl+Z) afterward.')) {
      return;
    }

    try {
      const { pages, activePageId } = await readDocumentFile(file);
      this.#store.loadDocument(pages, activePageId);
      await this.updateComplete;
      await this.#redraw();
      this.#fitToWindow();
      this.#flashStatus('Document loaded');
    } catch (err) {
      this.#flashStatus(`Load failed: ${(err as Error).message}`);
    }
  };

  // ---------- drawing ----------

  async #loadPageImage(src: string): Promise<HTMLImageElement> {
    if (this.#image?.src === src) return this.#image.img;
    const img = new Image();
    img.src = src;
    await img.decode();
    this.#image = { src, img };
    return img;
  }

  /** The page's shapes as they should look right now — with any in-progress move, resize, or new shape applied, and the text being edited hidden (the input overlay shows it instead). */
  #displayShapes(): Shape[] {
    const drag = this.#shapeDrag;
    const movingIds = drag?.kind === 'move' ? new Set(drag.ids) : null;
    const shapes: Shape[] = [];
    for (const s of this.#store.activePage.shapes) {
      if (this.#textEdit?.id === s.id) continue;
      if (movingIds?.has(s.id) && drag?.kind === 'move') shapes.push(offsetShape(s, drag.delta.x, drag.delta.y));
      else if (drag?.kind === 'resize' && drag.orig.id === s.id && drag.draft) shapes.push(drag.draft);
      else shapes.push(s);
    }
    const tool = this.#store.activeTool.value;
    if (this.#drawing && this.#currentPoints.length >= 2 && this.#isShapeTool(tool)) {
      shapes.push(this.#newShape(tool, this.#currentPoints));
    }
    return shapes;
  }

  #isShapeTool(tool: Tool): tool is ShapeType {
    return tool !== 'select' && tool !== 'region';
  }

  #newShape(type: ShapeType, points: Point[]): Shape {
    const shape: Shape = {
      id: makeId(),
      type,
      color: this.#store.activeColor.value,
      lineWidth: this.#store.activeLineWidth.value,
      points,
    };
    if (FILLABLE.includes(type)) shape.fill = this.#store.activeFill.value;
    if (SIZED_BY_FONT.includes(type)) shape.fontSize = this.#store.activeFontSize.value;
    return shape;
  }

  async #redraw(): Promise<void> {
    const page = this.#store.activePage;
    const canvas = this.#canvasRef.value;
    if (!canvas || !page.imageDataUrl) return;

    const img = await this.#loadPageImage(page.imageDataUrl);
    const sizeChanged = canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight;
    if (sizeChanged) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const shapes = this.#displayShapes();
    drawShapes(ctx, shapes);

    const unit = 1 / this.#displayScale();
    const selected = new Set(this.#store.selectedIds);
    const selectedShapes = shapes.filter((s) => selected.has(s.id));
    for (const s of selectedShapes) drawSelectionOutline(ctx, s, unit);
    const handleShape = selectedShapes.length === 1 ? selectedShapes[0]! : null;
    if (handleShape && this.#store.activeTool.value === 'select' && this.#shapeDrag?.kind !== 'move') {
      const pts = this.#handlePoints(handleShape);
      if (pts.length) drawHandles(ctx, pts, HANDLE_CSS_PX * unit);
    }
    if (this.#store.selection.value?.type === 'image') drawImageSelectionOutline(ctx, canvas.width, canvas.height);
    if (this.#marquee) drawMarquee(ctx, this.#marquee.rect, unit);

    const region = this.#activeRegion();
    if (region) drawRegionOverlay(ctx, region, HANDLE_CSS_PX * unit);
    // canvas.width/height just changed the wrap's target size (#canvasWrapStyle
    // reads it) — re-render once so the wrap picks up the new box on first load.
    if (sizeChanged) this.requestUpdate();
  }

  /** Resize-handle positions for a shape: two endpoints for arrows/lines, 8 box handles for box-like shapes, none for text/steps (sized via font size). */
  #handlePoints(shape: Shape): Point[] {
    if (shape.type === 'arrow' || shape.type === 'line') return shape.points.slice(0, 2);
    if (BOX_RESIZABLE.includes(shape.type)) return boxHandlePoints(boundsRect(shape));
    return [];
  }

  /** Which resize handle of `shape` is under `pt`, if any: an endpoint index for arrows/lines, a box edge/corner otherwise. */
  #shapeHandleAt(shape: Shape, pt: Point): BoxGrab | 0 | 1 | null {
    const tol = this.#handleTolerance();
    if (shape.type === 'arrow' || shape.type === 'line') {
      const i = shape.points.slice(0, 2).findIndex((p) => Math.hypot(p.x - pt.x, p.y - pt.y) <= tol);
      return i === 0 || i === 1 ? i : null;
    }
    if (!BOX_RESIZABLE.includes(shape.type)) return null;
    const grab = boxGrabAt(boundsRect(shape), pt, tol);
    return grab === 'move' ? null : grab;
  }

  #handleTolerance(): number {
    return HANDLE_CSS_PX / this.#displayScale();
  }

  #canvasPoint(e: PointerEvent | MouseEvent): Point {
    const canvas = this.#canvasRef.value!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  // ---------- pointer handling ----------

  /** Stage-level pointerdown: Space+drag pans from anywhere; a click on the stage padding (not bubbled from the canvas) clears the selection. */
  #onStagePointerDown = (e: PointerEvent) => {
    if (this.#spaceHeld) {
      const stage = this.#stageRef.value!;
      this.#pan = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      this.#spacePanned = true;
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.requestUpdate();
      return;
    }
    if (e.target === e.currentTarget) {
      this.#commitTextEdit();
      if (this.#store.selection.value) this.#store.selection.set(null);
    }
  };

  #onStagePointerMove = (e: PointerEvent) => {
    if (!this.#pan) return;
    const stage = this.#stageRef.value!;
    stage.scrollLeft = this.#pan.left - (e.clientX - this.#pan.x);
    stage.scrollTop = this.#pan.top - (e.clientY - this.#pan.y);
  };

  #onStagePointerUp = () => {
    if (!this.#pan) return;
    this.#pan = null;
    this.requestUpdate();
  };

  /** Cmd/Ctrl+wheel and trackpad pinch (which browsers report as ctrl+wheel) zoom around the cursor. */
  #onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey) || !this.#canvasRef.value) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
    void this.#zoomAt(this.#store.zoom.value * factor, e.clientX, e.clientY);
  };

  /** Sets zoom while keeping the image point under (clientX, clientY) fixed on screen. */
  async #zoomAt(zoom: number, clientX: number, clientY: number): Promise<void> {
    const canvas = this.#canvasRef.value;
    const stage = this.#stageRef.value;
    if (!canvas || !stage) return;
    const before = canvas.getBoundingClientRect();
    const fx = (clientX - before.left) / before.width;
    const fy = (clientY - before.top) / before.height;
    this.#store.setZoom(zoom);
    await this.updateComplete;
    const after = canvas.getBoundingClientRect();
    stage.scrollLeft += after.left + fx * after.width - clientX;
    stage.scrollTop += after.top + fy * after.height - clientY;
  }

  /** Zooms so the whole image fits in the stage, never above 100%. */
  #fitToWindow(): void {
    const canvas = this.#canvasRef.value;
    const stage = this.#stageRef.value;
    if (!canvas || !stage || !canvas.width || !this.#store.activePage.imageDataUrl) return;
    const dpr = window.devicePixelRatio || 1;
    const availW = stage.clientWidth - 32;
    const availH = stage.clientHeight - 32;
    if (availW <= 0 || availH <= 0) return;
    this.#store.setZoom(Math.min(1, (availW * dpr) / canvas.width, (availH * dpr) / canvas.height));
  }

  #onPointerDown = (e: PointerEvent) => {
    if (this.#spaceHeld || !this.#store.activePage.imageDataUrl || e.button !== 0) return;
    this.#commitTextEdit();
    const tool = this.#store.activeTool.value;
    const pt = this.#canvasPoint(e);
    const capture = () => (e.target as Element).setPointerCapture(e.pointerId);

    if (tool === 'region') {
      const current = this.#activeRegion();
      const grab = current ? boxGrabAt(current, pt, this.#handleTolerance()) : null;
      this.#regionDrag =
        current && grab
          ? { grab, start: pt, orig: current }
          : { grab: 'create', start: pt, orig: { x: pt.x, y: pt.y, w: 0, h: 0 } };
      if (this.#store.selection.value) this.#store.selection.set(null);
      capture();
      return;
    }

    if (tool === 'select') {
      const selected = this.#store.selectedShapes;
      if (selected.length === 1) {
        const handle = this.#shapeHandleAt(selected[0]!, pt);
        if (handle !== null) {
          this.#shapeDrag = { kind: 'resize', orig: selected[0]!, grab: handle, start: pt, draft: null };
          capture();
          return;
        }
      }
      const hit = hitTestShapes(this.#store.activePage.shapes, pt);
      if (hit) {
        const wasSelected = this.#store.selectedIds.includes(hit.id);
        if (e.shiftKey) this.#store.toggleShapeSelected(hit.id);
        else if (!wasSelected) this.#store.selectShapes([hit.id]);
        const ids = this.#store.selectedIds;
        if (ids.includes(hit.id)) {
          // Arm a potential drag-to-move of the whole selection; a plain click
          // on one member of a multi-selection narrows it to just that shape.
          this.#shapeDrag = {
            kind: 'move',
            ids,
            start: pt,
            delta: { x: 0, y: 0 },
            selectOnlyOnClick: !e.shiftKey && wasSelected && ids.length > 1 ? hit.id : null,
          };
          capture();
        }
        return;
      }
      this.#marquee = { start: pt, rect: { x: pt.x, y: pt.y, w: 0, h: 0 }, additive: e.shiftKey };
      capture();
      return;
    }

    if (tool === 'text') {
      // Suppress the compat mousedown, whose default focus change would
      // immediately blur (and so commit/close) the editor opened below.
      e.preventDefault();
      const hit = hitTestShapes(this.#store.activePage.shapes, pt);
      if (hit?.type === 'text') this.#startTextEdit(hit);
      else this.#startTextEdit(null, pt);
      return;
    }

    if (tool === 'step') {
      const step = this.#newShape('step', [pt]);
      step.stepNumber = this.#store.nextStepNumber();
      this.#store.addShape(step);
      return;
    }

    this.#drawing = true;
    this.#dragStart = pt;
    this.#currentPoints = [pt];
    capture();
  };

  #onPointerMove = (e: PointerEvent) => {
    if (this.#spaceHeld) return;
    const tool = this.#store.activeTool.value;
    const pt = this.#canvasPoint(e);

    if (tool === 'region') {
      this.#onRegionPointerMove(pt);
      return;
    }

    const drag = this.#shapeDrag;
    if (drag?.kind === 'move') {
      drag.delta = { x: pt.x - drag.start.x, y: pt.y - drag.start.y };
      void this.#redraw();
      return;
    }
    if (drag?.kind === 'resize') {
      drag.draft = this.#resizedShape(drag, pt);
      void this.#redraw();
      return;
    }
    if (this.#marquee) {
      const m = this.#marquee;
      m.rect = sortedRect(m.start.x, m.start.y, pt.x, pt.y);
      void this.#redraw();
      return;
    }

    if (this.#drawing) {
      if (tool === 'pen') this.#currentPoints.push(pt);
      else this.#currentPoints = [this.#currentPoints[0]!, pt];
      void this.#redraw();
      return;
    }

    this.#updateHoverCursor(pt);
  };

  #resizedShape(drag: Extract<ShapeDrag, { kind: 'resize' }>, pt: Point): Shape {
    const o = drag.orig;
    if (drag.grab === 0 || drag.grab === 1) {
      const points = [...o.points];
      points[drag.grab] = pt;
      return { ...o, points };
    }
    if (drag.grab === 'move') return o;
    const from = boundsRect(o);
    const [l, t, r, b] = resizeBox(from, drag.grab, pt.x - drag.start.x, pt.y - drag.start.y);
    return mapShapeToBox(o, from, sortedRect(l, t, r, b));
  }

  #updateHoverCursor(pt: Point): void {
    let cursor = 'crosshair';
    if (this.#store.activeTool.value === 'select') {
      cursor = 'default';
      const selected = this.#store.selectedShapes;
      const handle = selected.length === 1 ? this.#shapeHandleAt(selected[0]!, pt) : null;
      if (handle === 0 || handle === 1) cursor = 'grab';
      else if (handle) cursor = GRAB_CURSOR[handle];
      else if (hitTestShapes(this.#store.activePage.shapes, pt)) cursor = 'move';
    } else if (this.#store.activeTool.value === 'text') {
      cursor = 'text';
    }
    if (cursor !== this.#canvasCursor) {
      this.#canvasCursor = cursor;
      this.requestUpdate();
    }
  }

  #onPointerUp = (e: PointerEvent) => {
    if (this.#regionDrag) {
      const r = this.#region?.rect;
      this.#regionDrag = null;
      if (!r || r.w < CLICK_THRESHOLD || r.h < CLICK_THRESHOLD) this.#clearRegion();
      else this.requestUpdate();
      return;
    }

    const drag = this.#shapeDrag;
    if (drag) {
      this.#shapeDrag = null;
      if (drag.kind === 'move') {
        const { x: dx, y: dy } = drag.delta;
        if (Math.hypot(dx, dy) >= CLICK_THRESHOLD) this.#store.moveShapes(drag.ids, dx, dy);
        else if (drag.selectOnlyOnClick) this.#store.selectShapes([drag.selectOnlyOnClick]);
      } else if (drag.draft) {
        this.#store.replaceShape(drag.draft);
      }
      void this.#redraw();
      return;
    }

    if (this.#marquee) {
      const { rect, additive } = this.#marquee;
      this.#marquee = null;
      if (rect.w < CLICK_THRESHOLD && rect.h < CLICK_THRESHOLD) {
        if (!additive) this.#store.selection.set({ type: 'image' });
      } else {
        const hits = shapesInRect(this.#store.activePage.shapes, rect).map((s) => s.id);
        this.#store.selectShapes(additive ? [...new Set([...this.#store.selectedIds, ...hits])] : hits);
      }
      void this.#redraw();
      return;
    }

    if (!this.#drawing) return;
    this.#drawing = false;
    const tool = this.#store.activeTool.value;
    const pt = this.#canvasPoint(e);
    const start = this.#dragStart;
    const dragDistance = start ? Math.hypot(pt.x - start.x, pt.y - start.y) : Infinity;
    const points = this.#currentPoints;
    this.#currentPoints = [];
    this.#dragStart = null;

    if (!this.#isShapeTool(tool)) return;
    if (dragDistance < CLICK_THRESHOLD) {
      // A click (no real drag) with a draw tool active would only produce a
      // degenerate zero-size shape — treat it as "select whatever's under
      // the cursor" instead, same as the Select tool would.
      const hit = start ? hitTestShapes(this.#store.activePage.shapes, start) : null;
      if (hit && e.shiftKey) this.#store.toggleShapeSelected(hit.id);
      else this.#store.selection.set(hit ? { type: 'shapes', ids: [hit.id] } : { type: 'image' });
    } else if (points.length >= 2) {
      this.#store.addShape(this.#newShape(tool, points));
    }
    void this.#redraw();
  };

  #onDoubleClick = (e: MouseEvent) => {
    if (!this.#store.activePage.imageDataUrl) return;
    const hit = hitTestShapes(this.#store.activePage.shapes, this.#canvasPoint(e));
    if (hit?.type === 'text') this.#startTextEdit(hit);
  };

  // ---------- inline text editing ----------

  #startTextEdit(shape: Shape | null, anchor?: Point): void {
    this.#commitTextEdit();
    this.#textEdit = shape
      ? {
          id: shape.id,
          anchor: shape.points[0]!,
          value: shape.label ?? '',
          color: shape.color,
          fontSize: shape.fontSize ?? 18,
          fill: !!shape.fill,
        }
      : {
          id: null,
          anchor: anchor!,
          value: '',
          color: this.#store.activeColor.value,
          fontSize: this.#store.activeFontSize.value,
          fill: this.#store.activeFill.value,
        };
    if (shape) this.#store.selectShapes([shape.id]);
    this.#focusTextEdit = true;
    this.requestUpdate();
  }

  /** Saves the open text editor (if any). An emptied existing label deletes that text shape. */
  #commitTextEdit(): void {
    const edit = this.#textEdit;
    if (!edit) return;
    this.#textEdit = null;
    const label = edit.value.trim();
    if (edit.id) {
      const shape = this.#store.activePage.shapes.find((s) => s.id === edit.id);
      if (shape && !label) this.#store.deleteShapes([edit.id]);
      else if (shape && label !== shape.label) this.#store.replaceShape({ ...shape, label });
    } else if (label) {
      const shape = this.#newShape('text', [edit.anchor]);
      shape.label = label;
      shape.color = edit.color;
      shape.fontSize = edit.fontSize;
      shape.fill = edit.fill;
      this.#store.addShape(shape);
    }
    this.requestUpdate();
  }

  #cancelTextEdit(): void {
    this.#textEdit = null;
    this.requestUpdate();
  }

  #onTextKeydown = (e: KeyboardEvent) => {
    // Keep global shortcuts (tool keys, Delete, Cmd+Z…) out of the text field.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      this.#commitTextEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.#cancelTextEdit();
    }
  };

  #textEditor() {
    const edit = this.#textEdit;
    if (!edit) return '';
    const scale = this.#displayScale();
    const fontPx = edit.fontSize * scale;
    const pad = edit.fill ? edit.fontSize * 0.25 * scale : 0;
    const style = [
      `left:${edit.anchor.x * scale - pad}px`,
      `top:${edit.anchor.y * scale - pad}px`,
      `font-size:${fontPx}px`,
      `padding:${pad}px`,
      `width:calc(${Math.max(2, edit.value.length + 1)}ch + ${pad * 2}px)`,
      `color:${edit.fill ? contrastColor(edit.color) : edit.color}`,
      edit.fill ? `background:${edit.color}` : '',
    ].join(';');
    return html`
      <input
        ${ref(this.#textInputRef)}
        class="text-editor"
        style=${style}
        .value=${live(edit.value)}
        placeholder="Text"
        @input=${(e: Event) => {
          edit.value = (e.target as HTMLInputElement).value;
          this.requestUpdate();
        }}
        @keydown=${this.#onTextKeydown}
        @blur=${() => this.#commitTextEdit()}
        @pointerdown=${(e: Event) => e.stopPropagation()}
      />
    `;
  }

  // ---------- region select ----------

  /** The region on the active page, only while the Region tool is active. */
  #activeRegion(): Rect | null {
    if (this.#store.activeTool.value !== 'region') return null;
    if (!this.#region || this.#region.pageId !== this.#store.activePageId.value) return null;
    return this.#region.rect;
  }

  #clearRegion(): void {
    if (!this.#region) return;
    this.#region = null;
    this.#regionDrag = null;
    this.requestUpdate();
  }

  #onRegionPointerMove(pt: Point): void {
    const canvas = this.#canvasRef.value;
    if (!canvas) return;
    const drag = this.#regionDrag;

    if (!drag) {
      const current = this.#activeRegion();
      const grab = current ? boxGrabAt(current, pt, this.#handleTolerance()) : null;
      const cursor = grab ? GRAB_CURSOR[grab] : 'crosshair';
      if (cursor !== this.#canvasCursor) {
        this.#canvasCursor = cursor;
        this.requestUpdate();
      }
      return;
    }

    const W = canvas.width;
    const H = canvas.height;
    const dx = pt.x - drag.start.x;
    const dy = pt.y - drag.start.y;
    const o = drag.orig;
    let rect: Rect;

    if (drag.grab === 'create') {
      rect = clampedRect(drag.start.x, drag.start.y, pt.x, pt.y, W, H);
    } else if (drag.grab === 'move') {
      rect = {
        x: Math.round(Math.max(0, Math.min(W - o.w, o.x + dx))),
        y: Math.round(Math.max(0, Math.min(H - o.h, o.y + dy))),
        w: o.w,
        h: o.h,
      };
    } else {
      rect = clampedRect(...resizeBox(o, drag.grab, dx, dy), W, H);
    }

    this.#region = { pageId: this.#store.activePageId.value, rect };
    this.requestUpdate();
  }

  #copyRegion = async () => {
    const r = this.#activeRegion();
    if (!r) return;
    try {
      await copyRegion(this.#store.activePage, r);
      this.#flashStatus('Selection copied to clipboard');
    } catch (err) {
      this.#flashStatus(`Copy failed: ${(err as Error).message}`);
    }
  };

  /** Crops the active page's image to the region; annotations shift with it and stay editable. Undoable. */
  #cropRegion = async () => {
    const r = this.#activeRegion();
    const page = this.#store.activePage;
    if (!r || !page.imageDataUrl) return;
    try {
      const cropped = await cropImageDataUrl(page.imageDataUrl, r);
      this.#store.cropActivePage(cropped, r.x, r.y);
      this.#clearRegion();
      this.#flashStatus('Cropped (Cmd/Ctrl+Z to undo)');
    } catch (err) {
      this.#flashStatus(`Crop failed: ${(err as Error).message}`);
    }
  };

  /** Floating Copy/Crop bar anchored under the region's bottom-right corner, kept inside the canvas box. Hidden mid-drag. */
  #regionActions() {
    const r = this.#activeRegion();
    const canvas = this.#canvasRef.value;
    if (!r || !canvas || this.#regionDrag) return '';
    const scale = this.#displayScale();
    const wrapH = canvas.height * scale;
    const right = (r.x + r.w) * scale;
    const top = Math.max(4, Math.min((r.y + r.h) * scale + 6, wrapH - 36));
    const alignLeft = right < 300;
    const left = alignLeft ? Math.max(4, r.x * scale) : right;
    return html`
      <div
        class="region-actions"
        style="left:${left}px; top:${top}px; ${alignLeft ? '' : 'transform: translateX(-100%);'}"
        @pointerdown=${(e: Event) => e.stopPropagation()}
      >
        <span class="region-size">${r.w}×${r.h}</span>
        <button class="button-primary" @click=${this.#copyRegion} title="Copy selection, with annotations (Cmd/Ctrl+C)">
          📋 Copy selection
        </button>
        <button @click=${this.#cropRegion} title="Crop image to selection (Enter)">✂ Crop selection</button>
        <button @click=${() => this.#clearRegion()} title="Clear selection (Esc)">✕</button>
      </div>
    `;
  }

  // ---------- image transforms ----------

  /** Rotates or flips the active page's image, carrying every annotation along. Undoable. */
  async #transformImage(transform: ImageTransform): Promise<void> {
    const page = this.#store.activePage;
    if (!page.imageDataUrl) return;
    this.#commitTextEdit();
    try {
      const img = await this.#loadPageImage(page.imageDataUrl);
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const { dataUrl } = await transformImageDataUrl(page.imageDataUrl, transform);
      this.#store.replaceActivePageContent(
        dataUrl,
        page.shapes.map((s) => transformShape(s, transform, W, H))
      );
      this.#clearRegion();
    } catch (err) {
      this.#flashStatus(`Transform failed: ${(err as Error).message}`);
    }
  }

  // ---------- styling ----------

  async #flashStatus(msg: string): Promise<void> {
    this.#statusMsg = msg;
    this.requestUpdate();
    setTimeout(() => {
      if (this.#statusMsg !== msg) return;
      this.#statusMsg = '';
      this.requestUpdate();
    }, 2000);
  }

  #pagesWithImages() {
    return this.#store.pages.value.filter((p) => p.imageDataUrl !== null);
  }

  /**
   * Whether the size controls (toolbar dropdown and [ / ] shortcuts) act on
   * font size (text, steps) or stroke width. A selection overrides the
   * active tool, so a selected label can be resized without switching tools.
   */
  #styleContextIsText(): boolean {
    const selected = this.#store.selectedShapes;
    if (selected.length) return selected.every((s) => SIZED_BY_FONT.includes(s.type));
    return SIZED_BY_FONT.includes(this.#store.activeTool.value as ShapeType);
  }

  /** The style value the toolbar should show: from the first selected shape, else the tool default. */
  #currentStyle() {
    const first = this.#store.selectedShapes[0];
    return {
      color: first?.color ?? this.#store.activeColor.value,
      lineWidth: first && !SIZED_BY_FONT.includes(first.type) ? first.lineWidth : this.#store.activeLineWidth.value,
      fontSize: first?.fontSize ?? this.#store.activeFontSize.value,
      fill: first && FILLABLE.includes(first.type) ? !!first.fill : this.#store.activeFill.value,
    };
  }

  /** Sets the tool default(s) and restyles every selected shape (and the open text editor) to match. */
  #applyStyle(style: ShapeStyle): void {
    if (style.color !== undefined) this.#store.activeColor.set(style.color);
    if (style.lineWidth !== undefined) this.#store.activeLineWidth.set(style.lineWidth);
    if (style.fontSize !== undefined) this.#store.activeFontSize.set(style.fontSize);
    if (style.fill !== undefined) this.#store.activeFill.set(style.fill);
    const edit = this.#textEdit;
    if (edit) {
      if (style.color !== undefined) edit.color = style.color;
      if (style.fontSize !== undefined) edit.fontSize = style.fontSize;
      if (style.fill !== undefined) edit.fill = style.fill;
      this.requestUpdate();
    }
    this.#store.updateShapesStyle(this.#store.selectedIds, style);
  }

  #adjustLineWidth(delta: number): void {
    this.#applyStyle({ lineWidth: Math.max(1, Math.min(30, this.#currentStyle().lineWidth + delta)) });
  }

  #adjustFontSize(delta: number): void {
    this.#applyStyle({ fontSize: Math.max(8, Math.min(96, this.#currentStyle().fontSize + delta)) });
  }

  #pickColorFromScreen = async () => {
    if (!EyeDropperCtor) return;
    try {
      const { sRGBHex } = await new EyeDropperCtor().open();
      this.#applyStyle({ color: sRGBHex });
    } catch {
      // user cancelled (Esc)
    }
  };

  // ---------- copy / export ----------

  #copyImage = async () => {
    try {
      await copyImageOnly(this.#pagesWithImages());
      this.#flashStatus('Image copied to clipboard');
    } catch (err) {
      this.#flashStatus(`Copy failed: ${(err as Error).message}`);
    }
  };

  #copyCurrentPage = async () => {
    try {
      await copyImageOnly([this.#store.activePage]);
      this.#flashStatus('Current page copied to clipboard');
    } catch (err) {
      this.#flashStatus(`Copy failed: ${(err as Error).message}`);
    }
  };

  #download = async () => {
    await downloadImage(this.#pagesWithImages());
  };

  #openPreview = async () => {
    try {
      const canvas = await flattenPagesToCanvas(this.#pagesWithImages());
      this.#previewUrl = canvas.toDataURL('image/png');
      this.#previewSize = { width: canvas.width, height: canvas.height };
      this.#store.previewZoomReset();
      this.requestUpdate();
    } catch (err) {
      this.#flashStatus(`Preview failed: ${(err as Error).message}`);
    }
  };

  #closePreview = () => {
    this.#previewUrl = null;
    this.#previewSize = null;
    this.requestUpdate();
  };

  /** Same devicePixelRatio-correction as #displayScale, applied to the preview's zoom instead. */
  #previewDisplayScale(): number {
    return this.#store.previewZoom.value / (window.devicePixelRatio || 1);
  }

  #previewWrapStyle(): string {
    if (!this.#previewSize) return '';
    const scale = this.#previewDisplayScale();
    return `width:${this.#previewSize.width * scale}px; height:${this.#previewSize.height * scale}px;`;
  }

  // ---------- pages ----------

  #newDocument = () => {
    const hasContent =
      this.#store.pages.value.length > 1 ||
      this.#store.pages.value.some((p) => p.imageDataUrl !== null || p.shapes.length > 0);
    if (!hasContent) return;
    if (!window.confirm('Start a new document? This clears all pages. You can Undo (Cmd/Ctrl+Z) afterward.')) {
      return;
    }
    this.#store.newDocument();
    this.#store.zoomReset();
  };

  async #switchPage(id: string): Promise<void> {
    this.#commitTextEdit();
    this.#store.setActivePage(id);
    await this.updateComplete;
    await this.#redraw();
    this.#fitToWindow();
  }

  #gotoAdjacentPage(direction: -1 | 1): void {
    const pages = this.#store.pages.value;
    if (pages.length < 2) return;
    const currentIndex = pages.findIndex((p) => p.id === this.#store.activePageId.value);
    const nextIndex = (currentIndex + direction + pages.length) % pages.length;
    void this.#switchPage(pages[nextIndex]!.id);
  }

  #addPage(): void {
    this.#commitTextEdit();
    this.#store.addPage();
  }

  /** Pages have no stored name — tabs are always labeled by current position, so reordering/closing/adding can never produce out-of-sequence numbers. */
  #pageLabel(index: number): string {
    return `Page ${index + 1}`;
  }

  /** Confirms (if the page has content) then closes it. Shared by the tab's × button and the Delete-key-on-selected-image shortcut. */
  #closePageWithConfirm(id: string): void {
    const index = this.#store.pages.value.findIndex((p) => p.id === id);
    const target = this.#store.pages.value[index];
    const hasContent = target && (target.imageDataUrl !== null || target.shapes.length > 0);
    if (hasContent && !window.confirm(`Close "${this.#pageLabel(index)}"? You can Undo (Cmd/Ctrl+Z) afterward.`)) {
      return;
    }
    this.#store.closePage(id);
    this.#store.zoomReset();
  }

  #closePage(e: Event, id: string): void {
    e.stopPropagation();
    this.#closePageWithConfirm(id);
  }

  #onTabDragStart = (e: DragEvent, id: string): void => {
    this.#draggingPageId = id;
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  };

  /** Which side of the hovered tab the cursor is over — left half = insert before it, right half = insert after it. */
  #dragOverSideFor(e: DragEvent): 'before' | 'after' {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    return e.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
  }

  #onTabDragOver = (e: DragEvent, id: string): void => {
    if (!this.#draggingPageId || this.#draggingPageId === id) return;
    e.preventDefault();
    const side = this.#dragOverSideFor(e);
    if (this.#dragOverPageId !== id || this.#dragOverSide !== side) {
      this.#dragOverPageId = id;
      this.#dragOverSide = side;
      this.requestUpdate();
    }
  };

  #onTabDrop = (e: DragEvent, id: string): void => {
    e.preventDefault();
    e.stopPropagation();
    const fromId = this.#draggingPageId;
    const side = this.#dragOverSide;
    this.#draggingPageId = null;
    this.#dragOverPageId = null;
    this.#dragOverSide = null;
    if (!fromId || fromId === id) {
      this.requestUpdate();
      return;
    }

    let moved: boolean;
    if (side === 'after') {
      const pages = this.#store.pages.value;
      const targetIndex = pages.findIndex((p) => p.id === id);
      const nextPage = pages[targetIndex + 1];
      // "After this tab" with no next tab means the very end of the list.
      moved = nextPage ? this.#store.reorderPage(fromId, nextPage.id) : this.#store.reorderPageToEnd(fromId);
    } else {
      moved = this.#store.reorderPage(fromId, id);
    }
    if (moved) this.#flashMovedTab(fromId);
    else this.requestUpdate();
  };

  #onTabDragEnd = (): void => {
    this.#draggingPageId = null;
    this.#dragOverPageId = null;
    this.#dragOverSide = null;
    this.requestUpdate();
  };

  #flashMovedTab(pageId: string): void {
    this.#justMovedPageId = pageId;
    this.requestUpdate();
    setTimeout(() => {
      if (this.#justMovedPageId === pageId) {
        this.#justMovedPageId = null;
        this.requestUpdate();
      }
    }, 1500);
  }

  updated(): void {
    void this.#redraw();
    if (this.#focusTextEdit && this.#textInputRef.value) {
      this.#focusTextEdit = false;
      this.#textInputRef.value.focus();
      this.#textInputRef.value.select();
    }
  }

  /**
   * canvas.width/height are physical (device) pixels — e.g. 600 for a
   * 300 CSS-px screenshot captured at devicePixelRatio 2. Dividing by DPR
   * here means "100% zoom" actually renders at the same on-screen size the
   * captured region had, rather than 1 canvas-pixel = 1 CSS-pixel (which
   * would show HiDPI screenshots at 2x/3x their real size).
   */
  #displayScale(): number {
    return this.#store.zoom.value / (window.devicePixelRatio || 1);
  }

  #canvasWrapStyle(): string {
    const canvas = this.#canvasRef.value;
    if (!canvas || !canvas.width) return '';
    const scale = this.#displayScale();
    return `width:${canvas.width * scale}px; height:${canvas.height * scale}px;`;
  }

  #canvasCursorCss(): string {
    if (this.#spaceHeld) return this.#pan ? 'grabbing' : 'grab';
    return this.#canvasCursor || (this.#store.activeTool.value === 'select' ? 'default' : 'crosshair');
  }

  render() {
    const page = this.#store.activePage;
    const style = this.#currentStyle();
    const hasShapes = this.#store.selectedIds.length > 0;
    const noImage = !page.imageDataUrl;

    return html`
      <button
        class="theme-toggle"
        title=${`Theme: ${THEME_LABEL[this.#theme]} (click to change)`}
        aria-label="Toggle color theme"
        @click=${() => this.#cycleTheme()}
      >
        ${THEME_ICON[this.#theme]}
      </button>
      <div
        class="tabs"
        @dragover=${(e: DragEvent) => {
          if (this.#draggingPageId) e.preventDefault();
        }}
        @drop=${(e: DragEvent) => {
          // Fires for a drop anywhere in the tab bar not claimed by a
          // specific tab (which stopPropagation()s its own drop) — i.e.
          // the empty space after the last tab, and the + button. Treated
          // uniformly as "move to end" so there's always a generously-sized
          // target for putting a page last, not just the narrow + button.
          e.preventDefault();
          const fromId = this.#draggingPageId;
          this.#draggingPageId = null;
          this.#dragOverPageId = null;
          this.#dragOverSide = null;
          if (fromId) {
            const moved = this.#store.reorderPageToEnd(fromId);
            if (moved) this.#flashMovedTab(fromId);
            else this.requestUpdate();
          } else {
            this.requestUpdate();
          }
        }}
      >
        ${this.#store.pages.value.map(
          (p, i) => html`
            <div
              class="tab ${p.id === page.id ? 'active' : ''} ${
                this.#dragOverPageId === p.id ? `drag-over-${this.#dragOverSide}` : ''
              } ${this.#justMovedPageId === p.id ? 'just-moved' : ''}"
              draggable="true"
              @click=${() => this.#switchPage(p.id)}
              @dragstart=${(e: DragEvent) => this.#onTabDragStart(e, p.id)}
              @dragover=${(e: DragEvent) => this.#onTabDragOver(e, p.id)}
              @drop=${(e: DragEvent) => this.#onTabDrop(e, p.id)}
              @dragend=${this.#onTabDragEnd}
            >
              ${this.#pageLabel(i)}
              <span class="tab-close" title="Close page" @click=${(e: Event) => this.#closePage(e, p.id)}>×</span>
            </div>
          `
        )}
        <div class="tab-add" @click=${() => this.#addPage()} title="Add page">+</div>
      </div>

      <div class="toolbar">
        ${TOOLS.map(
          (t) => html`
            <button
              class=${this.#store.activeTool.value === t.type ? 'active' : ''}
              title="${t.label} (${t.key.toUpperCase()})"
              @click=${() => this.#setTool(t.type)}
            >
              ${t.icon} ${t.label} (${t.key})
            </button>
          `
        )}
        <div class="spacer" style="width:8px; flex:0"></div>
        <div class="group">
          <button ?disabled=${!hasShapes} @click=${() => this.#store.deleteSelectedShapes()} title="Delete selected shapes (Delete/Backspace)">
            🗑 Delete
          </button>
          <button ?disabled=${!hasShapes} @click=${() => this.#store.duplicateSelectedShapes()} title="Duplicate selected shapes (Cmd/Ctrl+D)">
            ⧉
          </button>
          <button ?disabled=${!hasShapes} @click=${() => this.#store.reorderSelectedShapes('front')} title="Bring to front (Cmd/Ctrl+])">
            ⤒
          </button>
          <button ?disabled=${!hasShapes} @click=${() => this.#store.reorderSelectedShapes('back')} title="Send to back (Cmd/Ctrl+[)">
            ⤓
          </button>
        </div>
        <div class="spacer" style="width:8px; flex:0"></div>
        ${COLORS.map(
          (c) => html`
            <button
              class="swatch ${style.color.toLowerCase() === c ? 'active' : ''}"
              style="background:${c}"
              title=${c}
              @click=${() => this.#applyStyle({ color: c })}
            ></button>
          `
        )}
        <input
          class="color-input"
          type="color"
          title="Custom color"
          .value=${live(style.color)}
          @change=${(e: Event) => this.#applyStyle({ color: (e.target as HTMLInputElement).value })}
        />
        ${EyeDropperCtor
          ? html`<button @click=${this.#pickColorFromScreen} title="Pick a color from the screen">💧</button>`
          : ''}
        <div class="spacer" style="width:8px; flex:0"></div>
        ${this.#styleContextIsText()
          ? html`
              <select
                title="Font size ([ / ])"
                @change=${(e: Event) => this.#applyStyle({ fontSize: Number((e.target as HTMLSelectElement).value) })}
              >
                ${[...new Set([...FONT_SIZES, style.fontSize])].sort((a, b) => a - b).map(
                  (s) => html`<option value=${s} ?selected=${style.fontSize === s}>${s}px</option>`
                )}
              </select>
            `
          : html`
              <select
                title="Line thickness ([ / ])"
                @change=${(e: Event) => this.#applyStyle({ lineWidth: Number((e.target as HTMLSelectElement).value) })}
              >
                ${[...new Set([...LINE_WIDTHS, style.lineWidth])].sort((a, b) => a - b).map(
                  (w) => html`<option value=${w} ?selected=${style.lineWidth === w}>${w}px</option>`
                )}
              </select>
            `}
        <button
          class=${style.fill ? 'active' : ''}
          title="Fill rectangles/ellipses; solid background behind text"
          @click=${() => this.#applyStyle({ fill: !style.fill })}
        >
          ◼ Fill
        </button>
        <div class="spacer"></div>
        <div class="group">
          <button ?disabled=${noImage} @click=${() => this.#transformImage('rotate-ccw')} title="Rotate left">⟲</button>
          <button ?disabled=${noImage} @click=${() => this.#transformImage('rotate-cw')} title="Rotate right">⟳</button>
          <button ?disabled=${noImage} @click=${() => this.#transformImage('flip-h')} title="Flip horizontally">⇋</button>
          <button ?disabled=${noImage} @click=${() => this.#transformImage('flip-v')} title="Flip vertically">⇵</button>
        </div>
        <div class="zoom-controls">
          <button @click=${() => this.#store.zoomOut()} title="Zoom out (Cmd/Ctrl+-, Cmd/Ctrl+scroll, pinch)">−</button>
          <span class="zoom-level" @dblclick=${() => this.#store.zoomReset()} title="Double-click to reset">
            ${Math.round(this.#store.zoom.value * 100)}%
          </span>
          <button @click=${() => this.#store.zoomIn()} title="Zoom in (Cmd/Ctrl+=, Cmd/Ctrl+scroll, pinch)">+</button>
          <button @click=${() => this.#fitToWindow()} title="Fit to window (F)">Fit</button>
        </div>
        <button @click=${() => this.#store.undo()} title="Undo (Cmd/Ctrl+Z)">↶ Undo</button>
        <button @click=${() => this.#store.redo()} title="Redo (Shift+Cmd/Ctrl+Z)">↷ Redo</button>
        <button @click=${() => this.#store.clearActivePage()}>Clear</button>
        <button @click=${this.#newDocument} title="Wipe all pages and start fresh">New document</button>
        <button @click=${this.#saveDocument} title="Save the whole document (all pages) to a file (Cmd/Ctrl+S)">Save</button>
        <label style="display:inline-flex; align-items:center; cursor:pointer; border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:13px;" title="Load a document file, replacing everything currently open (Cmd/Ctrl+O)">
          <input
            ${ref(this.#loadDocumentInputRef)}
            type="file"
            accept="application/json,.json"
            style="display:none"
            @change=${this.#onLoadDocumentPick}
          />
          Load…
        </label>
        <label style="display:inline-flex; align-items:center; cursor:pointer; border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:13px;">
          <input type="file" accept="image/*" style="display:none" @change=${this.#onFilePick} />
          Open image…
        </label>
        <button class="button-primary" ?disabled=${noImage} @click=${this.#copyImage}>📋 Copy Image</button>
        <button class="button-primary" ?disabled=${noImage} @click=${this.#copyCurrentPage}>📋 Copy Current Page</button>
        <button ?disabled=${noImage} @click=${this.#openPreview}>Preview</button>
        <button ?disabled=${noImage} @click=${this.#download}>Download</button>
      </div>

      <div
        class="stage"
        ${ref(this.#stageRef)}
        @pointerdown=${this.#onStagePointerDown}
        @pointermove=${this.#onStagePointerMove}
        @pointerup=${this.#onStagePointerUp}
        @wheel=${this.#onWheel}
      >
        ${page.imageDataUrl
          ? html`
              <div class="canvas-wrap ${this.#spaceHeld ? 'panning' : ''}" style=${this.#canvasWrapStyle()}>
                <canvas
                  ${ref(this.#canvasRef)}
                  style="transform: scale(${this.#displayScale()}); cursor: ${this.#canvasCursorCss()}"
                  @pointerdown=${this.#onPointerDown}
                  @pointermove=${this.#onPointerMove}
                  @pointerup=${this.#onPointerUp}
                  @dblclick=${this.#onDoubleClick}
                ></canvas>
                ${this.#regionActions()} ${this.#textEditor()}
              </div>
            `
          : html`<div class="empty">Paste a screenshot (Cmd/Ctrl+V), drag one in, or use "Open image…" above.</div>`}
      </div>
      <div class="status">${this.#statusMsg}</div>

      ${this.#previewUrl
        ? html`
            <div class="preview-overlay" @click=${this.#closePreview}>
              <div class="preview-card" @click=${(e: Event) => e.stopPropagation()}>
                <div class="preview-header">
                  <span>Preview — what "Copy Image" will copy</span>
                  <div class="preview-header-controls">
                    <div class="zoom-controls">
                      <button @click=${() => this.#store.previewZoomOut()} title="Zoom out">−</button>
                      <span
                        class="zoom-level"
                        @dblclick=${() => this.#store.previewZoomReset()}
                        title="Double-click to reset"
                      >
                        ${Math.round(this.#store.previewZoom.value * 100)}%
                      </span>
                      <button @click=${() => this.#store.previewZoomIn()} title="Zoom in">+</button>
                    </div>
                    <button @click=${this.#closePreview} title="Close">✕</button>
                  </div>
                </div>
                <div class="preview-body">
                  <div class="preview-img-wrap" style=${this.#previewWrapStyle()}>
                    <img
                      src=${this.#previewUrl}
                      alt="Preview of copied image"
                      style="transform: scale(${this.#previewDisplayScale()})"
                    />
                  </div>
                </div>
              </div>
            </div>
          `
        : ''}
    `;
  }
}

customElements.define('screen-marker', ScreenMarker);
