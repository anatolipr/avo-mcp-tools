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
  drawRegionOverlay,
  drawSelectionOutline,
  drawShapes,
  flattenPage,
  flattenPagesToCanvas,
  hitTestShapes,
  layoutTag,
  sceneBounds,
  shapeBounds,
  shapesInRect,
  transformImageDataUrl,
  transformShape,
  type ImageTransform,
} from './render.js';
import { copyImageOnly, copyRegion, downloadImage } from './export.js';
import { documentValue, downloadDocument, parseDocumentValue, readDocumentFile } from './save-load.js';
import { screenMarkerStyles } from './styles.js';
import {
  cloudNameFromHash,
  createPresentationLink,
  listRecentDocuments,
  loadCloudDocument,
  loadPublicDocument,
  mountAccountUi,
  openLiveChannel,
  type LiveChannel,
  publicToken,
  saveCloudDocument,
  setCloudNameInHash,
  showFilePicker,
} from './cloud.js';
import './presenter.js';
import type { Slide } from './presenter.js';
import { pageThumbnail, recentThumbnail, rememberRecentThumbnail } from './thumbs.js';
import { TAG_ARROWS, type Page, type Point, type Rect, type Shape, type ShapeType, type TagArrow, type Tool } from './types.js';

const TOOLS: { type: Tool; label: string; icon: string; key: string }[] = [
  { type: 'select', label: 'Select', icon: '↖', key: 'v' },
  { type: 'rect', label: 'Rectangle', icon: '▭', key: 'r' },
  { type: 'ellipse', label: 'Ellipse', icon: '◯', key: 'o' },
  { type: 'arrow', label: 'Arrow', icon: '↗', key: 'a' },
  { type: 'line', label: 'Line', icon: '╱', key: 'l' },
  { type: 'text', label: 'Text', icon: 'T', key: 't' },
  { type: 'tag', label: 'Tag', icon: '💬', key: 'g' },
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
const SIZED_BY_FONT: ShapeType[] = ['text', 'step', 'tag'];
const TAG_SIDE_POSITIONS: Record<'top' | 'right' | 'bottom' | 'left', TagArrow[]> = {
  top: ['top-left', 'top-center', 'top-right'],
  right: ['right-top', 'right-center', 'right-bottom'],
  bottom: ['bottom-left', 'bottom-center', 'bottom-right'],
  left: ['left-top', 'left-center', 'left-bottom'],
};
const TAG_ARROW_LABEL: Record<TagArrow, string> = {
  'top-left': '↑ Top left',
  'top-center': '↑ Top',
  'top-right': '↑ Top right',
  'right-top': '→ Right top',
  'right-center': '→ Right',
  'right-bottom': '→ Right bottom',
  'bottom-right': '↓ Bottom right',
  'bottom-center': '↓ Bottom',
  'bottom-left': '↓ Bottom left',
  'left-bottom': '← Left bottom',
  'left-center': '← Left',
  'left-top': '← Left top',
  none: 'No pointer (note)',
};

/** Largest editor canvas side, in image pixels (keeps very low zoom levels from allocating huge canvases). */
const MAX_AREA_SIDE = 8192;

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

type TextEdit = {
  kind: 'text' | 'tag' | 'step';
  id: string | null;
  anchor: Point;
  value: string;
  color: string;
  fontSize: number;
  fill: boolean;
  tagArrow: TagArrow;
};

function sortedRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
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

/** Shift-drag for lines/arrows: snap the direction from `a` to the nearest 45°. */
function snapAngle(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len };
}

/** Shift-drag for boxes: make the box from `a` to `b` square (keeping the drag's direction). */
function squareFrom(a: Point, b: Point): Point {
  const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return { x: a.x + Math.sign(b.x - a.x || 1) * side, y: a.y + Math.sign(b.y - a.y || 1) * side };
}

const BOX_DRAWN: ShapeType[] = ['rect', 'ellipse', 'highlight', 'blur'];

type MenuItem =
  | { label: string; run: () => void; shortcut?: string; disabled?: boolean; danger?: boolean }
  | { colors: true }
  | 'sep';

type SaveState = 'saved' | 'saving' | 'dirty' | 'error' | 'conflict' | 'remote';

function relativeTime(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
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
  #textInputRef = createRef<HTMLInputElement | HTMLTextAreaElement>();
  #loadDocumentInputRef = createRef<HTMLInputElement>();
  #image: { src: string; img: HTMLImageElement } | null = null;
  // The canvas covers this box of the scene, in image coordinates (the
  // image sits at 0,0; the margin around it can hold tags and shapes).
  #area: Rect = { x: 0, y: 0, w: 0, h: 0 };
  // The image plus anything drawn past it — what exports include.
  #content: Rect = { x: 0, y: 0, w: 0, h: 0 };

  // Transient interaction state — never part of the document or undo history.
  #drawing = false;
  #currentPoints: Point[] = [];
  #dragStart: Point | null = null;
  #shapeDrag: ShapeDrag | null = null;
  // Region select is tied to a page id so it never leaks onto another page after switching tabs.
  #region: { pageId: string; rect: Rect } | null = null;
  #regionDrag: { grab: BoxGrab | 'create'; start: Point; orig: Rect; additive: boolean } | null = null;
  #textEdit: TextEdit | null = null;
  #focusTextEdit = false;
  #selectOnFocus = true;
  #spaceHeld = false;
  #spacePanned = false;
  #pan: { x: number; y: number; left: number; top: number } | null = null;
  #canvasCursor = '';
  #stageObserver = new ResizeObserver(() => this.requestUpdate());

  #statusMsg = '';
  #previewUrl: string | null = null;
  #previewSize: { width: number; height: number } | null = null;
  #draggingPageId: string | null = null;
  #dragOverPageId: string | null = null;
  #dragOverSide: 'before' | 'after' | null = null;
  #justMovedPageId: string | null = null;
  #theme: ThemeMode = loadTheme();
  #presenting: { slides: Slide[]; index: number; publicView: boolean; heading: string; message: string } | null = null;
  #cloudBusy = false;
  // Autosave / live channel for the open cloud document.
  #saveState: SaveState = 'saved';
  #lastSavedPages: Page[] | null = null;
  #autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  #channel: { name: string; ch: LiveChannel } | null = null;
  #peers = 0;
  #recent: { name: string; openedAt: number }[] | null = null;
  #thumbUrls = new WeakMap<Page, string | null>();
  #notesOpen = false;
  #menu: { x: number; y: number; items: MenuItem[] } | null = null;
  #cloudName: string | null = cloudNameFromHash();
  // The document behind a public link, kept for "Edit a copy".
  #publicDoc: { pages: Page[]; activePageId: string } | null = null;

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
    document.addEventListener('folderfoo-file-open', this.#onCloudFileChosen);
    if (publicToken) void this.#openPublicPresentation(publicToken);
    void mountAccountUi().then(() => this.#loadRecent());
    window.addEventListener('folderfoo-auth-change', this.#onAuthChange);
    this.#store.restore().then(async () => {
      this.requestUpdate();
      await this.updateComplete;
      if (this.#stageRef.value) this.#stageObserver.observe(this.#stageRef.value);
      await this.#redraw();
      this.#fitToWindow();
      const name = cloudNameFromHash();
      if (name && !publicToken) void this.#openCloudDocument(name, { confirmReplace: false });
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('paste', this.#onPaste);
    window.removeEventListener('keydown', this.#onKeydown);
    window.removeEventListener('keyup', this.#onKeyup);
    window.removeEventListener('blur', this.#onWindowBlur);
    document.removeEventListener('folderfoo-file-open', this.#onCloudFileChosen);
    window.removeEventListener('folderfoo-auth-change', this.#onAuthChange);
    this.#stageObserver.disconnect();
    this.#channel?.ch.close();
    clearTimeout(this.#autosaveTimer);
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
    // A Space tap (no drag) cycles a selected tag's pointer clockwise;
    // otherwise it toggles the preview, as before Space+drag panning existed.
    const tag = this.#singleSelectedTag();
    if (!this.#spacePanned && tag) {
      const order = TAG_ARROWS.filter((a) => a !== 'none');
      const i = order.indexOf((tag.tagArrow ?? 'bottom-center') as (typeof order)[number]);
      this.#applyStyle({ tagArrow: order[(i + 1) % order.length]! });
    } else if (!this.#spacePanned && this.#store.activePage.imageDataUrl) {
      this.#openPreview();
    }
    this.requestUpdate();
  };

  #onKeydown = (e: KeyboardEvent) => {
    if (this.#presenting) return;
    if (this.#menu) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.#closeMenu();
      }
      return;
    }
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
    const single = selectedIds.length === 1 ? this.#store.selectedShapes[0]! : null;
    const editable = single && (single.type === 'text' || single.type === 'tag' || single.type === 'step') ? single : null;

    // Enter edits the one selected label / tag / step marker (as double-click does);
    // with a step marker selected, typing a digit starts editing its number.
    if (editable && !mod && !e.altKey) {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.#startTextEdit(editable);
        return;
      }
      if (editable.type === 'step' && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        this.#startTextEdit(editable, undefined, 'text', e.key);
        return;
      }
    }

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

    if (e.key.startsWith('Arrow') && e.shiftKey && !mod && !e.altKey && this.#singleSelectedTag()) {
      // Shift+arrow jumps a selected tag's pointer to that side, then steps
      // along it on repeat presses (e.g. ← ← ←: left-top, left-center, left-bottom).
      e.preventDefault();
      const side = ({ ArrowUp: 'top', ArrowRight: 'right', ArrowDown: 'bottom', ArrowLeft: 'left' } as const)[
        e.key as 'ArrowUp' | 'ArrowRight' | 'ArrowDown' | 'ArrowLeft'
      ];
      const options = TAG_SIDE_POSITIONS[side];
      const i = options.indexOf(this.#singleSelectedTag()!.tagArrow ?? 'bottom-center');
      this.#applyStyle({ tagArrow: options[i === -1 ? 0 : (i + 1) % options.length]! });
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
    } else if (key === 'd' && e.shiftKey) {
      e.preventDefault();
      this.#duplicatePage(this.#store.activePageId.value);
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
      this.#setCloudName(null);
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
    return tool !== 'select';
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
    if (type === 'tag') shape.tagArrow = this.#store.activeTagArrow.value;
    return shape;
  }

  async #redraw(): Promise<void> {
    const page = this.#store.activePage;
    const canvas = this.#canvasRef.value;
    if (!canvas || !page.imageDataUrl) return;

    const img = await this.#loadPageImage(page.imageDataUrl);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const shapes = this.#displayShapes();
    const content = sceneBounds(W, H, shapes);
    const area = this.#editorArea(W, H, content);
    const prev = this.#area;
    const sizeChanged = prev.x !== area.x || prev.y !== area.y || canvas.width !== area.w || canvas.height !== area.h;
    this.#area = area;
    this.#content = content;
    if (canvas.width !== area.w || canvas.height !== area.h) {
      canvas.width = area.w;
      canvas.height = area.h;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(-area.x, -area.y);
    // The empty space around the image stays transparent (the stage shows
    // through); only the image itself gets a drop shadow to stand out.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 16 / this.#displayScale();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    ctx.drawImage(img, 0, 0);
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
    if (this.#store.selection.value?.type === 'image') drawImageSelectionOutline(ctx, W, H);

    const region = this.#activeRegion();
    if (region) drawRegionOverlay(ctx, region, HANDLE_CSS_PX * unit, area);
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

  /**
   * The scene box the editor canvas covers, in image coordinates: at least
   * the whole visible stage (centered on the image, so empty space all
   * around is usable for tags and shapes without the image moving), grown
   * to fit any content drawn beyond it.
   */
  #editorArea(W: number, H: number, content: Rect): Rect {
    const stage = this.#stageRef.value;
    const scale = this.#displayScale();
    const viewW = Math.min(MAX_AREA_SIDE, Math.max(W, ((stage?.clientWidth ?? 0) - 32) / scale));
    const viewH = Math.min(MAX_AREA_SIDE, Math.max(H, ((stage?.clientHeight ?? 0) - 32) / scale));
    const edge = 24 / scale;
    const x1 = Math.floor(Math.min(W / 2 - viewW / 2, content.x - edge));
    const y1 = Math.floor(Math.min(H / 2 - viewH / 2, content.y - edge));
    const x2 = Math.ceil(Math.max(W / 2 + viewW / 2, content.x + content.w + edge));
    const y2 = Math.ceil(Math.max(H / 2 + viewH / 2, content.y + content.h + edge));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  /** Lets an image point land at a given screen position after a zoom/area change (only possible where the stage can scroll). */
  async #settleLayout(): Promise<void> {
    await this.updateComplete;
    await this.#redraw();
    await this.updateComplete;
  }

  #handleTolerance(): number {
    return HANDLE_CSS_PX / this.#displayScale();
  }

  #canvasPoint(e: PointerEvent | MouseEvent): Point {
    const canvas = this.#canvasRef.value!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX + this.#area.x, y: (e.clientY - rect.top) * scaleY + this.#area.y };
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
    const ix = this.#area.x + ((clientX - before.left) / before.width) * canvas.width;
    const iy = this.#area.y + ((clientY - before.top) / before.height) * canvas.height;
    this.#store.setZoom(zoom);
    await this.#settleLayout();
    const after = canvas.getBoundingClientRect();
    stage.scrollLeft += after.left + ((ix - this.#area.x) / canvas.width) * after.width - clientX;
    stage.scrollTop += after.top + ((iy - this.#area.y) / canvas.height) * after.height - clientY;
  }

  /**
   * Zooms so the page content (the image plus anything drawn past it, not
   * the empty margin) fits the stage, never above 100%, then centers it.
   */
  async #fitToWindow(): Promise<void> {
    const canvas = this.#canvasRef.value;
    const stage = this.#stageRef.value;
    const c = this.#content;
    if (!canvas || !stage || !canvas.width || !c.w || !this.#store.activePage.imageDataUrl) return;
    const dpr = window.devicePixelRatio || 1;
    const availW = stage.clientWidth - 32;
    const availH = stage.clientHeight - 32;
    if (availW <= 0 || availH <= 0) return;
    this.#store.setZoom(Math.min(1, (availW * dpr) / c.w, (availH * dpr) / c.h));
    await this.#settleLayout();
    const rect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const scale = rect.width / canvas.width;
    const cx = rect.left + (c.x - this.#area.x + c.w / 2) * scale;
    const cy = rect.top + (c.y - this.#area.y + c.h / 2) * scale;
    stage.scrollLeft += cx - (stageRect.left + stage.clientWidth / 2);
    stage.scrollTop += cy - (stageRect.top + stage.clientHeight / 2);
  }

  #onPointerDown = (e: PointerEvent) => {
    if (this.#spaceHeld || !this.#store.activePage.imageDataUrl || e.button !== 0) return;
    this.#commitTextEdit();
    const tool = this.#store.activeTool.value;
    const pt = this.#canvasPoint(e);
    const capture = () => (e.target as Element).setPointerCapture(e.pointerId);

    if (tool === 'select') {
      // Priority: the selected shape's handles, then the region's edges and
      // corners, then any shape, then the region's body; anything else
      // starts a new region (which also selects the shapes it touches).
      const selected = this.#store.selectedShapes;
      if (selected.length === 1) {
        const handle = this.#shapeHandleAt(selected[0]!, pt);
        if (handle !== null) {
          this.#shapeDrag = { kind: 'resize', orig: selected[0]!, grab: handle, start: pt, draft: null };
          capture();
          return;
        }
      }
      const region = this.#activeRegion();
      const regionGrab = region ? boxGrabAt(region, pt, this.#handleTolerance()) : null;
      if (region && regionGrab && regionGrab !== 'move') {
        this.#regionDrag = { grab: regionGrab, start: pt, orig: region, additive: false };
        capture();
        return;
      }
      const hit = hitTestShapes(this.#store.activePage.shapes, pt);
      if (hit) {
        const wasSelected = this.#store.selectedIds.includes(hit.id);
        if (e.shiftKey) this.#store.toggleShapeSelected(hit.id);
        else if (!wasSelected) this.#store.selectShapes([hit.id]);
        if (!wasSelected) this.#clearRegion();
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
      if (region && regionGrab === 'move') {
        this.#regionDrag = { grab: 'move', start: pt, orig: region, additive: false };
        capture();
        return;
      }
      this.#region = null;
      this.#regionDrag = { grab: 'create', start: pt, orig: { x: pt.x, y: pt.y, w: 0, h: 0 }, additive: e.shiftKey };
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

    if (tool === 'tag') {
      e.preventDefault(); // same focus reason as the Text tool above
      const hit = hitTestShapes(this.#store.activePage.shapes, pt);
      if (hit?.type === 'tag') this.#startTextEdit(hit);
      else this.#startTextEdit(null, pt, 'tag');
      return;
    }

    if (tool === 'step') {
      const hit = hitTestShapes(this.#store.activePage.shapes, pt);
      if (hit?.type === 'step') {
        // Like the Text tool on a label: clicking an existing marker edits its number.
        e.preventDefault();
        this.#startTextEdit(hit);
        return;
      }
      const step = this.#newShape('step', [pt]);
      step.stepNumber = this.#store.takeNextStepNumber();
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

    if (this.#regionDrag) {
      this.#onRegionDrag(pt);
      return;
    }

    const drag = this.#shapeDrag;
    if (drag?.kind === 'move') {
      let dx = pt.x - drag.start.x;
      let dy = pt.y - drag.start.y;
      // Shift locks the move to the dominant axis.
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      drag.delta = { x: dx, y: dy };
      void this.#redraw();
      return;
    }
    if (drag?.kind === 'resize') {
      drag.draft = this.#resizedShape(drag, pt, e.shiftKey);
      void this.#redraw();
      return;
    }

    if (this.#drawing) {
      if (tool === 'pen') {
        this.#currentPoints.push(pt);
      } else {
        const a = this.#currentPoints[0]!;
        let b = pt;
        // Shift: lines/arrows snap to 45°, boxes become squares/circles.
        if (e.shiftKey && (tool === 'line' || tool === 'arrow')) b = snapAngle(a, pt);
        else if (e.shiftKey && BOX_DRAWN.includes(tool as ShapeType)) b = squareFrom(a, pt);
        this.#currentPoints = [a, b];
      }
      void this.#redraw();
      return;
    }

    this.#updateHoverCursor(pt);
  };

  #resizedShape(drag: Extract<ShapeDrag, { kind: 'resize' }>, pt: Point, shift = false): Shape {
    const o = drag.orig;
    if (drag.grab === 0 || drag.grab === 1) {
      const points = [...o.points];
      // Shift snaps the dragged end to 45° around the other end.
      points[drag.grab] = shift ? snapAngle(o.points[1 - drag.grab]!, pt) : pt;
      return { ...o, points };
    }
    if (drag.grab === 'move') return o;
    const from = boundsRect(o);
    let [l, t, r, b] = resizeBox(from, drag.grab, pt.x - drag.start.x, pt.y - drag.start.y);
    if (shift && drag.grab.length === 2 && from.w > 0 && from.h > 0) {
      // Shift on a corner keeps the aspect ratio, anchored at the opposite corner.
      const ax = drag.grab.includes('w') ? from.x + from.w : from.x;
      const ay = drag.grab.includes('n') ? from.y + from.h : from.y;
      const k = Math.max(Math.abs(r - l) / from.w, Math.abs(b - t) / from.h);
      const w = from.w * k;
      const h = from.h * k;
      const mx = drag.grab.includes('w') ? -1 : 1;
      const my = drag.grab.includes('n') ? -1 : 1;
      [l, t, r, b] = [ax, ay, ax + mx * w, ay + my * h];
    }
    return mapShapeToBox(o, from, sortedRect(l, t, r, b));
  }

  #updateHoverCursor(pt: Point): void {
    let cursor = 'crosshair';
    const tool = this.#store.activeTool.value;
    if (tool === 'select') {
      cursor = 'default';
      const selected = this.#store.selectedShapes;
      const handle = selected.length === 1 ? this.#shapeHandleAt(selected[0]!, pt) : null;
      const region = this.#activeRegion();
      const regionGrab = region ? boxGrabAt(region, pt, this.#handleTolerance()) : null;
      if (handle === 0 || handle === 1) cursor = 'grab';
      else if (handle) cursor = GRAB_CURSOR[handle];
      else if (regionGrab && regionGrab !== 'move') cursor = GRAB_CURSOR[regionGrab];
      else if (hitTestShapes(this.#store.activePage.shapes, pt)) cursor = 'move';
      else if (regionGrab === 'move') cursor = 'move';
    } else if (tool === 'text') {
      cursor = 'text';
    }
    if (cursor !== this.#canvasCursor) {
      this.#canvasCursor = cursor;
      this.requestUpdate();
    }
  }

  #onPointerUp = (e: PointerEvent) => {
    const regionDrag = this.#regionDrag;
    if (regionDrag) {
      this.#regionDrag = null;
      const r = this.#region?.rect;
      if (regionDrag.grab === 'create') {
        if (!r || r.w < CLICK_THRESHOLD || r.h < CLICK_THRESHOLD) {
          // A plain click on empty space: select the image (if on it), or nothing.
          this.#region = null;
          if (!regionDrag.additive) {
            this.#store.selection.set(this.#insideImage(regionDrag.start) ? { type: 'image' } : null);
          }
        } else {
          const hits = shapesInRect(this.#store.activePage.shapes, r).map((s) => s.id);
          this.#store.selectShapes(regionDrag.additive ? [...new Set([...this.#store.selectedIds, ...hits])] : hits);
        }
      }
      this.requestUpdate();
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
      else if (hit) this.#store.selection.set({ type: 'shapes', ids: [hit.id] });
      else this.#store.selection.set(start && this.#insideImage(start) ? { type: 'image' } : null);
    } else if (points.length >= 2) {
      this.#store.addShape(this.#newShape(tool, points));
    }
    void this.#redraw();
  };

  #insideImage(p: Point): boolean {
    const img = this.#image?.img;
    return !!img && p.x >= 0 && p.y >= 0 && p.x <= img.naturalWidth && p.y <= img.naturalHeight;
  }

  #onDoubleClick = (e: MouseEvent) => {
    if (!this.#store.activePage.imageDataUrl) return;
    const hit = hitTestShapes(this.#store.activePage.shapes, this.#canvasPoint(e));
    if (hit?.type === 'text' || hit?.type === 'tag' || hit?.type === 'step') this.#startTextEdit(hit);
  };

  #singleSelectedTag(): Shape | null {
    const selected = this.#store.selectedShapes;
    return selected.length === 1 && selected[0]!.type === 'tag' ? selected[0]! : null;
  }

  // ---------- inline text editing ----------

  #startTextEdit(shape: Shape | null, anchor?: Point, kind: 'text' | 'tag' = 'text', initialValue?: string): void {
    this.#commitTextEdit();
    this.#textEdit = shape
      ? {
          kind: shape.type === 'tag' || shape.type === 'step' ? shape.type : 'text',
          id: shape.id,
          anchor: shape.points[0]!,
          value: shape.type === 'step' ? String(shape.stepNumber ?? 1) : (shape.label ?? ''),
          color: shape.color,
          fontSize: shape.fontSize ?? 18,
          fill: !!shape.fill,
          tagArrow: shape.tagArrow ?? 'bottom-center',
        }
      : {
          kind,
          id: null,
          anchor: anchor!,
          value: '',
          color: this.#store.activeColor.value,
          fontSize: this.#store.activeFontSize.value,
          fill: this.#store.activeFill.value,
          tagArrow: this.#store.activeTagArrow.value,
        };
    if (initialValue !== undefined) this.#textEdit.value = initialValue;
    if (shape) this.#store.selectShapes([shape.id]);
    this.#focusTextEdit = true;
    // Typing straight into a selected marker shouldn't select (and so overwrite) the first digit.
    this.#selectOnFocus = initialValue === undefined;
    this.requestUpdate();
  }

  /** Saves the open text editor (if any). An emptied existing label deletes that text shape. */
  #commitTextEdit(): void {
    const edit = this.#textEdit;
    if (!edit) return;
    this.#textEdit = null;
    const label = edit.value.trim();
    if (edit.kind === 'step') {
      const shape = this.#store.activePage.shapes.find((s) => s.id === edit.id);
      const n = Number.parseInt(label, 10);
      if (shape && Number.isFinite(n) && n !== shape.stepNumber) this.#store.replaceShape({ ...shape, stepNumber: n });
      this.requestUpdate();
      return;
    }
    if (edit.id) {
      const shape = this.#store.activePage.shapes.find((s) => s.id === edit.id);
      if (shape && !label) this.#store.deleteShapes([edit.id]);
      else if (shape && label !== shape.label) this.#store.replaceShape({ ...shape, label });
    } else if (label) {
      const shape = this.#newShape(edit.kind, [edit.anchor]);
      shape.label = label;
      shape.color = edit.color;
      shape.fontSize = edit.fontSize;
      if (edit.kind === 'tag') shape.tagArrow = edit.tagArrow;
      else shape.fill = edit.fill;
      this.#store.addShape(shape);
      this.#store.selectShapes([shape.id]);
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
    // Tags are multi-line: Shift+Enter adds a line, Enter saves.
    if (e.key === 'Enter' && !e.shiftKey) {
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
    const ox = this.#area.x;
    const oy = this.#area.y;
    if (edit.kind === 'step') {
      const r = edit.fontSize * 0.85;
      const style = [
        `left:${(edit.anchor.x - r - ox) * scale}px`,
        `top:${(edit.anchor.y - r - oy) * scale}px`,
        `width:${r * 2 * scale}px`,
        `height:${r * 2 * scale}px`,
        `font-size:${r * scale}px`,
        `color:${contrastColor(edit.color)}`,
        `background:${edit.color}`,
      ].join(';');
      return html`
        <input
          ${ref(this.#textInputRef)}
          class="text-editor step-editor"
          style=${style}
          inputmode="numeric"
          .value=${live(edit.value)}
          @input=${(e: Event) => {
            edit.value = (e.target as HTMLInputElement).value.replace(/[^0-9-]/g, '');
            this.requestUpdate();
          }}
          @keydown=${this.#onTextKeydown}
          @blur=${() => this.#commitTextEdit()}
          @pointerdown=${(e: Event) => e.stopPropagation()}
        />
      `;
    }
    if (edit.kind === 'tag') {
      const L = layoutTag({
        id: '',
        type: 'tag',
        color: edit.color,
        lineWidth: 1,
        points: [edit.anchor],
        label: edit.value,
        fontSize: edit.fontSize,
        tagArrow: edit.tagArrow,
      });
      const style = [
        `left:${(L.box.x - ox) * scale}px`,
        `top:${(L.box.y - oy) * scale}px`,
        `min-width:${L.box.w * scale}px`,
        `min-height:${L.box.h * scale}px`,
        `max-width:${(L.fontSize * 16 + L.padX * 2) * scale}px`,
        `font-size:${L.fontSize * scale}px`,
        `line-height:${L.lineHeight * scale}px`,
        `padding:${L.padY * scale}px ${L.padX * scale}px`,
        `border-radius:${L.radius * scale}px`,
        `color:${contrastColor(edit.color)}`,
        `background:${edit.color}`,
      ].join(';');
      return html`
        <textarea
          ${ref(this.#textInputRef)}
          class="text-editor tag-editor"
          style=${style}
          rows="1"
          .value=${live(edit.value)}
          placeholder="Explain this…"
          @input=${(e: Event) => {
            edit.value = (e.target as HTMLTextAreaElement).value;
            this.requestUpdate();
          }}
          @keydown=${this.#onTextKeydown}
          @blur=${() => this.#commitTextEdit()}
          @pointerdown=${(e: Event) => e.stopPropagation()}
        ></textarea>
      `;
    }
    const fontPx = edit.fontSize * scale;
    const pad = edit.fill ? edit.fontSize * 0.25 * scale : 0;
    const style = [
      `left:${(edit.anchor.x - ox) * scale - pad}px`,
      `top:${(edit.anchor.y - oy) * scale - pad}px`,
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

  // ---------- tag pointer panel ----------

  /**
   * Floating pointer-direction picker for the tag being edited or the one
   * selected tag: a 4×3 grid (one row per side, three spots along it, the
   * glyph placed where the pointer sits) plus "no pointer", as in htmlpaint.
   */
  #tagPanel() {
    const edit = this.#textEdit?.kind === 'tag' ? this.#textEdit : null;
    const tag = edit ? null : this.#singleSelectedTag();
    const tool = this.#store.activeTool.value;
    if (!edit && (!tag || (tool !== 'select' && tool !== 'tag') || this.#shapeDrag)) return '';
    const shape: Shape = edit
      ? { id: '', type: 'tag', color: edit.color, lineWidth: 1, points: [edit.anchor], label: edit.value, fontSize: edit.fontSize, tagArrow: edit.tagArrow }
      : tag!;
    const current = shape.tagArrow ?? 'bottom-center';
    const b = shapeBounds(shape);
    const scale = this.#displayScale();
    const canvas = this.#canvasRef.value;
    const wrapH = (canvas?.height ?? 0) * scale;
    const PANEL_H = 150;
    let top = (b.y + b.height - this.#area.y) * scale + 10;
    if (top + PANEL_H > wrapH) top = Math.max(4, (b.y - this.#area.y) * scale - PANEL_H - 10);
    const left = Math.max(4, (b.x - this.#area.x) * scale);
    const glyph = { top: '↑', right: '→', bottom: '↓', left: '←' };
    const cellStyle = (pos: TagArrow) => {
      const [side, part] = pos.split('-') as ['top' | 'right' | 'bottom' | 'left', string];
      const along = part === 'center' ? 'center' : part === 'left' || part === 'top' ? 'flex-start' : 'flex-end';
      if (side === 'top' || side === 'bottom') return `justify-content:${along};align-items:${side === 'top' ? 'flex-start' : 'flex-end'}`;
      return `align-items:${along};justify-content:${side === 'left' ? 'flex-start' : 'flex-end'}`;
    };
    const rows: TagArrow[][] = [
      ['top-left', 'top-center', 'top-right'],
      ['right-top', 'right-center', 'right-bottom'],
      ['bottom-right', 'bottom-center', 'bottom-left'],
      ['left-bottom', 'left-center', 'left-top'],
    ];
    return html`
      <div
        class="tag-panel"
        style="left:${left}px; top:${top}px"
        @pointerdown=${(e: Event) => {
          // Keep focus (and so the open editor) where it is; don't reach the canvas.
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div class="tag-panel-title">Pointer</div>
        ${rows.map(
          (row) => html`
            <div class="tag-grid-row">
              ${row.map(
                (pos) => html`
                  <button
                    class="tag-cell ${current === pos ? 'active' : ''}"
                    style=${cellStyle(pos)}
                    title=${TAG_ARROW_LABEL[pos]}
                    @click=${() => this.#applyStyle({ tagArrow: pos })}
                  >
                    ${glyph[pos.split('-')[0] as keyof typeof glyph]}
                  </button>
                `
              )}
            </div>
          `
        )}
        <button
          class="tag-none ${current === 'none' ? 'active' : ''}"
          title="A plain note with no pointer"
          @click=${() => this.#applyStyle({ tagArrow: 'none' })}
        >
          No pointer
        </button>
      </div>
    `;
  }

  // ---------- region select ----------

  /** The selection box on the active page, only while the Select tool is active. */
  #activeRegion(): Rect | null {
    if (this.#store.activeTool.value !== 'select') return null;
    if (!this.#region || this.#region.pageId !== this.#store.activePageId.value) return null;
    return this.#region.rect;
  }

  #clearRegion(): void {
    if (!this.#region) return;
    this.#region = null;
    this.#regionDrag = null;
    this.requestUpdate();
  }

  /** Creates, moves, or resizes the selection box, kept within the page content (image plus anything drawn past it). */
  #onRegionDrag(pt: Point): void {
    const drag = this.#regionDrag;
    if (!drag) return;
    const c = this.#content;
    const minX = c.x;
    const minY = c.y;
    const maxX = c.x + c.w;
    const maxY = c.y + c.h;
    const clamp = (x1: number, y1: number, x2: number, y2: number): Rect => {
      const r = sortedRect(
        Math.max(minX, Math.min(maxX, x1)),
        Math.max(minY, Math.min(maxY, y1)),
        Math.max(minX, Math.min(maxX, x2)),
        Math.max(minY, Math.min(maxY, y2))
      );
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
    };
    const dx = pt.x - drag.start.x;
    const dy = pt.y - drag.start.y;
    const o = drag.orig;
    let rect: Rect;
    if (drag.grab === 'create') {
      rect = clamp(drag.start.x, drag.start.y, pt.x, pt.y);
    } else if (drag.grab === 'move') {
      rect = {
        x: Math.round(Math.max(minX, Math.min(maxX - o.w, o.x + dx))),
        y: Math.round(Math.max(minY, Math.min(maxY - o.h, o.y + dy))),
        w: o.w,
        h: o.h,
      };
    } else {
      rect = clamp(...resizeBox(o, drag.grab, dx, dy));
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
    const sel = this.#activeRegion();
    const page = this.#store.activePage;
    const img = this.#image?.img;
    if (!sel || !page.imageDataUrl || !img) return;
    // Only the image can be cropped; a box reaching into the margin crops to where it overlaps the image.
    const x1 = Math.max(0, sel.x);
    const y1 = Math.max(0, sel.y);
    const x2 = Math.min(img.naturalWidth, sel.x + sel.w);
    const y2 = Math.min(img.naturalHeight, sel.y + sel.h);
    if (x2 - x1 < 1 || y2 - y1 < 1) {
      this.#flashStatus('The selection does not cover the image');
      return;
    }
    const r: Rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
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
    const { x: ox, y: oy } = this.#area;
    const wrapH = canvas.height * scale;
    const right = (r.x + r.w - ox) * scale;
    const top = Math.max(4, Math.min((r.y + r.h - oy) * scale + 6, wrapH - 36));
    const alignLeft = right < 300;
    const left = alignLeft ? Math.max(4, (r.x - ox) * scale) : right;
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
      tagArrow: first?.type === 'tag' ? (first.tagArrow ?? 'bottom-center') : this.#store.activeTagArrow.value,
    };
  }

  /** Sets the tool default(s) and restyles every selected shape (and the open text editor) to match. */
  #applyStyle(style: ShapeStyle): void {
    if (style.color !== undefined) this.#store.activeColor.set(style.color);
    if (style.lineWidth !== undefined) this.#store.activeLineWidth.set(style.lineWidth);
    if (style.fontSize !== undefined) this.#store.activeFontSize.set(style.fontSize);
    if (style.fill !== undefined) this.#store.activeFill.set(style.fill);
    if (style.tagArrow !== undefined) this.#store.activeTagArrow.set(style.tagArrow);
    const edit = this.#textEdit;
    if (edit) {
      if (style.color !== undefined) edit.color = style.color;
      if (style.fontSize !== undefined) edit.fontSize = style.fontSize;
      if (style.fill !== undefined) edit.fill = style.fill;
      if (style.tagArrow !== undefined) edit.tagArrow = style.tagArrow;
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

  // ---------- folderfoo cloud ----------

  #hasContent(): boolean {
    return (
      this.#store.pages.value.length > 1 ||
      this.#store.pages.value.some((p) => p.imageDataUrl !== null || p.shapes.length > 0)
    );
  }

  #setCloudName(name: string | null): void {
    if (name !== this.#cloudName) {
      this.#channel?.ch.close();
      this.#channel = null;
      this.#peers = 0;
      clearTimeout(this.#autosaveTimer);
      this.#saveState = 'saved';
      this.#lastSavedPages = name ? this.#store.pages.value : null;
    }
    this.#cloudName = name;
    setCloudNameInHash(name);
    this.requestUpdate();
  }

  /** Records the pages as matching what is stored, so autosave only fires on later edits. */
  #markSaved(pages: Page[] = this.#store.pages.value): void {
    this.#lastSavedPages = pages;
    this.#saveState = pages === this.#store.pages.value ? 'saved' : 'dirty';
    this.requestUpdate();
  }

  /** Called after every render: a cloud document with unsaved edits saves itself shortly after the last change. */
  #checkAutosave(): void {
    if (!this.#cloudName || this.#presenting?.publicView) return;
    // No baseline yet (e.g. a #name from the URL that is still loading):
    // never push the local session over the cloud copy before it's read.
    if (this.#lastSavedPages === null) return;
    if (this.#store.pages.value === this.#lastSavedPages) return;
    if (this.#saveState === 'conflict' || this.#saveState === 'remote') return;
    if (this.#saveState !== 'saving' && this.#saveState !== 'dirty') {
      this.#saveState = 'dirty';
      this.requestUpdate();
    }
    clearTimeout(this.#autosaveTimer);
    this.#autosaveTimer = setTimeout(() => void this.#autosave(), 1500);
  }

  async #autosave(): Promise<void> {
    const name = this.#cloudName;
    if (!name || this.#saveState === 'saving' || this.#saveState === 'conflict' || this.#saveState === 'remote') return;
    const pages = this.#store.pages.value;
    if (pages === this.#lastSavedPages) return;
    this.#saveState = 'saving';
    this.requestUpdate();
    try {
      await saveCloudDocument(name, documentValue(pages, this.#store.activePageId.value));
      if (name !== this.#cloudName) return;
      this.#markSaved(pages);
      void rememberRecentThumbnail(name, pages.find((p) => p.imageDataUrl));
    } catch (err) {
      if (name !== this.#cloudName) return;
      this.#saveState = (err as { conflict?: boolean }).conflict ? 'conflict' : 'error';
      this.requestUpdate();
    }
  }

  /** Joins the document's live channel: reloads when another tab/device saves it, and counts who else has it open. */
  async #joinChannel(name: string): Promise<void> {
    if (this.#channel?.name === name) return;
    this.#channel?.ch.close();
    this.#channel = null;
    const ch = await openLiveChannel(name);
    if (!ch) return;
    if (name !== this.#cloudName) {
      ch.close();
      return;
    }
    this.#channel = { name, ch };
    ch.on('presence', (peers) => {
      this.#peers = peers.length;
      this.requestUpdate();
    });
    ch.on('file.saved', (event) => {
      if (event.fromSelf || name !== this.#cloudName) return;
      if (this.#store.pages.value !== this.#lastSavedPages) {
        // Unsaved local edits: don't overwrite them; let the user choose.
        this.#saveState = 'remote';
        this.#flashStatus(`${event.by.fullname || event.by.username} saved a newer version`);
        this.requestUpdate();
        return;
      }
      void this.#openCloudDocument(name, { confirmReplace: false, keepView: true });
    });
    ch.on('file.trashed', () => this.#flashStatus('This document was moved to the trash in folderfoo'));
  }

  #reloadFromCloud = () => {
    if (this.#cloudName) void this.#openCloudDocument(this.#cloudName, { confirmReplace: false, keepView: true });
  };

  #saveStateLabel(): string {
    switch (this.#saveState) {
      case 'saving':
        return 'Saving…';
      case 'dirty':
        return 'Unsaved changes';
      case 'error':
        return 'Save failed — retrying on next change';
      case 'conflict':
      case 'remote':
        return 'Changed elsewhere';
      default:
        return 'Saved';
    }
  }

  #onAuthChange = () => {
    this.#recent = null;
    void this.#loadRecent();
  };

  async #loadRecent(): Promise<void> {
    if (publicToken) return;
    try {
      this.#recent = (await listRecentDocuments()).slice(0, 12);
    } catch {
      this.#recent = [];
    }
    this.requestUpdate();
  }

  #onCloudFileChosen = (e: Event) => {
    const name = (e as CustomEvent<{ name: string }>).detail?.name;
    if (name) void this.#openCloudDocument(name, { confirmReplace: true });
  };

  async #openCloudDocument(name: string, { confirmReplace, keepView = false }: { confirmReplace: boolean; keepView?: boolean }): Promise<void> {
    if (confirmReplace && this.#hasContent() && name !== this.#cloudName) {
      if (!window.confirm(`Open "${name}"? It will replace everything currently open. You can Undo (Cmd/Ctrl+Z) afterward.`)) return;
    }
    this.#commitTextEdit();
    try {
      const { pages, activePageId } = parseDocumentValue(await loadCloudDocument(name));
      // A live reload keeps you on the page you were looking at, when it still exists.
      const current = this.#store.activePageId.value;
      const stay = keepView && pages.some((p) => p.id === current) ? current : activePageId;
      this.#store.loadDocument(pages, stay);
      this.#setCloudName(name);
      this.#markSaved();
      this.#clearRegion();
      void this.#joinChannel(name);
      await this.updateComplete;
      await this.#redraw();
      if (!keepView) this.#fitToWindow();
      this.#flashStatus(keepView ? `Updated to the latest "${name}"` : `Opened "${name}"`);
    } catch (err) {
      const e = err as Error & { status?: number };
      this.#flashStatus(e.status === 404 ? `"${name}" not found` : `Open failed: ${e.message}`);
    }
  }

  /** Saves to the current cloud name (asking for one the first time, or always with `saveAs`). Resolves the name saved under, or null. */
  async #saveToCloud(saveAs = false): Promise<string | null> {
    this.#commitTextEdit();
    let name = saveAs ? null : this.#cloudName;
    if (!name) {
      const typed = window.prompt('Save to folderfoo as:', this.#cloudName ?? `screenmarker-${new Date().toISOString().slice(0, 10)}`);
      name = typed?.trim().replace(/\.json$/i, '') || null;
      if (!name) return null;
    }
    this.#cloudBusy = true;
    this.requestUpdate();
    try {
      const pages = this.#store.pages.value;
      await saveCloudDocument(name, documentValue(pages, this.#store.activePageId.value));
      this.#setCloudName(name);
      this.#markSaved(pages);
      void rememberRecentThumbnail(name, pages.find((p) => p.imageDataUrl));
      void this.#joinChannel(name);
      this.#flashStatus(`Saved to folderfoo as "${name}"`);
      return name;
    } catch (err) {
      const e = err as Error & { conflict?: boolean };
      this.#saveState = e.conflict ? 'conflict' : 'error';
      this.#flashStatus(
        e.conflict
          ? `"${name}" was changed elsewhere since you opened it. Open it again, or use Save as, then retry.`
          : `Save failed: ${e.message}`
      );
      return null;
    } finally {
      this.#cloudBusy = false;
      this.requestUpdate();
    }
  }

  /** Saves the document, then copies a no-account link that opens it in presentation mode. */
  #sharePresentation = async () => {
    const name = await this.#saveToCloud();
    if (!name) return;
    try {
      const { url, expiresAt } = await createPresentationLink(name);
      await navigator.clipboard.writeText(url);
      this.#flashStatus(`Presentation link copied — anyone with it can view (until ${new Date(expiresAt).toLocaleDateString()})`);
    } catch (err) {
      this.#flashStatus(`Share failed: ${(err as Error).message}`);
    }
  };

  // ---------- presentation ----------

  /**
   * One slide per page that has an image: the page flattened with its
   * annotations. A page set to "reveal" gets one build per tag / step marker
   * (in the order they were added), each showing one more.
   */
  async #renderSlides(pages: Page[], withNotes: boolean): Promise<Slide[]> {
    const withImages = pages.filter((p): p is Page & { imageDataUrl: string } => p.imageDataUrl !== null);
    const toUrl = async (p: Page & { imageDataUrl: string }, shapes: Shape[]) =>
      (await flattenPage(p.imageDataUrl, shapes)).canvas.toDataURL('image/png');
    return Promise.all(
      withImages.map(async (p) => {
        const revealed = p.reveal ? p.shapes.filter((s) => s.type === 'tag' || s.type === 'step') : [];
        const builds: string[] = [];
        for (let k = 0; k <= revealed.length; k++) {
          const hidden = new Set(revealed.slice(k).map((s) => s.id));
          builds.push(await toUrl(p, p.shapes.filter((s) => !hidden.has(s.id))));
        }
        return { builds, title: p.title ?? '', notes: withNotes ? (p.notes ?? '') : '' };
      })
    );
  }

  #present = async (fromPageId?: string) => {
    this.#commitTextEdit();
    const pages = this.#store.pages.value;
    const withImages = pages.filter((p) => p.imageDataUrl !== null);
    if (!withImages.length) return;
    try {
      const slides = await this.#renderSlides(pages, true);
      const start = fromPageId ?? this.#store.activePageId.value;
      const index = Math.max(0, withImages.findIndex((p) => p.id === start));
      this.#presenting = { slides, index, publicView: false, heading: this.#cloudName ?? '', message: '' };
      this.requestUpdate();
    } catch (err) {
      this.#flashStatus(`Present failed: ${(err as Error).message}`);
    }
  };

  async #openPublicPresentation(token: string): Promise<void> {
    this.#presenting = { slides: [], index: 0, publicView: true, heading: '', message: 'Loading…' };
    this.requestUpdate();
    try {
      const { content, owner, path } = await loadPublicDocument(token);
      this.#publicDoc = parseDocumentValue(content);
      // Speaker notes stay out of a shared view.
      const slides = await this.#renderSlides(this.#publicDoc.pages, false);
      this.#presenting = {
        slides,
        index: 0,
        publicView: true,
        heading: `${path.split('/').pop()} · ${owner}`,
        message: slides.length ? '' : 'This presentation has no slides yet.',
      };
    } catch {
      this.#presenting = { slides: [], index: 0, publicView: true, heading: '', message: 'This link is invalid or has expired.' };
    }
    this.requestUpdate();
  }

  #closePresenter = () => {
    this.#presenting = null;
    this.requestUpdate();
  };

  /** From a public link: copies the shown document into this browser's editor (not linked to the owner's file). */
  #editPublicCopy = async () => {
    const doc = this.#publicDoc;
    if (!doc) return;
    if (this.#hasContent() && !window.confirm('Replace what is open in your editor with a copy of this presentation? You can Undo (Cmd/Ctrl+Z) afterward.')) {
      return;
    }
    this.#store.loadDocument(structuredClone(doc.pages), doc.activePageId);
    this.#setCloudName(null);
    this.#presenting = null;
    void mountAccountUi();
    await this.updateComplete;
    await this.#redraw();
    this.#fitToWindow();
  };

  // ---------- context menus ----------

  #openMenu(e: MouseEvent, items: MenuItem[]): void {
    e.preventDefault();
    e.stopPropagation();
    this.#commitTextEdit();
    this.#menu = { x: e.clientX, y: e.clientY, items };
    this.requestUpdate();
  }

  #closeMenu = () => {
    this.#menu = null;
    this.requestUpdate();
  };

  #onCanvasContextMenu = (e: MouseEvent) => {
    if (!this.#store.activePage.imageDataUrl) return;
    const pt = this.#canvasPoint(e);
    const hit = hitTestShapes(this.#store.activePage.shapes, pt);
    if (hit) {
      if (!this.#store.selectedIds.includes(hit.id)) this.#store.selectShapes([hit.id]);
      const editable = this.#store.selectedIds.length === 1 && (hit.type === 'text' || hit.type === 'tag' || hit.type === 'step');
      this.#openMenu(e, [
        ...(editable ? [{ label: hit.type === 'step' ? 'Edit number' : 'Edit text', shortcut: 'Enter', run: () => this.#startTextEdit(hit) }] : []),
        { label: 'Duplicate', shortcut: '⌘D', run: () => this.#store.duplicateSelectedShapes() },
        { label: 'Copy', shortcut: '⌘C', run: () => this.#store.copySelection() },
        'sep',
        { label: 'Bring to front', shortcut: '⌘]', run: () => this.#store.reorderSelectedShapes('front') },
        { label: 'Send to back', shortcut: '⌘[', run: () => this.#store.reorderSelectedShapes('back') },
        'sep',
        { colors: true },
        'sep',
        { label: 'Delete', shortcut: '⌫', danger: true, run: () => this.#store.deleteSelectedShapes() },
      ]);
      return;
    }
    this.#openMenu(e, [
      { label: 'Paste', shortcut: '⌘V', disabled: !this.#store.hasClipboard(), run: () => this.#store.paste() },
      {
        label: 'Select all',
        shortcut: '⌘A',
        disabled: !this.#store.activePage.shapes.length,
        run: () => this.#store.selectShapes(this.#store.activePage.shapes.map((s) => s.id)),
      },
      'sep',
      { label: 'Copy page image', run: () => void this.#copyCurrentPage() },
      { label: 'Present from this page', run: () => void this.#present() },
      { label: 'Fit to window', shortcut: 'F', run: () => void this.#fitToWindow() },
    ]);
  };

  #onPageContextMenu(e: MouseEvent, pageId: string, index: number): void {
    const count = this.#store.pages.value.length;
    const page = this.#store.pages.value[index];
    this.#openMenu(e, [
      { label: 'Duplicate page', shortcut: '⇧⌘D', run: () => this.#duplicatePage(pageId) },
      { label: 'Move up', disabled: index === 0, run: () => this.#store.movePage(pageId, -1) && this.#flashMovedTab(pageId) },
      { label: 'Move down', disabled: index === count - 1, run: () => this.#store.movePage(pageId, 1) && this.#flashMovedTab(pageId) },
      'sep',
      { label: 'Present from here', disabled: !page?.imageDataUrl, run: () => void this.#present(pageId) },
      'sep',
      { label: 'Delete page', danger: true, run: () => this.#closePageWithConfirm(pageId) },
    ]);
  }

  #renderMenu() {
    const m = this.#menu;
    if (!m) return '';
    // Keep the menu on screen near the click.
    const left = Math.min(m.x, window.innerWidth - 230);
    const top = Math.min(m.y, window.innerHeight - 40 - m.items.length * 30);
    const current = this.#currentStyle().color;
    return html`
      <div class="menu-backdrop" @pointerdown=${this.#closeMenu} @contextmenu=${(e: Event) => { e.preventDefault(); this.#closeMenu(); }}></div>
      <div class="menu" style="left:${Math.max(4, left)}px; top:${Math.max(4, top)}px" @contextmenu=${(e: Event) => e.preventDefault()}>
        ${m.items.map((item) => {
          if (item === 'sep') return html`<div class="menu-sep"></div>`;
          if ('colors' in item) {
            return html`<div class="menu-colors">
              ${COLORS.map(
                (c) => html`<button
                  class="swatch ${current.toLowerCase() === c ? 'active' : ''}"
                  style="background:${c}"
                  title=${c}
                  @click=${() => {
                    this.#applyStyle({ color: c });
                    this.#closeMenu();
                  }}
                ></button>`
              )}
            </div>`;
          }
          return html`<button
            class="menu-item ${item.danger ? 'danger' : ''}"
            ?disabled=${item.disabled}
            @click=${() => {
              this.#closeMenu();
              item.run();
            }}
          >
            <span>${item.label}</span><kbd>${item.shortcut ?? ''}</kbd>
          </button>`;
        })}
      </div>
    `;
  }

  // ---------- page strip / slide panel / recent ----------

  #thumbFor(page: Page): string | null {
    if (this.#thumbUrls.has(page)) return this.#thumbUrls.get(page) ?? null;
    void pageThumbnail(page).then((url) => {
      this.#thumbUrls.set(page, url);
      this.requestUpdate();
    });
    this.#thumbUrls.set(page, null);
    return null;
  }

  #renderPageStrip(activeId: string) {
    const pages = this.#store.pages.value;
    return html`
      <nav
        class="page-strip"
        @dragover=${(e: DragEvent) => {
          if (this.#draggingPageId) e.preventDefault();
        }}
        @drop=${(e: DragEvent) => {
          // A drop on the strip's empty space (not on a page, which handles
          // its own drop) moves the dragged page to the end.
          e.preventDefault();
          const fromId = this.#draggingPageId;
          this.#draggingPageId = null;
          this.#dragOverPageId = null;
          this.#dragOverSide = null;
          if (fromId && this.#store.reorderPageToEnd(fromId)) this.#flashMovedTab(fromId);
          else this.requestUpdate();
        }}
      >
        ${pages.map((p, i) => {
          const thumb = this.#thumbFor(p);
          return html`
            <div
              class="page-item ${p.id === activeId ? 'active' : ''} ${this.#dragOverPageId === p.id
                ? `drag-over-${this.#dragOverSide}`
                : ''} ${this.#justMovedPageId === p.id ? 'just-moved' : ''}"
              draggable="true"
              title=${p.title || this.#pageLabel(i)}
              @click=${() => this.#switchPage(p.id)}
              @contextmenu=${(e: MouseEvent) => this.#onPageContextMenu(e, p.id, i)}
              @dragstart=${(e: DragEvent) => this.#onTabDragStart(e, p.id)}
              @dragover=${(e: DragEvent) => this.#onTabDragOver(e, p.id)}
              @drop=${(e: DragEvent) => this.#onTabDrop(e, p.id)}
              @dragend=${this.#onTabDragEnd}
            >
              <span class="page-num">${i + 1}</span>
              <div class="page-thumb">
                ${thumb ? html`<img src=${thumb} alt="" draggable="false" />` : html`<span>${p.imageDataUrl ? '…' : 'Empty'}</span>`}
              </div>
              ${p.title ? html`<div class="page-title">${p.title}</div>` : ''}
              <div class="page-actions">
                <button
                  title="Duplicate page (Shift+Cmd/Ctrl+D)"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.#duplicatePage(p.id);
                  }}
                >
                  ⧉
                </button>
                <button title="Delete page" @click=${(e: Event) => this.#closePage(e, p.id)}>×</button>
              </div>
            </div>
          `;
        })}
        <button class="page-add" @click=${() => this.#addPage()} title="Add page">+ Page</button>
      </nav>
    `;
  }

  #renderSlidePanel(page: Page) {
    return html`
      <div class="slide-panel">
        <input
          class="slide-title"
          placeholder="Slide title"
          .value=${live(page.title ?? '')}
          @input=${(e: Event) => this.#store.updatePageMeta(page.id, { title: (e.target as HTMLInputElement).value })}
        />
        <label class="slide-reveal" title="When presenting, show this page's tags and step markers one per click, in the order you added them">
          <input
            type="checkbox"
            .checked=${live(!!page.reveal)}
            @change=${(e: Event) => this.#store.updatePageMeta(page.id, { reveal: (e.target as HTMLInputElement).checked })}
          />
          Reveal tags &amp; steps one at a time
        </label>
        <button class=${this.#notesOpen ? 'active' : ''} @click=${() => {
          this.#notesOpen = !this.#notesOpen;
          this.requestUpdate();
        }}>
          Notes${page.notes ? ' •' : ''}
        </button>
      </div>
      ${this.#notesOpen
        ? html`<textarea
            class="slide-notes"
            rows="3"
            placeholder="Speaker notes — shown while you present (N), not on shared links"
            .value=${live(page.notes ?? '')}
            @input=${(e: Event) => this.#store.updatePageMeta(page.id, { notes: (e.target as HTMLTextAreaElement).value })}
          ></textarea>`
        : ''}
    `;
  }

  #renderEmpty() {
    const recent = !this.#hasContent() ? (this.#recent ?? []) : [];
    return html`
      <div class="empty">
        <div>Paste a screenshot (Cmd/Ctrl+V), drag one in, or use "Open image…" above.</div>
        ${recent.length
          ? html`
              <div class="recent-heading">Recent documents</div>
              <div class="recent-grid">
                ${recent.map((r) => {
                  const thumb = recentThumbnail(r.name);
                  return html`
                    <button class="recent-card" @click=${() => void this.#openCloudDocument(r.name, { confirmReplace: true })} title=${r.name}>
                      <div class="recent-thumb">${thumb ? html`<img src=${thumb} alt="" />` : html`<span>☁</span>`}</div>
                      <div class="recent-name">${r.name.split('/').pop()}</div>
                      <div class="recent-when">${relativeTime(r.openedAt)}</div>
                    </button>
                  `;
                })}
              </div>
            `
          : ''}
      </div>
    `;
  }

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
    this.#setCloudName(null);
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

  #duplicatePage(id: string): void {
    this.#commitTextEdit();
    this.#clearRegion();
    this.#store.duplicatePage(id);
    this.#flashStatus('Page duplicated');
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
    return e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
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
    this.#checkAutosave();
    if (this.#focusTextEdit && this.#textInputRef.value) {
      this.#focusTextEdit = false;
      const input = this.#textInputRef.value;
      input.focus();
      if (this.#selectOnFocus) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
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
      <div class="titlebar">
        <span class="app-name">screenmarker</span>
        ${this.#cloudName
          ? html`
              <span class="cloud-name" title="Saved in folderfoo">☁ ${this.#cloudName}</span>
              <span class="save-state ${this.#saveState}">${this.#saveStateLabel()}</span>
              ${this.#saveState === 'conflict' || this.#saveState === 'remote'
                ? html`<button @click=${this.#reloadFromCloud} title="Discard local edits and load the saved version">Reload</button>
                    <button @click=${() => void this.#saveToCloud(true)} title="Keep your version under a new name">Save as…</button>`
                : ''}
              ${this.#peers ? html`<span class="peers" title="Also open elsewhere">👥 ${this.#peers}</span>` : ''}
            `
          : ''}
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
        ${this.#store.activeTool.value === 'step'
          ? html`
              <label class="next-step" title="Number the next step marker gets; later ones count up from the highest on the page">
                Next #
                <input
                  type="number"
                  .value=${live(String(this.#store.peekNextStepNumber()))}
                  @change=${(e: Event) => {
                    const n = Number.parseInt((e.target as HTMLInputElement).value, 10);
                    this.#store.nextStepOverride.set(Number.isFinite(n) ? n : null);
                  }}
                />
              </label>
            `
          : ''}
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
        <div class="group">
          <button @click=${() => void showFilePicker().catch((err: Error) => this.#flashStatus(`folderfoo unavailable: ${err.message}`))} title="Open a document from your folderfoo account">
            ☁ Open…
          </button>
          <button
            ?disabled=${this.#cloudBusy}
            @click=${(e: MouseEvent) => void this.#saveToCloud(e.shiftKey)}
            title=${this.#cloudName ? `Save to folderfoo as "${this.#cloudName}" (Shift+click: save as…)` : 'Save to your folderfoo account'}
          >
            ☁ Save
          </button>
          <button ?disabled=${noImage || this.#cloudBusy} @click=${this.#sharePresentation} title="Save, then copy a view-only presentation link anyone can open">
            🔗 Share
          </button>
          <button ?disabled=${noImage} @click=${() => this.#present()} title="Present all pages as slides">▶ Present</button>
        </div>
        <button class="button-primary" ?disabled=${noImage} @click=${this.#copyImage}>📋 Copy Image</button>
        <button class="button-primary" ?disabled=${noImage} @click=${this.#copyCurrentPage}>📋 Copy Current Page</button>
        <button ?disabled=${noImage} @click=${this.#openPreview}>Preview</button>
        <button ?disabled=${noImage} @click=${this.#download}>Download</button>
      </div>

      <div class="workspace">
      ${this.#renderPageStrip(page.id)}
      <div class="main">
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
                  @contextmenu=${this.#onCanvasContextMenu}
                ></canvas>
                ${this.#regionActions()} ${this.#textEditor()} ${this.#tagPanel()}
              </div>
            `
          : this.#renderEmpty()}
      </div>
      ${page.imageDataUrl ? this.#renderSlidePanel(page) : ''}
      </div>
      </div>
      <div class="status">${this.#statusMsg}</div>
      ${this.#renderMenu()}

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
      ${this.#presenting
        ? html`
            <screen-marker-presenter
              .slides=${this.#presenting.slides}
              .index=${this.#presenting.index}
              ?public-view=${this.#presenting.publicView}
              heading=${this.#presenting.heading}
              message=${this.#presenting.message}
              @presenter-close=${this.#closePresenter}
              @presenter-edit-copy=${this.#editPublicCopy}
            ></screen-marker-presenter>
          `
        : ''}
    `;
  }
}

customElements.define('screen-marker', ScreenMarker);
