import { LitElement, html } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import { live } from 'lit/directives/live.js';
import { SignalWatcher } from 'avosignals';
import { AnnotatorStore, makeId, type ShapeStyle } from './store.js';
import {
  boxHandlePoints,
  contrastColor,
  cropPicture,
  decodePicture,
  focusBounds,
  drawHandles,
  drawMarquee,
  drawRegionOverlay,
  drawSelectionOutline,
  drawShapes,
  flattenPage,
  flattenPagesToCanvas,
  hitTestShapes,
  layoutTag,
  layoutText,
  magnifierRadii,
  DEFAULT_MAGNIFY,
  preloadPictures,
  sceneBounds,
  shapeBounds,
  shapesInRect,
  transformPicture,
  transformShape,
  type ImageTransform,
} from './render.js';
import { copyImageOnly, copyRegion, downloadImage } from './export.js';
import { findSecrets, findText, recognizeLines } from './ocr.js';
import { followAttachments, snapEnds, unsnap } from './attach.js';
import { diffRegions } from './diff.js';
import { pagesToMarkdown } from './markdown.js';
import { documentValue, parseDocument, parseDocumentValue, serializeDocument } from './save-load.js';
import { deleteDraft, draftTitle, listDrafts, type DraftSummary } from './persistence.js';
import { baseName, canWrite, downloadFile, fileHandlesSupported, pickFileToOpen, pickFileToSave, sameFile, writeFile } from './localfile.js';
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
import './video-frames.js';
import { $mcpChannel, $mcpState, mcpConnectClick, setUpMcp } from './mcp.js';
import type { FrameEventDetail } from './video-frames.js';
import './palette.js';
import type { Command } from './palette.js';
import type { Slide } from './presenter.js';
import { pageThumbnail, recentThumbnail, rememberRecentThumbnail } from './thumbs.js';
import { TAG_ARROWS, type Page, type Point, type Rect, type Shape, type ShapeType, type TagArrow, type TextFont, type TextStyle, type Tool } from './types.js';
import { FONT_FAMILIES, FONT_LABELS, LINE_HEIGHT, layoutRich } from './richtext.js';

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
  { type: 'magnifier', label: 'Magnifier (drag from the spot to where the lens goes)', icon: '🔍', key: 'm' },
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

const BOX_RESIZABLE: ShapeType[] = ['rect', 'ellipse', 'highlight', 'blur', 'pen', 'picture', 'text'];

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
  // grab 2: a magnifier's lens-radius handle.
  | { kind: 'resize'; orig: Shape; grab: BoxGrab | 0 | 1 | 2; start: Point; draft: Shape | null };

type TextEdit = {
  kind: 'text' | 'tag' | 'step';
  id: string | null;
  anchor: Point;
  value: string;
  color: string;
  fontSize: number;
  fill: boolean;
  tagArrow: TagArrow;
  textStyle: TextStyle;
  // text only: wrap width and minimum height (image pixels); undefined grows with the text.
  width?: number;
  height?: number;
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

/** Whether box `outer` takes in all of `b` (a shapeBounds result). */
function containsRect(outer: Rect, b: { x: number; y: number; width: number; height: number }): boolean {
  return b.x >= outer.x && b.y >= outer.y && b.x + b.width <= outer.x + outer.w && b.y + b.height <= outer.y + outer.h;
}

/** Whether box `r` and `b` (a shapeBounds result) overlap. */
function containsAny(r: Rect, b: { x: number; y: number; width: number; height: number }): boolean {
  return b.x < r.x + r.w && b.x + b.width > r.x && b.y < r.y + r.h && b.y + b.height > r.y;
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

/** Shapes a "reveal" page shows one per click when presenting. */
const REVEALED: ShapeType[] = ['tag', 'step', 'magnifier'];

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

/** Space between pictures in a row: proportional to the page image so it reads the same at any resolution. */
function pictureGap(imageHeight: number): number {
  return Math.max(16, Math.round(imageHeight * 0.03));
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
function isVideoFile(f: File): boolean {
  return f.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv|ogv)$/i.test(f.name);
}

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
  #imageInputRef = createRef<HTMLInputElement>();
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
  // Find-text bar (Cmd/Ctrl+F): matches are boxes in the page image's coordinates.
  #search: { pageId: string; query: string; hits: Rect[]; index: number; status: string } | null = null;
  #searchTimer: ReturnType<typeof setTimeout> | undefined;
  #searchInputRef = createRef<HTMLInputElement>();
  #textEdit: TextEdit | null = null;
  #focusTextEdit = false;
  #selectOnFocus = true;
  #spaceHeld = false;
  #spacePanned = false;
  #pan: { x: number; y: number; cam: Point } | null = null;
  // The camera: the image point shown at the center of the stage. With the
  // zoom it places the canvas; the canvas only covers the visible part of the
  // (unbounded) scene, plus some slack so small pans need no redraw.
  #cam: Point = { x: 0, y: 0 };
  // Set by a pan-only update: skip the redraw while the canvas still covers the view.
  #camOnlyUpdate = false;
  #viewSaveTimer: ReturnType<typeof setTimeout> | undefined;
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
  // `zoom` is the editor zoom to open at; without it each slide fits the screen (public links).
  #presenting: { slides: Slide[]; index: number; publicView: boolean; heading: string; message: string; zoom?: number } | null = null;
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
  // Pages as a thumbnail sidebar, or collapsed to compact tabs in the title bar. Remembered per browser.
  #stripCollapsed = (() => {
    try {
      return localStorage.getItem('screenmarker_page_strip') === 'tabs';
    } catch {
      return false;
    }
  })();
  #menu: { x: number; y: number; items: MenuItem[] } | null = null;
  // The local file the document is bound to (Save and autosave write it in place). Handle is null without the File System Access API.
  #localFile: { name: string; handle: FileSystemFileHandle | null } | null = null;
  #fileState: 'saved' | 'dirty' | 'saving' | 'error' | 'permission' = 'saved';
  #lastFileSavedPages: Page[] | null = null;
  #fileTimer: ReturnType<typeof setTimeout> | undefined;
  // Drafts in this browser (IndexedDB), for the start screen and the Drafts dialog.
  #drafts: DraftSummary[] | null = null;
  #draftThumbs = new Map<string, string | null>();
  #draftsOpen = false;
  // Toolbar minimized to the essentials. Remembered per browser.
  #toolbarCollapsed = (() => {
    try {
      return localStorage.getItem('screenmarker_toolbar') === 'min';
    } catch {
      return false;
    }
  })();
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
    // Write the draft right away when the tab goes away (its save is otherwise debounced).
    window.addEventListener('pagehide', this.#flushDraft);
    this.addEventListener('dragover', this.#onDragOver);
    this.addEventListener('drop', this.#onDrop);
    document.addEventListener('folderfoo-file-open', this.#onCloudFileChosen);
    if (publicToken) void this.#openPublicPresentation(publicToken);
    void mountAccountUi().then(() => this.#loadRecent());
    window.addEventListener('folderfoo-auth-change', this.#onAuthChange);
    this.#store.restore().then(async (draft) => {
      if (draft?.fileName && !cloudNameFromHash()) {
        this.#localFile = { name: draft.fileName, handle: draft.fileHandle ?? null };
        this.#lastFileSavedPages = this.#store.pages.value;
      }
      this.#syncDocInfo();
      void this.#loadDrafts();
      if (!publicToken) this.#setUpMcp();
      this.requestUpdate();
      await this.updateComplete;
      if (this.#stageRef.value) this.#stageObserver.observe(this.#stageRef.value);
      await this.#redraw();
      await this.#restoreView();
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
    window.removeEventListener('pagehide', this.#flushDraft);
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
    const video = [...(e.dataTransfer?.files ?? [])].find(isVideoFile);
    if (video) {
      this.#openVideo(video);
      return;
    }
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    // Onto a page with content, files become pictures centered at the drop point.
    if (this.#store.activePage.shapes.length && this.#canvasRef.value) {
      const at = this.#canvasPoint(e);
      for (const f of files) await this.#addPicture(f, at);
      return;
    }
    await this.#loadImageFile(files[0]!);
  };

  #onPaste = async (e: ClipboardEvent) => {
    if (fromEditable(e)) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) return;
        // A page with content gets the paste as a picture in the middle of the view.
        if (this.#store.activePage.shapes.length) await this.#addPicture(file);
        else await this.#loadImageFile(file);
        return;
      }
    }
  };

  #flushDraft = () => this.#store.flushDraft();

  /** Exposes the document to an LLM through a local js-bridge-mcp (see mcp.ts). */
  #setUpMcp(): void {
    setUpMcp({
      store: this.#store,
      documentName: () => this.#cloudName ?? this.#localFile?.name ?? draftTitle({ pages: this.#store.pages.value }),
      switchPage: (id) => this.#switchPage(id),
      addPage: async () => {
        this.#addPage();
        await this.updateComplete;
      },
      openDraft: (id) => this.#openDraft(id),
      newDocument: () => this.#newDocument(),
    });
  }

  #renderMcpButton() {
    const state = $mcpState.value;
    const dot = state === 'connected' ? '🟢' : state === 'connecting' ? '🟡' : '⚪';
    const title =
      state === 'connected'
        ? `Connected to js-bridge-mcp as "${$mcpChannel.value}": an MCP client (e.g. Claude) can read and annotate this document with the screenmarker__* tools. Click to rename the connection.`
        : 'Let an LLM read and annotate this document: start a local js-bridge-mcp (npx js-bridge-mcp), then click to connect.';
    return html`<button class="mcp-button" title=${title} @click=${mcpConnectClick}>${dot} ${state === 'connected' ? $mcpChannel.value : 'MCP'}</button>`;
  }

  #onWindowBlur = () => {
    this.#spaceHeld = false;
    this.#pan = null;
    this.requestUpdate();
  };

  #onKeyup = (e: KeyboardEvent) => {
    if (e.key !== ' ' || !this.#spaceHeld) return;
    this.#spaceHeld = false;
    // The Space went into a text field (e.g. the editor opened mid-keypress): no preview, no tag cycling.
    if (fromEditable(e) || this.#textEdit) {
      this.requestUpdate();
      return;
    }
    // A Space tap (no drag) cycles a selected tag's pointer clockwise;
    // otherwise it toggles the preview, as before Space+drag panning existed.
    const tag = this.#singleSelectedTag();
    if (!this.#spacePanned && tag) {
      const order = TAG_ARROWS.filter((a) => a !== 'none');
      const i = order.indexOf((tag.tagArrow ?? 'bottom-center') as (typeof order)[number]);
      this.#applyStyle({ tagArrow: order[(i + 1) % order.length]! });
    } else if (!this.#spacePanned && this.#store.activePage.shapes.length) {
      this.#openPreview();
    }
    this.requestUpdate();
  };

  #onKeydown = (e: KeyboardEvent) => {
    if (this.#presenting || this.#video) return;
    // While a label is being edited, keys belong to the editor (it handles its own), never to app shortcuts.
    if (this.#textEdit) return;
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

    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && this.#store.activePage.shapes.length) {
      e.preventDefault();
      this.#openSearch();
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
      if (selectedIds.length) {
        e.preventDefault();
        this.#store.deleteSelectedShapes();
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
          this.#zoomBy(1.2);
          return;
        case '-':
          e.preventDefault();
          this.#zoomBy(1 / 1.2);
          return;
        case '0':
          e.preventDefault();
          this.#zoomBy(1 / this.#store.zoom.value);
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
      this.#zoomBy(1.2);
    } else if (e.key === '-') {
      e.preventDefault();
      this.#zoomBy(1 / 1.2);
    } else if (e.key === '0') {
      e.preventDefault();
      this.#zoomBy(1 / this.#store.zoom.value);
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
      if (selectedIds.length) {
        // In-app clipboard copy — pastes back as new, still-editable shapes.
        this.#store.copySelection();
        this.#flashStatus(selectedIds.length === 1 ? 'Shape copied' : `${selectedIds.length} shapes copied`);
      } else if (this.#store.activePage.shapes.length) {
        // Nothing selected: copy the whole scene (all pages) to the OS clipboard.
        void this.#copyImage();
      }
    } else if (key === 'x' && selectedIds.length) {
      e.preventDefault();
      this.#cutSelection();
    } else if (key === 'v' && this.#store.hasClipboard()) {
      e.preventDefault();
      this.#store.paste();
    } else if (key === 's') {
      e.preventDefault();
      if (e.shiftKey) void this.#saveAsFile();
      else this.#saveDocument();
    } else if (key === 'o') {
      e.preventDefault();
      void this.#openFile();
    }
  };

  #setTool(tool: Tool): void {
    this.#commitTextEdit();
    this.#store.activeTool.set(tool);
    this.#canvasCursor = '';
  }

  /** Puts an image on an empty page: a picture at (0, 0), at its own size, framed to fit. */
  async #loadImageFile(file: File): Promise<void> {
    // A new image: the old framing no longer applies.
    this.#store.setPageView(this.#store.activePageId.value, null);
    this.#clearRegion();
    await this.#addPicture(file, null);
    this.#store.selectShapes([]);
    await this.updateComplete;
    await this.#redraw();
    this.#fitToWindow();
  }

  #cutSelection(): void {
    const n = this.#store.cutSelection();
    if (n) this.#flashStatus(`${n === 1 ? 'Shape' : `${n} shapes`} cut (Cmd/Ctrl+V puts ${n === 1 ? 'it' : 'them'} back)`);
  }

  /**
   * Adds an image file to the active page as a picture shape at its natural
   * size, centered on `at` (a drop) or else on the middle of the view; with
   * `at` null, its top-left corner goes at (0, 0). Selects it, ready to move
   * or resize.
   */
  async #addPicture(file: File, at?: Point | null): Promise<void> {
    const src = await fileToDataUrl(file);
    const img = new Image();
    img.src = src;
    try {
      await img.decode();
    } catch {
      this.#flashStatus('Could not read that image');
      return;
    }
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const c = at === null ? { x: w / 2, y: h / 2 } : (at ?? this.#cam);
    const x = Math.round(c.x - w / 2);
    const y = Math.round(c.y - h / 2);
    const shape: Shape = {
      id: makeId(),
      type: 'picture',
      color: this.#store.activeColor.value,
      lineWidth: 0,
      points: [
        { x, y },
        { x: x + w, y: y + h },
      ],
      src,
    };
    this.#store.addShape(shape);
    this.#store.activeTool.set('select');
    this.#store.selectShapes([shape.id]);
    if (this.#store.autoRedact.value) void this.#redactSecrets([shape], true);
    await this.updateComplete;
    await this.#redraw();
  }

  /**
   * Lines up the selected pictures in their current left-to-right order: the
   * leftmost stays put and the others follow it to the right, each scaled to
   * its height, with an even gap — a ribbon of screenshots. One undo step.
   */
  async #arrangePicturesInRow(): Promise<void> {
    const pictures = this.#store.selectedShapes
      .filter((s) => s.type === 'picture')
      .sort((a, b) => shapeBounds(a).x - shapeBounds(b).x);
    if (pictures.length < 2) return;
    const first = shapeBounds(pictures[0]!);
    const H = first.height;
    const gap = pictureGap(H);
    let x = first.x + first.width + gap;
    const next = pictures.slice(1).map((p) => {
      const b = shapeBounds(p);
      const w = b.height ? (b.width * H) / b.height : b.width;
      const moved: Shape = { ...p, points: [{ x, y: first.y }, { x: x + w, y: first.y + H }] };
      x += w + gap;
      return moved;
    });
    this.#store.replaceShapes(next);
    await this.updateComplete;
    await this.#redraw();
    this.#fitToWindow();
  }

  /** Moves each selected picture (with the annotations on it) to a new page of its own. */
  #movePicturesToNewPages(): void {
    const n = this.#store.movePicturesToNewPages(this.#store.selectedIds);
    if (!n) return;
    this.#clearRegion();
    this.#flashStatus(n === 1 ? 'Moved the picture to a new page' : `Moved ${n} pictures to ${n} new pages`);
    void this.updateComplete.then(async () => {
      await this.#redraw();
      await this.#restoreView();
    });
  }

  #onFilePick = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file && isVideoFile(file)) this.#openVideo(file);
    else if (file) await this.#loadImageFile(file);
  };

  // ---------- video frames ----------

  /** The frame grabber's video, and how many frames it has added so far. */
  #video: { file: File; added: number } | null = null;

  #openVideo(file: File): void {
    this.#commitTextEdit();
    this.#video = { file, added: 0 };
    this.requestUpdate();
  }

  #pickVideo = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,.mov,.mp4,.m4v,.webm';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) this.#openVideo(file);
    };
    input.click();
  };

  /** Frames from the grabber, in time order: the first onto the current page if it is blank, the rest each onto a new page. */
  #onVideoFrames = async (e: CustomEvent<FrameEventDetail>) => {
    const video = this.#video;
    if (!video) return;
    const name = video.file.name.replace(/\.[^.]+$/, '');
    for (const { blob, time } of e.detail.frames) {
      if (this.#store.activePage.shapes.length) {
        this.#rememberView();
        this.#store.addPage();
        await this.updateComplete;
      }
      const page = this.#store.activePage;
      if (!page.title) this.#store.updatePageMeta(page.id, { title: `${name} @ ${time.toFixed(2)}s` });
      await this.#loadImageFile(new File([blob], `frame-${time.toFixed(2)}.png`, { type: 'image/png' }));
      video.added += 1;
    }
    this.requestUpdate();
  };

  #closeVideo = () => {
    if (this.#video?.added) this.#flashStatus(`${this.#video.added} frame${this.#video.added === 1 ? '' : 's'} added as pages`);
    this.#video = null;
    this.requestUpdate();
  };

  /**
   * Cmd/Ctrl+S: a cloud document saves to the cloud; a document bound to a
   * local file writes that file in place; otherwise asks where to save it.
   */
  #saveDocument = () => {
    this.#commitTextEdit();
    if (this.#cloudName) void this.#saveToCloud();
    else if (this.#localFile?.handle) void this.#writeLocalFile(true);
    else void this.#saveAsFile();
  };

  /** Saves the document to a new file on this computer and binds to it. */
  #saveAsFile = async () => {
    this.#commitTextEdit();
    const pages = this.#store.pages.value;
    const text = serializeDocument(pages, this.#store.activePageId.value);
    const suggested = this.#localFile?.name ?? this.#cloudName?.split('/').pop() ?? draftTitle({ pages });
    try {
      if (!fileHandlesSupported) {
        const typed = window.prompt('File name:', baseName(suggested));
        if (typed === null) return;
        downloadFile(typed || suggested, text);
        this.#flashStatus('Document downloaded');
        return;
      }
      const handle = await pickFileToSave(baseName(suggested));
      if (!handle) return;
      await writeFile(handle, text);
      this.#setCloudName(null);
      this.#setLocalFile({ name: handle.name, handle });
      this.#lastFileSavedPages = pages;
      this.#fileState = 'saved';
      this.#flashStatus(`Saved to ${handle.name} on this computer`);
    } catch (err) {
      this.#flashStatus(`Save failed: ${(err as Error).message}`);
    }
  };

  /** Writes the bound local file. `ask`: may prompt for permission (only from a click or key press). */
  async #writeLocalFile(ask: boolean): Promise<void> {
    const file = this.#localFile;
    if (!file?.handle) return;
    const pages = this.#store.pages.value;
    try {
      if (!(await canWrite(file.handle, ask))) {
        this.#fileState = 'permission';
        this.requestUpdate();
        return;
      }
      this.#fileState = 'saving';
      this.requestUpdate();
      await writeFile(file.handle, serializeDocument(pages, this.#store.activePageId.value));
      if (this.#localFile !== file) return;
      this.#lastFileSavedPages = pages;
      this.#fileState = pages === this.#store.pages.value ? 'saved' : 'dirty';
      if (ask) this.#flashStatus(`Saved ${file.name}`);
    } catch (err) {
      this.#fileState = 'error';
      if (ask) this.#flashStatus(`Save failed: ${(err as Error).message}`);
    }
    this.requestUpdate();
  }

  /** Opens a document file from this computer as a new draft (the current document stays in Drafts). */
  #openFile = async () => {
    this.#commitTextEdit();
    try {
      const picked = await pickFileToOpen();
      if (!picked) return;
      const { pages, activePageId } = await parseDocument(await picked.file.text());
      this.#rememberView();
      const existing = picked.handle ? await this.#draftForFile(picked.handle) : null;
      this.#store.openAsNewDraft(pages, activePageId, { fileName: picked.file.name, fileHandle: picked.handle }, existing);
      this.#setCloudName(null);
      // Without a handle the file can't be written back: Save asks where to save.
      this.#setLocalFile(picked.handle ? { name: picked.file.name, handle: picked.handle } : null);
      this.#lastFileSavedPages = this.#store.pages.value;
      this.#fileState = 'saved';
      await this.#afterDocumentSwitch();
      this.#flashStatus(`Opened ${picked.file.name}`);
    } catch (err) {
      this.#flashStatus(`Open failed: ${(err as Error).message}`);
    }
  };

  /** The draft already holding this file, so opening it again doesn't add a duplicate draft. */
  async #draftForFile(handle: FileSystemFileHandle): Promise<string | null> {
    for (const d of await listDrafts()) if (await sameFile(d.fileHandle, handle)) return d.id;
    return null;
  }

  #setLocalFile(file: { name: string; handle: FileSystemFileHandle | null } | null): void {
    clearTimeout(this.#fileTimer);
    this.#localFile = file;
    this.#fileState = 'saved';
    if (!file) this.#lastFileSavedPages = null;
    this.#syncDocInfo();
    this.requestUpdate();
  }

  /** Records where the document is also saved, with its draft. */
  #syncDocInfo(): void {
    this.#store.docInfo.set({
      cloudName: this.#cloudName,
      fileName: this.#localFile?.name ?? null,
      fileHandle: this.#localFile?.handle ?? null,
    });
  }

  /** A bound local file saves itself shortly after the last change (when the browser still lets us write it). */
  #checkFileAutosave(): void {
    const file = this.#localFile;
    if (!file?.handle || this.#presenting?.publicView) return;
    if (this.#store.pages.value === this.#lastFileSavedPages) return;
    if (this.#fileState === 'saved') {
      this.#fileState = 'dirty';
      this.requestUpdate();
    }
    clearTimeout(this.#fileTimer);
    this.#fileTimer = setTimeout(() => void this.#writeLocalFile(false), 1500);
  }

  #fileStateLabel(): string {
    switch (this.#fileState) {
      case 'saving':
        return 'Saving…';
      case 'dirty':
        return 'Unsaved changes';
      case 'error':
        return 'Save failed';
      case 'permission':
        return 'Press Save to keep saving to this file';
      default:
        return 'Saved';
    }
  }

  // ---------- drafts (IndexedDB) ----------

  async #loadDrafts(): Promise<void> {
    this.#drafts = await listDrafts();
    this.requestUpdate();
    for (const d of this.#drafts) {
      if (this.#draftThumbs.has(d.id + d.updatedAt) || !d.firstPage) continue;
      this.#draftThumbs.set(d.id + d.updatedAt, await pageThumbnail(d.firstPage, 240, 'image/jpeg'));
      this.requestUpdate();
    }
  }

  #openDraftsDialog = () => {
    this.#commitTextEdit();
    this.#rememberView();
    this.#draftsOpen = true;
    void this.#loadDrafts();
  };

  async #openDraft(id: string): Promise<void> {
    this.#draftsOpen = false;
    if (id === this.#store.draftId) return this.requestUpdate();
    this.#rememberView();
    if (!(await this.#store.openDraft(id))) {
      this.#flashStatus('That draft is empty or gone');
      void this.#loadDrafts();
      return;
    }
    const info = this.#store.docInfo.value;
    // A draft of a cloud document opens unbound, so it never overwrites a newer cloud version.
    this.#setCloudName(null);
    this.#setLocalFile(info.fileName && info.fileHandle ? { name: info.fileName, handle: info.fileHandle } : null);
    this.#lastFileSavedPages = this.#localFile ? this.#store.pages.value : null;
    await this.#afterDocumentSwitch();
    this.#flashStatus(info.cloudName ? `Opened the local draft of ☁ ${info.cloudName} (☁ Save to update it there)` : 'Draft opened');
  }

  async #deleteDraft(d: DraftSummary): Promise<void> {
    if (!window.confirm(`Delete the draft "${d.title}" from this browser? This can't be undone.${d.cloudName || d.fileName ? ' Its cloud document or file is not touched.' : ''}`)) return;
    await deleteDraft(d.id);
    void this.#loadDrafts();
  }

  async #afterDocumentSwitch(): Promise<void> {
    this.#clearRegion();
    this.requestUpdate();
    await this.updateComplete;
    await this.#redraw();
    await this.#restoreView();
    void this.#loadDrafts();
  }

  #renderDraftCards(limit = Infinity) {
    const drafts = (this.#drafts ?? []).slice(0, limit);
    return html`
      <div class="recent-grid">
        ${drafts.map((d) => {
          const thumb = this.#draftThumbs.get(d.id + d.updatedAt);
          const current = d.id === this.#store.draftId;
          const where = d.cloudName ? '☁ ' : d.fileName ? '🖫 ' : '';
          return html`
            <div class="recent-card draft-card ${current ? 'current' : ''}">
              <button class="draft-open" @click=${() => void this.#openDraft(d.id)} title=${current ? 'Open now' : `Open "${d.title}"`}>
                <div class="recent-thumb">${thumb ? html`<img src=${thumb} alt="" />` : html`<span>${d.pageCount ? '✎' : ''}</span>`}</div>
                <div class="recent-name">${where}${d.title}</div>
                <div class="recent-when">${current ? 'Open now · ' : ''}${relativeTime(d.updatedAt)} · ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}</div>
              </button>
              ${current ? '' : html`<button class="draft-delete" title="Delete this draft" @click=${() => void this.#deleteDraft(d)}>✕</button>`}
            </div>
          `;
        })}
      </div>
    `;
  }

  #renderDraftsDialog() {
    if (!this.#draftsOpen) return '';
    const close = () => {
      this.#draftsOpen = false;
      this.requestUpdate();
    };
    return html`
      <div class="preview-overlay" @click=${close}>
        <div class="preview-card drafts-card" @click=${(e: Event) => e.stopPropagation()}>
          <div class="preview-header">
            <span>Drafts in this browser — every document is kept here as you edit</span>
            <div class="preview-header-controls">
              <button @click=${() => { close(); this.#newDocument(); }}>＋ New document</button>
              <button @click=${() => { close(); void this.#openFile(); }}>📂 Open file…</button>
              <button @click=${close} title="Close">✕</button>
            </div>
          </div>
          <div class="drafts-body">
            ${this.#drafts?.length ? this.#renderDraftCards() : html`<div class="empty">No drafts yet. Anything you make is saved here automatically.</div>`}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- drawing ----------

  /** The page's shapes as they should look right now — with any in-progress move, resize, or new shape applied, and the text being edited hidden (the input overlay shows it instead). */
  #displayShapes(): Shape[] {
    const drag = this.#shapeDrag;
    const movingIds = drag?.kind === 'move' ? new Set(drag.ids) : null;
    const shapes: Shape[] = [];
    for (const s of this.#store.activePage.shapes) {
      if (this.#textEdit?.id === s.id) continue;
      // What is being dragged shows where the pointer puts it (its ends loose until dropped).
      if (movingIds?.has(s.id) && drag?.kind === 'move') shapes.push(unsnap(offsetShape(s, drag.delta.x, drag.delta.y)));
      else if (drag?.kind === 'resize' && drag.orig.id === s.id && drag.draft) shapes.push(unsnap(drag.draft));
      else shapes.push(s);
    }
    const tool = this.#store.activeTool.value;
    if (this.#drawing && this.#currentPoints.length >= 2 && this.#isShapeTool(tool) && tool !== 'text') {
      shapes.push(this.#newShape(tool, this.#currentPoints));
    }
    // Arrows attached to something being dragged follow it live.
    return this.#store.snapArrows.value && drag ? followAttachments(shapes) : shapes;
  }

  /** The text/tag/picture the arrow or line being drawn (or whose end is dragged) will attach to. */
  #snapPreviewTargets(shapes: Shape[]): Shape[] {
    if (!this.#store.snapArrows.value) return [];
    const drag = this.#shapeDrag;
    let conn: Shape | null = null;
    const tool = this.#store.activeTool.value;
    if (this.#drawing && (tool === 'arrow' || tool === 'line')) conn = shapes[shapes.length - 1] ?? null;
    else if (drag?.kind === 'resize' && drag.draft && (drag.grab === 0 || drag.grab === 1)) conn = drag.draft;
    if (!conn || (conn.type !== 'arrow' && conn.type !== 'line')) return [];
    const ends = snapEnds(conn, shapes).ends ?? [];
    return ends.map((e) => e && shapes.find((s) => s.id === e.id)).filter((s): s is Shape => !!s);
  }

  #toggleSnapArrows = () => {
    const on = !this.#store.snapArrows.value;
    this.#store.snapArrows.set(on);
    this.#flashStatus(on ? 'Snapping on: arrow and line ends attach to text and pictures' : 'Snapping off: arrow and line ends stay where you put them');
  };

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
    if (type === 'magnifier') {
      // A lens about a fifth of the shorter side of the page's pictures reads well at any resolution.
      const f = focusBounds(this.#store.activePage.shapes);
      const side = f.w && f.h ? Math.min(f.w, f.h) : 400;
      shape.lensRadius = Math.max(40, Math.round(side * 0.1));
      shape.magnify = DEFAULT_MAGNIFY;
    }
    return shape;
  }

  async #redraw(): Promise<void> {
    const page = this.#store.activePage;
    const canvas = this.#canvasRef.value;
    if (!canvas) return;

    const shapes = this.#displayShapes();
    await preloadPictures(shapes);
    const content = sceneBounds(shapes);
    const area = this.#editorArea();
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
    // The empty space around the pictures stays transparent (the stage shows
    // through); pictures get a drop shadow to stand out.
    drawShapes(ctx, shapes, 16 / this.#displayScale());
    this.#drawSearchHits(ctx);

    const unit = 1 / this.#displayScale();
    const selected = new Set(this.#store.selectedIds);
    const selectedShapes = shapes.filter((s) => selected.has(s.id));
    for (const s of selectedShapes) drawSelectionOutline(ctx, s, unit);
    // While an arrow/line end is placed, outline what it will snap to.
    for (const t of this.#snapPreviewTargets(shapes)) drawSelectionOutline(ctx, t, unit);
    const handleShape = selectedShapes.length === 1 ? selectedShapes[0]! : null;
    if (handleShape && this.#store.activeTool.value === 'select' && this.#shapeDrag?.kind !== 'move') {
      const pts = this.#handlePoints(handleShape);
      if (pts.length) drawHandles(ctx, pts, HANDLE_CSS_PX * unit);
    }
    const region = this.#activeRegion();
    if (region) drawRegionOverlay(ctx, region, HANDLE_CSS_PX * unit, area);
    // The text box being dragged out with the Text tool.
    const [ta, tb] = this.#currentPoints;
    if (this.#drawing && this.#store.activeTool.value === 'text' && ta && tb) {
      drawMarquee(ctx, sortedRect(ta.x, ta.y, tb.x, tb.y), unit);
    }
    // canvas.width/height just changed the wrap's target size (#canvasWrapStyle
    // reads it) — re-render once so the wrap picks up the new box on first load.
    if (sizeChanged) this.requestUpdate();
  }

  /** Resize-handle positions for a shape: two endpoints for arrows/lines, 8 box handles for box-like shapes and text boxes, none for steps (sized via font size). */
  #handlePoints(shape: Shape): Point[] {
    if (shape.type === 'arrow' || shape.type === 'line') return shape.points.slice(0, 2);
    if (shape.type === 'magnifier') return this.#magnifierHandles(shape);
    if (BOX_RESIZABLE.includes(shape.type)) return boxHandlePoints(boundsRect(shape));
    return [];
  }

  /** A magnifier's handles: the spot (0), the lens center (1), and the lens radius on its right edge (2). */
  #magnifierHandles(shape: Shape): Point[] {
    const [s, l] = shape.points;
    if (!s || !l) return [];
    return [s, l, { x: l.x + magnifierRadii(shape).lens, y: l.y }];
  }

  /** Which resize handle of `shape` is under `pt`, if any: an endpoint index for arrows/lines, a box edge/corner otherwise. */
  #shapeHandleAt(shape: Shape, pt: Point): BoxGrab | 0 | 1 | 2 | null {
    const tol = this.#handleTolerance();
    if (shape.type === 'magnifier') {
      const i = this.#magnifierHandles(shape).findIndex((p) => Math.hypot(p.x - pt.x, p.y - pt.y) <= tol);
      return i === 0 || i === 1 || i === 2 ? i : null;
    }
    if (shape.type === 'arrow' || shape.type === 'line') {
      const i = shape.points.slice(0, 2).findIndex((p) => Math.hypot(p.x - pt.x, p.y - pt.y) <= tol);
      return i === 0 || i === 1 ? i : null;
    }
    if (!BOX_RESIZABLE.includes(shape.type)) return null;
    const grab = boxGrabAt(boundsRect(shape), pt, tol);
    return grab === 'move' ? null : grab;
  }

  /**
   * The scene box the editor canvas covers, in image coordinates: the part
   * of the scene visible around the camera, with half a view of slack on
   * every side, capped at MAX_AREA_SIDE.
   */
  #editorArea(): Rect {
    const { w, h } = this.#viewSize();
    const scale = this.#displayScale();
    const aw = Math.min(MAX_AREA_SIDE, (w * 2) / scale);
    const ah = Math.min(MAX_AREA_SIDE, (h * 2) / scale);
    const x1 = Math.floor(this.#cam.x - aw / 2);
    const y1 = Math.floor(this.#cam.y - ah / 2);
    return { x: x1, y: y1, w: Math.ceil(aw), h: Math.ceil(ah) };
  }

  #viewSize(): { w: number; h: number } {
    const stage = this.#stageRef.value;
    return { w: stage?.clientWidth || 800, h: stage?.clientHeight || 600 };
  }

  /** Whether the canvas still covers everything the stage shows. */
  #viewCovered(): boolean {
    const { w, h } = this.#viewSize();
    const scale = this.#displayScale();
    const a = this.#area;
    const canvas = this.#canvasRef.value;
    if (!canvas || canvas.width !== a.w) return false;
    return (
      this.#cam.x - w / 2 / scale >= a.x &&
      this.#cam.y - h / 2 / scale >= a.y &&
      this.#cam.x + w / 2 / scale <= a.x + a.w &&
      this.#cam.y + h / 2 / scale <= a.y + a.h
    );
  }

  /** The image point under a client (screen) position. */
  #imagePointAt(clientX: number, clientY: number): Point {
    const stage = this.#stageRef.value!.getBoundingClientRect();
    const scale = this.#displayScale();
    return {
      x: this.#cam.x + (clientX - stage.left - stage.width / 2) / scale,
      y: this.#cam.y + (clientY - stage.top - stage.height / 2) / scale,
    };
  }

  /** Moves the camera (a pan, or after a zoom) and remembers the view for this page. */
  #setCamera(cam: Point, remember = true): void {
    this.#cam = cam;
    this.#camOnlyUpdate = true;
    this.requestUpdate();
    if (remember) this.#scheduleViewSave();
  }

  #scheduleViewSave(): void {
    const pageId = this.#store.activePageId.value;
    clearTimeout(this.#viewSaveTimer);
    this.#viewSaveTimer = setTimeout(() => {
      if (this.#store.activePageId.value === pageId) this.#rememberView();
    }, 400);
  }

  /**
   * Saves where the active page is being looked at (center, zoom, and the
   * visible area). Runs on pan/zoom and whenever the editor leaves a page,
   * so coming back shows everything exactly where it was, and the page's
   * slide shows the same framing.
   */
  #rememberView(): void {
    clearTimeout(this.#viewSaveTimer);
    if (!this.#stageRef.value || !this.#canvasRef.value?.width) return;
    const scale = this.#displayScale();
    const { w, h } = this.#viewSize();
    const view = {
      x: Math.round(this.#cam.x),
      y: Math.round(this.#cam.y),
      zoom: this.#store.zoom.value,
      w: Math.round(w / scale),
      h: Math.round(h / scale),
    };
    const old = this.#store.activePage.view;
    if (!old || old.x !== view.x || old.y !== view.y || old.zoom !== view.zoom || old.w !== view.w || old.h !== view.h) {
      this.#store.setPageView(this.#store.activePageId.value, view);
    }
  }

  /** Shows the page as last left (its saved view), or fitted when it has none. */
  async #restoreView(): Promise<void> {
    const view = this.#store.activePage.view;
    if (!view) return this.#fitToWindow();
    this.#store.setZoom(view.zoom);
    this.#cam = { x: view.x, y: view.y };
    await this.#settleLayout();
  }

  /** Forgets the page's saved view and fits the content again. */
  #resetView = () => {
    clearTimeout(this.#viewSaveTimer);
    this.#store.setPageView(this.#store.activePageId.value, null);
    void this.#fitToWindow();
  };

  /** Zooms by `factor` around the stage center (keys and buttons). */
  #zoomBy(factor: number): void {
    const stage = this.#stageRef.value?.getBoundingClientRect();
    if (!stage) return;
    void this.#zoomAt(this.#store.zoom.value * factor, stage.left + stage.width / 2, stage.top + stage.height / 2);
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
      this.#startPan(e);
      this.#spacePanned = true;
      return;
    }
    if (e.button === 1) {
      // Middle-button drag pans too.
      this.#startPan(e);
      return;
    }
    if (e.target === e.currentTarget) {
      this.#commitTextEdit();
      if (this.#store.selection.value) this.#store.selection.set(null);
    }
  };

  #startPan(e: PointerEvent): void {
    this.#pan = { x: e.clientX, y: e.clientY, cam: { ...this.#cam } };
    this.#stageRef.value!.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.requestUpdate();
  }

  #onStagePointerMove = (e: PointerEvent) => {
    if (!this.#pan) return;
    const scale = this.#displayScale();
    this.#setCamera({
      x: this.#pan.cam.x - (e.clientX - this.#pan.x) / scale,
      y: this.#pan.cam.y - (e.clientY - this.#pan.y) / scale,
    });
  };

  #onStagePointerUp = () => {
    if (!this.#pan) return;
    this.#pan = null;
    this.requestUpdate();
  };

  /**
   * The wheel (two-finger scroll on a trackpad) pans the scene; Cmd/Ctrl+wheel
   * and trackpad pinch (which browsers report as ctrl+wheel) zoom around the cursor.
   */
  #onWheel = (e: WheelEvent) => {
    if (!this.#canvasRef.value) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.#viewSize().h : 1;
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * unit * 0.0025);
      void this.#zoomAt(this.#store.zoom.value * factor, e.clientX, e.clientY);
      return;
    }
    const scale = this.#displayScale();
    // Shift+wheel on a mouse scrolls sideways.
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    this.#setCamera({ x: this.#cam.x + (dx * unit) / scale, y: this.#cam.y + (dy * unit) / scale });
  };

  /** Sets zoom while keeping the image point under (clientX, clientY) fixed on screen. */
  async #zoomAt(zoom: number, clientX: number, clientY: number): Promise<void> {
    const stage = this.#stageRef.value;
    if (!stage) return;
    const p = this.#imagePointAt(clientX, clientY);
    this.#store.setZoom(zoom);
    const rect = stage.getBoundingClientRect();
    const scale = this.#displayScale();
    this.#cam = {
      x: p.x - (clientX - rect.left - rect.width / 2) / scale,
      y: p.y - (clientY - rect.top - rect.height / 2) / scale,
    };
    this.#scheduleViewSave();
    await this.#settleLayout();
  }

  /**
   * Zooms so the page content (the image plus anything drawn past it) fits
   * the stage, never above 100%, and centers it. Does not touch the page's
   * saved view (Reset view does): fitting is only a way to look.
   */
  async #fitToWindow(): Promise<void> {
    const page = this.#store.activePage;
    const stage = this.#stageRef.value;
    if (!stage) return;
    const dpr = window.devicePixelRatio || 1;
    if (!page.shapes.length) {
      // A blank page: 100% on screen (one image pixel per CSS pixel), (0, 0) in the middle.
      this.#store.setZoom(dpr);
      this.#cam = { x: 0, y: 0 };
      await this.#settleLayout();
      return;
    }
    const c = sceneBounds(page.shapes);
    const availW = stage.clientWidth - 32;
    const availH = stage.clientHeight - 32;
    if (availW <= 0 || availH <= 0 || !c.w || !c.h) return;
    // Screenshots open at most at their own pixel size; slides made of text and shapes at most at 100% on screen.
    const cap = page.shapes.some((s) => s.type === 'picture') ? 1 : dpr;
    this.#store.setZoom(Math.min(cap, (availW * dpr) / c.w, (availH * dpr) / c.h));
    this.#cam = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
    await this.#settleLayout();
  }

  #onPointerDown = (e: PointerEvent) => {
    if (this.#spaceHeld || e.button !== 0) return;
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
      // A picture is grabbed only once selected: pressing on an unselected one
      // starts a selection region (a click selects it, Shift+click adds it).
      if (hit && (hit.type !== 'picture' || this.#store.selectedIds.includes(hit.id))) {
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
      if (hit?.type === 'text') {
        this.#startTextEdit(hit);
        return;
      }
      // A click types at the point; a drag first draws the box (its width wraps the text). See #onPointerUp.
      this.#drawing = true;
      this.#dragStart = pt;
      this.#currentPoints = [pt];
      capture();
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
    if (drag.grab === 2) {
      const l = o.points[1]!;
      return { ...o, lensRadius: Math.max(12, Math.round(Math.hypot(pt.x - l.x, pt.y - l.y))) };
    }
    if (drag.grab === 0 || drag.grab === 1) {
      const points = [...o.points];
      // Shift snaps the dragged end to 45° around the other end.
      points[drag.grab] = shift ? snapAngle(o.points[1 - drag.grab]!, pt) : pt;
      return { ...o, points };
    }
    if (drag.grab === 'move') return o;
    if (o.type === 'text') {
      // A side or corner sets the wrap width and/or the box's minimum height; the far sides stay put.
      const L = layoutText(o);
      const g = drag.grab;
      const [l, t, r, b] = resizeBox(L.inner, g, pt.x - drag.start.x, pt.y - drag.start.y);
      const fs = o.fontSize ?? 18;
      const next: Shape = { ...o };
      let { x, y } = L.inner;
      if (g.includes('e') || g.includes('w')) {
        next.width = Math.max(fs * 2, Math.round(r - l));
        if (g.includes('w')) x = L.inner.x + L.inner.w - next.width;
      }
      if (g.includes('n') || g.includes('s')) {
        const h = Math.max(fs * LINE_HEIGHT, Math.round(b - t));
        next.height = h;
        if (g.includes('n')) y = L.inner.y + L.inner.h - h;
      }
      next.points = [{ x, y }];
      return next;
    }
    const from = boundsRect(o);
    let [l, t, r, b] = resizeBox(from, drag.grab, pt.x - drag.start.x, pt.y - drag.start.y);
    // Pictures keep their aspect ratio on a corner drag unless Shift is held; other boxes only with Shift.
    const keepRatio = o.type === 'picture' ? !shift : shift;
    if (keepRatio && drag.grab.length === 2 && from.w > 0 && from.h > 0) {
      // Keep the aspect ratio, anchored at the opposite corner.
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
      const hit = hitTestShapes(this.#store.activePage.shapes, pt);
      if (handle === 2) cursor = 'ew-resize';
      else if (handle === 0 || handle === 1) cursor = 'grab';
      else if (handle) cursor = GRAB_CURSOR[handle];
      else if (regionGrab && regionGrab !== 'move') cursor = GRAB_CURSOR[regionGrab];
      else if (hit && (hit.type !== 'picture' || this.#store.selectedIds.includes(hit.id))) cursor = 'move';
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
          // A plain click: select the picture under it (Shift toggles it), or nothing.
          this.#region = null;
          const pic = this.#pictureAt(regionDrag.start);
          if (regionDrag.additive) {
            if (pic) this.#store.toggleShapeSelected(pic.id);
          } else {
            this.#store.selectShapes(pic ? [pic.id] : []);
          }
        } else {
          // Other shapes are picked when the box touches them; pictures (often
          // the backdrop the box is drawn on) only when it takes them in whole.
          const hits = shapesInRect(this.#store.activePage.shapes, r)
            .filter((s) => s.type !== 'picture' || containsRect(r, shapeBounds(s)))
            .map((s) => s.id);
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
    if (tool === 'text' && start) {
      const end = points[1] ?? pt;
      const box = sortedRect(start.x, start.y, end.x, end.y);
      if (dragDistance < CLICK_THRESHOLD || box.w < CLICK_THRESHOLD * 4) this.#startTextEdit(null, start);
      else this.#startTextEdit(null, { x: box.x, y: box.y }, 'text', undefined, Math.round(box.w));
      void this.#redraw();
      return;
    }
    if (dragDistance < CLICK_THRESHOLD) {
      // A click (no real drag) with a draw tool active would only produce a
      // degenerate zero-size shape — treat it as "select whatever's under
      // the cursor" instead, same as the Select tool would.
      const hit = start ? hitTestShapes(this.#store.activePage.shapes, start) : null;
      if (hit && e.shiftKey) this.#store.toggleShapeSelected(hit.id);
      else if (hit) this.#store.selection.set({ type: 'shapes', ids: [hit.id] });
      else this.#store.selection.set(null);
    } else if (points.length >= 2) {
      this.#store.addShape(this.#newShape(tool, points));
    }
    void this.#redraw();
  };

  /** Resizes a picture to its image's own pixel size, keeping its center. */
  async #resetPictureSize(shape: Shape): Promise<void> {
    if (!shape.src) return;
    const img = new Image();
    img.src = shape.src;
    try {
      await img.decode();
    } catch {
      return;
    }
    const b = shapeBounds(shape);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    this.#store.replaceShape({ ...shape, points: [{ x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy + h / 2 }] });
    await this.updateComplete;
    await this.#redraw();
  }

  // ---------- find text (OCR) ----------

  #openSearch(): void {
    const pageId = this.#store.activePageId.value;
    if (!this.#search) this.#search = { pageId, query: '', hits: [], index: 0, status: '' };
    this.requestUpdate();
    void this.updateComplete.then(() => {
      this.#searchInputRef.value?.focus();
      this.#searchInputRef.value?.select();
    });
    // Start reading the page right away, so results are ready by the time a word is typed.
    for (const p of this.#store.activePage.shapes) if (p.type === 'picture' && p.src) void recognizeLines(p.src).catch(() => {});
  }

  #closeSearch = () => {
    this.#search = null;
    clearTimeout(this.#searchTimer);
    this.requestUpdate();
    void this.#redraw();
  };

  /** Runs the query against the active page's recognized text. */
  async #runSearch(): Promise<void> {
    const search = this.#search;
    const pictures = this.#store.activePage.shapes.filter((s) => s.type === 'picture' && s.src);
    if (!search) return;
    const pageId = this.#store.activePageId.value;
    const query = search.query;
    search.pageId = pageId;
    if (!query.trim()) {
      Object.assign(search, { hits: [], index: 0, status: '' });
      this.requestUpdate();
      void this.#redraw();
      return;
    }
    search.status = 'Reading text…';
    this.requestUpdate();
    try {
      // Each picture is read on its own; its matches are mapped from its pixels onto the page.
      const perPicture = await Promise.all(
        pictures.map(async (p) => {
          const [lines, img] = await Promise.all([recognizeLines(p.src!), decodePicture(p.src!)]);
          const b = shapeBounds(p);
          const sx = b.width / (img.naturalWidth || 1);
          const sy = b.height / (img.naturalHeight || 1);
          return findText(lines, query).map((r) => ({ x: b.x + r.x * sx, y: b.y + r.y * sy, w: r.w * sx, h: r.h * sy }));
        })
      );
      // Ignore a result for a query or page that has since changed.
      if (this.#search !== search || search.query !== query || this.#store.activePageId.value !== pageId) return;
      search.hits = perPicture.flat();
      search.index = 0;
      search.status = search.hits.length ? '' : 'No matches';
    } catch (err) {
      search.status = `Text recognition unavailable: ${(err as Error).message}`;
    }
    this.requestUpdate();
    await this.#redraw();
    this.#scrollToSearchHit();
  }

  #onSearchInput = (e: Event) => {
    if (!this.#search) return;
    this.#search.query = (e.target as HTMLInputElement).value;
    clearTimeout(this.#searchTimer);
    this.#searchTimer = setTimeout(() => void this.#runSearch(), 200);
  };

  #onSearchKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.#closeSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.#stepSearch(e.shiftKey ? -1 : 1);
    }
  };

  #stepSearch(dir: 1 | -1): void {
    const s = this.#search;
    if (!s?.hits.length) return;
    s.index = (s.index + dir + s.hits.length) % s.hits.length;
    this.requestUpdate();
    void this.#redraw().then(() => this.#scrollToSearchHit());
  }

  #activeSearchHits(): Rect[] {
    const s = this.#search;
    return s && s.pageId === this.#store.activePageId.value ? s.hits : [];
  }

  #drawSearchHits(ctx: CanvasRenderingContext2D): void {
    const hits = this.#activeSearchHits();
    if (!hits.length) return;
    const unit = 1 / this.#displayScale();
    ctx.save();
    hits.forEach((r, i) => {
      const current = i === this.#search!.index;
      ctx.fillStyle = current ? 'rgba(255, 149, 0, 0.35)' : 'rgba(255, 214, 10, 0.25)';
      ctx.fillRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
      ctx.strokeStyle = current ? '#ff9500' : 'rgba(255, 179, 0, 0.9)';
      ctx.lineWidth = (current ? 3 : 1.5) * unit;
      ctx.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
    });
    ctx.restore();
  }

  /** Centers the current match if it is off screen (without remembering that as the page's view). */
  #scrollToSearchHit(): void {
    const s = this.#search;
    const r = s?.hits[s.index];
    const stage = this.#stageRef.value;
    if (!r || !stage) return;
    const c = this.#clientOf({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    if (!c) return;
    const box = stage.getBoundingClientRect();
    if (c.x > box.left + 40 && c.x < box.right - 40 && c.y > box.top + 40 && c.y < box.bottom - 40) return;
    this.#setCamera({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, false);
  }

  /** Turns every match into a highlight or blur shape (one undo step). */
  #markSearchHits(type: 'highlight' | 'blur'): void {
    const hits = this.#activeSearchHits();
    if (!hits.length) return;
    const pad = type === 'blur' ? 3 : 2;
    this.#store.addShapes(
      hits.map((r) => ({
        ...this.#newShape(type, [
          { x: r.x - pad, y: r.y - pad },
          { x: r.x + r.w + pad, y: r.y + r.h + pad },
        ]),
        ...(type === 'highlight' ? { color: '#ffcc00' } : {}),
      }))
    );
    this.#flashStatus(`${type === 'blur' ? 'Blurred' : 'Highlighted'} ${hits.length} match${hits.length === 1 ? '' : 'es'}`);
  }

  #renderSearchBar() {
    const s = this.#search;
    if (!s) return '';
    const hits = this.#activeSearchHits();
    const count = hits.length ? `${s.index + 1}/${hits.length}` : s.status;
    return html`
      <div class="search-bar" @pointerdown=${(e: Event) => e.stopPropagation()}>
        <input
          ${ref(this.#searchInputRef)}
          type="search"
          placeholder="Find text in image"
          .value=${live(s.query)}
          @input=${this.#onSearchInput}
          @keydown=${this.#onSearchKey}
        />
        <span class="search-count">${count}</span>
        <button ?disabled=${hits.length < 2} @click=${() => this.#stepSearch(-1)} title="Previous (Shift+Enter)">‹</button>
        <button ?disabled=${hits.length < 2} @click=${() => this.#stepSearch(1)} title="Next (Enter)">›</button>
        <button ?disabled=${!hits.length} @click=${() => this.#markSearchHits('highlight')} title="Add a highlight over every match">Highlight all</button>
        <button ?disabled=${!hits.length} @click=${() => this.#markSearchHits('blur')} title="Blur every match (e.g. an email address or token)">Blur all</button>
        <button @click=${this.#closeSearch} title="Close (Esc)">✕</button>
      </div>
    `;
  }

  // ---------- image diff ----------

  /**
   * Outlines where picture `pic` (on the active page) differs from image
   * `otherSrc` with rectangles in the current color (one undo step).
   */
  async #highlightChanges(pic: Shape, otherSrc: string, against: string): Promise<void> {
    if (!pic.src) return;
    this.#flashStatus('Comparing…');
    try {
      const [boxes, img] = await Promise.all([diffRegions(pic.src, otherSrc), decodePicture(pic.src)]);
      if (!boxes.length) {
        this.#flashStatus(`No differences from ${against}`);
        return;
      }
      if (boxes.length > 80) {
        this.#flashStatus(`Too many differences from ${against} (${boxes.length} areas): are these the same screen?`);
        return;
      }
      // Boxes are in the picture's own pixels; map them onto the page.
      const b = shapeBounds(pic);
      const sx = b.width / (img.naturalWidth || 1);
      const sy = b.height / (img.naturalHeight || 1);
      this.#store.addShapes(
        boxes.map((r) =>
          this.#newShape('rect', [
            { x: b.x + r.x * sx, y: b.y + r.y * sy },
            { x: b.x + (r.x + r.w) * sx, y: b.y + (r.y + r.h) * sy },
          ])
        )
      );
      this.#store.selectShapes([]);
      this.#flashStatus(`Marked ${boxes.length} change${boxes.length === 1 ? '' : 's'} from ${against}`);
    } catch (err) {
      this.#flashStatus(`Compare failed: ${(err as Error).message}`);
    }
  }

  /**
   * Blurs every word that looks like a secret (email, API key, token) in
   * `pictures` (default: all on the page), using on-device text recognition.
   * One undo step. `auto`: started by auto-redact on a new picture, so it says
   * nothing when there is nothing to hide.
   */
  async #redactSecrets(pictures?: Shape[], auto = false): Promise<void> {
    const pageId = this.#store.activePageId.value;
    const list = (pictures ?? this.#store.activePage.shapes).filter((s) => s.type === 'picture' && s.src);
    if (!list.length) return;
    this.#flashStatus(auto ? 'Auto-redact: reading text…' : 'Reading text…');
    try {
      const boxes = (
        await Promise.all(
          list.map(async (p) => {
            const [lines, img] = await Promise.all([recognizeLines(p.src!), decodePicture(p.src!)]);
            const b = shapeBounds(p);
            const sx = b.width / (img.naturalWidth || 1);
            const sy = b.height / (img.naturalHeight || 1);
            return findSecrets(lines).map((r) => ({ x: b.x + r.x * sx, y: b.y + r.y * sy, w: r.w * sx, h: r.h * sy }));
          })
        )
      ).flat();
      // The page changed (or the pictures went away) while reading: don't blur the wrong place.
      const page = this.#store.activePage;
      if (page.id !== pageId || !list.every((p) => page.shapes.some((s) => s.id === p.id))) return;
      if (!boxes.length) {
        this.#flashStatus(auto ? '' : 'No emails, keys, or tokens found');
        return;
      }
      const pad = 3;
      this.#store.addShapes(boxes.map((r) => this.#newShape('blur', [{ x: r.x - pad, y: r.y - pad }, { x: r.x + r.w + pad, y: r.y + r.h + pad }])));
      this.#flashStatus(`Blurred ${boxes.length} possible secret${boxes.length === 1 ? '' : 's'} (Cmd/Ctrl+Z to undo)`);
    } catch (err) {
      this.#flashStatus(`Text recognition unavailable: ${(err as Error).message}`);
    }
  }

  #toggleAutoRedact(): void {
    const on = !this.#store.autoRedact.value;
    this.#store.autoRedact.set(on);
    this.#flashStatus(on ? 'Auto-redact on: new pictures get emails, keys, and tokens blurred' : 'Auto-redact off');
  }

  /** A page's main picture: its largest. */
  #mainPicture(page: Page): Shape | null {
    let best: Shape | null = null;
    let area = -1;
    for (const s of page.shapes) {
      if (s.type !== 'picture' || !s.src) continue;
      const b = shapeBounds(s);
      if (b.width * b.height > area) [best, area] = [s, b.width * b.height];
    }
    return best;
  }

  /** The nearest earlier page that has a picture. */
  #previousImagePage(): Page | null {
    const pages = this.#store.pages.value;
    const i = pages.findIndex((p) => p.id === this.#store.activePageId.value);
    for (let k = i - 1; k >= 0; k--) if (this.#mainPicture(pages[k]!)) return pages[k]!;
    return null;
  }

  /** Outlines what changed in `pic` (default: this page's main picture) since the previous page's main picture. */
  #highlightChangesVsPrevious(pic: Shape | null = this.#mainPicture(this.#store.activePage)): void {
    const prev = this.#previousImagePage();
    const other = prev && this.#mainPicture(prev);
    if (pic && other?.src) void this.#highlightChanges(pic, other.src, 'the previous page');
  }

  // ---------- copy as markdown ----------

  #copyAsMarkdown = async () => {
    try {
      const { markdown, html: rich } = await pagesToMarkdown(this.#pagesWithImages(), this.#exportBackground());
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
          'text/html': new Blob([rich], { type: 'text/html' }),
        }),
      ]);
      this.#flashStatus('Copied as Markdown (rich paste includes the images)');
    } catch (err) {
      this.#flashStatus(`Copy failed: ${(err as Error).message}`);
    }
  };

  /** Where an image-coordinate point is on screen. */
  #clientOf(p: Point): Point | null {
    const canvas = this.#canvasRef.value;
    if (!canvas?.width) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / canvas.width;
    return { x: rect.left + (p.x - this.#area.x) * scale, y: rect.top + (p.y - this.#area.y) * scale };
  }

  /** The topmost picture under `p`, if any. */
  #pictureAt(p: Point): Shape | null {
    const shapes = this.#store.activePage.shapes;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i]!;
      if (s.type !== 'picture') continue;
      const b = shapeBounds(s);
      if (p.x >= b.x && p.y >= b.y && p.x <= b.x + b.width && p.y <= b.y + b.height) return s;
    }
    return null;
  }

  #onDoubleClick = (e: MouseEvent) => {
    const hit = hitTestShapes(this.#store.activePage.shapes, this.#canvasPoint(e));
    if (hit?.type === 'text' || hit?.type === 'tag' || hit?.type === 'step') this.#startTextEdit(hit);
  };

  #singleSelectedTag(): Shape | null {
    const selected = this.#store.selectedShapes;
    return selected.length === 1 && selected[0]!.type === 'tag' ? selected[0]! : null;
  }

  // ---------- inline text editing ----------

  #startTextEdit(shape: Shape | null, anchor?: Point, kind: 'text' | 'tag' = 'text', initialValue?: string, width?: number): void {
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
          textStyle: { ...shape.textStyle },
          width: shape.width,
          height: shape.height,
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
          textStyle: { ...this.#store.activeTextStyle.value },
          width: kind === 'text' ? width : undefined,
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
    // Keep leading spaces on the first line (list indent); drop blank lines around the text.
    const label = edit.value.replace(/^(\s*\n)+/, '').trimEnd();
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
      else if (shape && (label !== shape.label || edit.width !== shape.width || edit.height !== shape.height)) {
        const next: Shape = { ...shape, label };
        if (shape.type === 'text') {
          next.width = edit.width;
          next.height = edit.height;
          if (next.width === undefined) delete next.width;
          if (next.height === undefined) delete next.height;
        }
        this.#store.replaceShape(next);
      }
    } else if (label) {
      const shape = this.#newShape(edit.kind, [edit.anchor]);
      shape.label = label;
      shape.color = edit.color;
      shape.fontSize = edit.fontSize;
      if (Object.keys(edit.textStyle).length) shape.textStyle = { ...edit.textStyle };
      if (edit.kind === 'tag') shape.tagArrow = edit.tagArrow;
      else {
        shape.fill = edit.fill;
        if (edit.width) shape.width = edit.width;
        if (edit.height) shape.height = edit.height;
      }
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
    const mod = e.metaKey || e.ctrlKey;
    const fmt = mod && !e.altKey ? ({ b: 'bold', i: 'italic', u: 'underline' } as const)[e.key.toLowerCase() as 'b' | 'i' | 'u'] : undefined;
    if (fmt && this.#textEdit?.kind !== 'step') {
      e.preventDefault();
      this.#formatText(e.target as HTMLTextAreaElement, fmt);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'x' && this.#textEdit?.kind !== 'step') {
      e.preventDefault();
      this.#wrapSelection(e.target as HTMLTextAreaElement, '~~');
      return;
    }
    // Labels are multi-line: Shift+Enter adds a line, Enter saves.
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
        this.#editorFontCss(edit.textStyle),
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
    // The raw text (Markdown markers and all) sizes the field; it wraps at the box width if there is one.
    const raw = layoutRich(edit.value || ' ', edit.fontSize, edit.textStyle, edit.width ?? Infinity, true);
    const w = edit.width ?? Math.max(edit.fontSize * 2, raw.width + edit.fontSize * 0.6);
    const h = Math.max(raw.height, edit.fontSize * LINE_HEIGHT, edit.height ?? 0);
    this.#editorBox = { w, h, scale, pad };
    const style = [
      `left:${(edit.anchor.x - ox) * scale - pad}px`,
      `top:${(edit.anchor.y - oy) * scale - pad}px`,
      `font-size:${fontPx}px`,
      `line-height:${LINE_HEIGHT}`,
      `padding:${pad}px`,
      // +2: the dashed border sits inside the box (border-box).
      `width:${w * scale + pad * 2 + 2}px`,
      `height:${h * scale + pad * 2 + 2}px`,
      this.#editorFontCss(edit.textStyle),
      `color:${edit.fill ? contrastColor(edit.color) : edit.color}`,
      edit.fill ? `background:${edit.color}` : '',
    ].join(';');
    return html`
      <textarea
        ${ref(this.#textInputRef)}
        class="text-editor label-editor"
        style=${style}
        rows="1"
        .value=${live(edit.value)}
        placeholder="Text"
        @input=${(e: Event) => {
          edit.value = (e.target as HTMLTextAreaElement).value;
          this.requestUpdate();
        }}
        @keydown=${this.#onTextKeydown}
        @blur=${() => this.#commitTextEdit()}
        @pointerdown=${(e: Event) => e.stopPropagation()}
        @pointerup=${this.#onEditorResized}
        @mouseup=${this.#onEditorResized}
      ></textarea>
    `;
  }

  /** The text editor's box as last rendered (image pixels), to tell a drag of its resize grip from a click. */
  #editorBox: { w: number; h: number; scale: number; pad: number } | null = null;

  /** After the editor's resize grip is dragged: the new size becomes the box's wrap width / minimum height. */
  #onEditorResized = (e: Event) => {
    const el = e.currentTarget as HTMLTextAreaElement;
    const edit = this.#textEdit;
    const box = this.#editorBox;
    if (!edit || edit.kind !== 'text' || !box) return;
    const w = (el.offsetWidth - 2 - box.pad * 2) / box.scale;
    const h = (el.offsetHeight - 2 - box.pad * 2) / box.scale;
    let changed = false;
    if (Math.abs(w - box.w) > 1) {
      edit.width = Math.max(edit.fontSize * 2, Math.round(w));
      changed = true;
    }
    if (Math.abs(h - box.h) > 1) {
      edit.height = Math.max(edit.fontSize * LINE_HEIGHT, Math.round(h));
      changed = true;
    }
    if (changed) this.requestUpdate();
  };

  /** CSS for the in-place editor so it looks like the label's base style. */
  #editorFontCss(t: TextStyle): string {
    return [
      `font-family:${FONT_FAMILIES[t.font ?? 'sans']}`,
      `font-weight:${t.bold ?? true ? 'bold' : 'normal'}`,
      `font-style:${t.italic ? 'italic' : 'normal'}`,
      `text-decoration:${t.underline ? 'underline' : 'none'}`,
      `text-align:${t.align ?? 'left'}`,
    ].join(';');
  }

  /**
   * Cmd/Ctrl+B / I / U in the editor: with text selected, wraps it in the
   * Markdown marker (or unwraps it); with nothing selected, toggles that
   * style for the whole label.
   */
  #formatText(field: HTMLTextAreaElement, mark: 'bold' | 'italic' | 'underline'): void {
    if (field.selectionStart !== field.selectionEnd) {
      this.#wrapSelection(field, mark === 'bold' ? '**' : mark === 'italic' ? '*' : '__');
      return;
    }
    this.#toggleTextStyle(mark);
  }

  #wrapSelection(field: HTMLTextAreaElement, marker: string): void {
    const edit = this.#textEdit;
    if (!edit) return;
    const { selectionStart: a, selectionEnd: b, value } = field;
    const before = value.slice(0, a);
    const inner = value.slice(a, b);
    const after = value.slice(b);
    const n = marker.length;
    let next: string;
    let selA: number;
    let selB: number;
    if (before.endsWith(marker) && after.startsWith(marker)) {
      next = before.slice(0, -n) + inner + after.slice(n);
      selA = a - n;
      selB = b - n;
    } else if (inner.length > n * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
      next = before + inner.slice(n, -n) + after;
      selA = a;
      selB = b - n * 2;
    } else {
      next = before + marker + inner + marker + after;
      selA = a + n;
      selB = b + n;
    }
    edit.value = next;
    field.value = next;
    field.setSelectionRange(selA, selB);
    this.requestUpdate();
  }

  /** Flips one on/off style (bold is on unless turned off) for the selected labels and the open editor. */
  #toggleTextStyle(mark: 'bold' | 'italic' | 'underline'): void {
    const current = this.#currentStyle().textStyle;
    const on = mark === 'bold' ? (current.bold ?? true) : !!current[mark];
    this.#applyStyle({ textStyle: { [mark]: !on } });
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
    const r = this.#copyArea();
    if (!r) return;
    try {
      await copyRegion(this.#store.activePage, r, this.#exportBackground());
      // The copied pixels, not older in-app shapes, are what Cmd/Ctrl+V should paste next
      // (as a movable, resizable picture on a page that has an image).
      this.#store.clearClipboard();
      this.#flashStatus('Selection copied to clipboard');
    } catch (err) {
      this.#flashStatus(`Copy failed: ${(err as Error).message}`);
    }
  };

  /** Crops every picture the region overlaps to where it overlaps; annotations stay put and editable. Undoable. */
  #cropRegion = async () => {
    const sel = this.#activeRegion();
    if (!sel) return;
    const shapes = this.#store.activePage.shapes;
    try {
      const cropped = await Promise.all(
        shapes.map(async (s) => (s.type === 'picture' && containsAny(sel, shapeBounds(s)) ? await cropPicture(s, sel) : s))
      );
      if (!shapes.some((s, i) => s.type === 'picture' && cropped[i] !== s)) {
        this.#flashStatus('The selection does not cover a picture');
        return;
      }
      // A picture the region only grazed (under a pixel) is dropped by cropPicture; keep it instead.
      this.#store.replaceActivePageShapes(cropped.map((c, i) => c ?? shapes[i]!));
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
        <button @click=${this.#cropRegion} title="Crop the pictures under the selection to it (Enter)">✂ Crop selection</button>
        <button @click=${() => this.#clearRegion()} title="Clear selection (Esc)">✕</button>
      </div>
    `;
  }

  // ---------- image transforms ----------

  /**
   * Rotates or flips the selected pictures in place; with none selected, the
   * whole page (every picture and annotation) about its pictures' center.
   * Undoable.
   */
  async #transformImage(transform: ImageTransform): Promise<void> {
    const page = this.#store.activePage;
    if (!page.shapes.length) return;
    this.#commitTextEdit();
    const selected = new Set(this.#store.selectedShapes.filter((s) => s.type === 'picture').map((s) => s.id));
    try {
      let next: Shape[];
      if (selected.size) {
        next = await Promise.all(page.shapes.map((s) => (selected.has(s.id) ? transformPicture(s, transform) : s)));
      } else {
        // transformShape works in a W×H frame at the origin: shift the pictures' box there and back.
        const f = focusBounds(page.shapes);
        const rotates = transform === 'rotate-cw' || transform === 'rotate-ccw';
        const back = { x: f.x + (rotates ? (f.w - f.h) / 2 : 0), y: f.y + (rotates ? (f.h - f.w) / 2 : 0) };
        next = await Promise.all(
          page.shapes.map(async (s) => {
            const moved = offsetShape(s, -f.x, -f.y);
            const t = s.type === 'picture' ? await transformPicture(moved, transform) : moved;
            return offsetShape(transformShape(t, transform, f.w, f.h), back.x, back.y);
          })
        );
      }
      this.#store.replaceActivePageShapes(next);
      if (selected.size) this.#store.selectShapes([...selected]);
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
      // Long messages (e.g. a link's expiry) stay up long enough to read.
    }, Math.max(2000, msg.length * 50));
  }

  #pagesWithImages() {
    return this.#store.pages.value.filter((p) => p.shapes.length > 0);
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

  /** Whether the toolbar shows text formatting: a label is being edited, the selection is all labels, or a label tool is active. */
  #textStyleContext(): boolean {
    const edit = this.#textEdit;
    if (edit) return edit.kind !== 'step';
    const selected = this.#store.selectedShapes;
    if (selected.length) return selected.every((s) => s.type === 'text' || s.type === 'tag');
    const tool = this.#store.activeTool.value;
    return tool === 'text' || tool === 'tag';
  }

  #renderTextStyleControls(t: TextStyle) {
    // mousedown preventDefault keeps focus (and so the open editor) in the text field.
    const keep = (e: Event) => e.preventDefault();
    const align = t.align ?? 'left';
    return html`
      <div class="group text-style">
        <button class=${t.bold ?? true ? 'active' : ''} @mousedown=${keep} @click=${() => this.#toggleTextStyle('bold')} title="Bold (Cmd/Ctrl+B; with text selected while typing: **bold** just that part)"><b>B</b></button>
        <button class=${t.italic ? 'active' : ''} @mousedown=${keep} @click=${() => this.#toggleTextStyle('italic')} title="Italic (Cmd/Ctrl+I; *italic* for part of the text)"><i>I</i></button>
        <button class=${t.underline ? 'active' : ''} @mousedown=${keep} @click=${() => this.#toggleTextStyle('underline')} title="Underline (Cmd/Ctrl+U; __underline__ for part of the text)"><u>U</u></button>
        ${(['left', 'center', 'right'] as const).map(
          (a) => html`<button
            class=${align === a ? 'active' : ''}
            @mousedown=${keep}
            @click=${() => this.#applyStyle({ textStyle: { align: a } })}
            title="Align ${a}"
          >${a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}</button>`
        )}
        <select
          title="Font"
          .value=${live(t.font ?? 'sans')}
          @change=${(e: Event) => this.#applyStyle({ textStyle: { font: (e.target as HTMLSelectElement).value as TextFont } })}
        >
          ${(Object.keys(FONT_LABELS) as TextFont[]).map((f) => html`<option value=${f}>${FONT_LABELS[f]}</option>`)}
        </select>
        <span
          class="md-help"
          title=${'Formatting while typing:\n**bold**  *italic*  __underline__  ~~strike~~  `code`\n# Heading, ## Smaller heading\n- bullet (indent with 2 spaces)\n1. numbered\n[ ] to-do, [x] done\nShift+Enter: new line · Enter: done'}
          >?</span
        >
      </div>
    `;
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
      textStyle: this.#textEdit?.textStyle ?? (first && (first.type === 'text' || first.type === 'tag') ? (first.textStyle ?? {}) : this.#store.activeTextStyle.value),
    };
  }

  /** Sets the tool default(s) and restyles every selected shape (and the open text editor) to match. */
  #applyStyle(style: ShapeStyle): void {
    if (style.color !== undefined) this.#store.activeColor.set(style.color);
    if (style.lineWidth !== undefined) this.#store.activeLineWidth.set(style.lineWidth);
    if (style.fontSize !== undefined) this.#store.activeFontSize.set(style.fontSize);
    if (style.fill !== undefined) this.#store.activeFill.set(style.fill);
    if (style.tagArrow !== undefined) this.#store.activeTagArrow.set(style.tagArrow);
    if (style.textStyle) this.#store.activeTextStyle.set({ ...this.#store.activeTextStyle.value, ...style.textStyle });
    const edit = this.#textEdit;
    if (edit) {
      if (style.textStyle) edit.textStyle = { ...edit.textStyle, ...style.textStyle };
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
      this.#store.pages.value.some((p) => p.shapes.length > 0)
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
    if (name && this.#localFile) {
      clearTimeout(this.#fileTimer);
      this.#localFile = null;
      this.#lastFileSavedPages = null;
    }
    setCloudNameInHash(name);
    this.#syncDocInfo();
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
    this.#checkFileAutosave();
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
      void rememberRecentThumbnail(name, pages.find((p) => p.shapes.length > 0));
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
    // Nothing to confirm: another document opens as its own draft, and the current one stays in Drafts.
    void confirmReplace;
    this.#commitTextEdit();
    try {
      const { pages, activePageId } = await parseDocumentValue(await loadCloudDocument(name));
      // A live reload keeps you on the page you were looking at, when it still exists.
      const current = this.#store.activePageId.value;
      const stay = keepView && pages.some((p) => p.id === current) ? current : activePageId;
      if (name === this.#cloudName) {
        this.#store.loadDocument(pages, stay);
      } else {
        // Another document: open it as its own draft (reusing its earlier draft), keeping the current one.
        this.#rememberView();
        const existing = (await listDrafts()).find((d) => d.cloudName === name)?.id ?? null;
        this.#store.openAsNewDraft(pages, stay, { cloudName: name }, existing);
        void this.#loadDrafts();
      }
      this.#setCloudName(name);
      this.#markSaved();
      this.#clearRegion();
      void this.#joinChannel(name);
      await this.updateComplete;
      await this.#redraw();
      if (!keepView) await this.#restoreView();
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
      void rememberRecentThumbnail(name, pages.find((p) => p.shapes.length > 0));
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
    this.#rememberView();
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
    const withImages = pages.filter((p) => p.shapes.length > 0);
    // Transparent outside the image, so margin tags sit on the presenter's
    // dark stage as they do in the editor, not on an exported-white box.
    return Promise.all(
      withImages.map(async (p) => {
        const revealed = p.reveal ? p.shapes.filter((s) => REVEALED.includes(s.type)) : [];
        const builds: string[] = [];
        let width = 0;
        let height = 0;
        let focusWidth = 0;
        let focusHeight = 0;
        // The editor's framing (pan and zoom), when known: the slide shows exactly that area.
        const v = p.view;
        const frame = v?.w && v.h ? { x: Math.round(v.x - v.w / 2), y: Math.round(v.y - v.h / 2), w: v.w, h: v.h } : undefined;
        // Render at about screen resolution: zoomed-in frames and slides of only text and shapes stay sharp.
        const pictures = p.shapes.some((s) => s.type === 'picture');
        const ratio = Math.min(4, Math.max(pictures ? 1 : 2, frame ? (v?.zoom ?? 1) : 1));
        for (let k = 0; k <= revealed.length; k++) {
          const hidden = new Set(revealed.slice(k).map((s) => s.id));
          const shown = p.shapes.filter((s) => !hidden.has(s.id));
          // Every build is sized by all shapes, so revealing never shifts or rescales the slide;
          // centered, so the images stay put between pages whose tags sit on different sides.
          const flat = await flattenPage(shown, {
            background: null,
            sceneShapes: p.shapes,
            centered: true,
            // A page framed by hand (panned/zoomed in the editor) is centered where it was framed.
            center: p.view,
            pixelRatio: ratio,
            area: frame,
          });
          width = flat.canvas.width / ratio;
          height = flat.canvas.height / ratio;
          ({ w: focusWidth, h: focusHeight } = frame ?? flat.focus);
          builds.push(flat.canvas.toDataURL('image/png'));
        }
        return { builds, width, height, focusWidth, focusHeight, framed: !!frame, title: p.title ?? '', notes: withNotes ? (p.notes ?? '') : '' };
      })
    );
  }

  #present = async (fromPageId?: string) => {
    this.#commitTextEdit();
    this.#rememberView();
    const pages = this.#store.pages.value;
    const withImages = pages.filter((p) => p.shapes.length > 0);
    if (!withImages.length) return;
    try {
      const slides = await this.#renderSlides(pages, true);
      const start = fromPageId ?? this.#store.activePageId.value;
      const index = Math.max(0, withImages.findIndex((p) => p.id === start));
      // Framed slides fit the screen; older, unframed ones open at the editor zoom.
      const zoom = slides.some((sl) => sl.framed) ? undefined : this.#store.zoom.value;
      this.#presenting = { slides, index, publicView: false, heading: this.#cloudName ?? '', message: '', zoom };
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
      this.#publicDoc = await parseDocumentValue(content);
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
    // A new draft: whatever was open in this browser stays in Drafts.
    this.#store.openAsNewDraft(structuredClone(doc.pages), doc.activePageId);
    this.#setCloudName(null);
    this.#setLocalFile(null);
    this.#presenting = null;
    void mountAccountUi();
    await this.updateComplete;
    await this.#redraw();
    await this.#restoreView();
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
    const pt = this.#canvasPoint(e);
    const hit = hitTestShapes(this.#store.activePage.shapes, pt);
    if (hit) {
      if (!this.#store.selectedIds.includes(hit.id)) this.#store.selectShapes([hit.id]);
      const editable = this.#store.selectedIds.length === 1 && (hit.type === 'text' || hit.type === 'tag' || hit.type === 'step');
      const pictures = this.#store.selectedShapes.filter((s) => s.type === 'picture');
      const other = hit.type === 'picture' && pictures.length === 2 ? pictures.find((p) => p.id !== hit.id) : undefined;
      const pictureItems: MenuItem[] = [
        ...(pictures.length > 1 ? [{ label: 'Arrange pictures in a row', run: () => void this.#arrangePicturesInRow() }] : []),
        ...(hit.type === 'picture' && this.#store.selectedIds.length === 1
          ? [
              { label: 'Original size', run: () => void this.#resetPictureSize(hit) },
              {
                label: 'Highlight changes vs previous page',
                disabled: !this.#previousImagePage(),
                run: () => this.#highlightChangesVsPrevious(hit),
              },
            ]
          : []),
        ...(other?.src ? [{ label: 'Highlight changes vs the other picture', run: () => void this.#highlightChanges(hit, other.src!, 'the other picture') }] : []),
        ...(pictures.length ? [{ label: 'Redact secrets', run: () => void this.#redactSecrets(pictures) }] : []),
        ...(pictures.length
          ? [{ label: pictures.length === 1 ? 'Move to a new page' : `Move each to a new page (${pictures.length})`, run: () => this.#movePicturesToNewPages() }]
          : []),
      ];
      this.#openMenu(e, [
        ...(editable ? [{ label: hit.type === 'step' ? 'Edit number' : 'Edit text', shortcut: 'Enter', run: () => this.#startTextEdit(hit) }] : []),
        ...(hit.type === 'text' && (hit.width || hit.height) && this.#store.selectedIds.length === 1
          ? [{ label: 'Auto size (fit the text, no wrapping)', run: () => {
              const next = { ...hit };
              delete next.width;
              delete next.height;
              this.#store.replaceShape(next);
            } }]
          : []),
        ...pictureItems,
        ...(pictureItems.length ? ['sep' as const] : []),
        ...(hit.type === 'magnifier'
          ? [1.5, 2, 3, 4].map((m) => ({
              label: `${(hit.magnify ?? DEFAULT_MAGNIFY) === m ? '✓ ' : ''}Magnify ${m}×`,
              run: () => this.#store.replaceShape({ ...hit, magnify: m }),
            }))
          : []),
        { label: 'Duplicate', shortcut: '⌘D', run: () => this.#store.duplicateSelectedShapes() },
        { label: 'Cut', shortcut: '⌘X', run: () => this.#cutSelection() },
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
      { label: 'Copy as Markdown', run: () => void this.#copyAsMarkdown() },
      { label: 'Find text…', shortcut: '⌘F', run: () => this.#openSearch() },
      { label: 'Redact secrets', disabled: !this.#mainPicture(this.#store.activePage), run: () => void this.#redactSecrets() },
      { label: `${this.#store.autoRedact.value ? '✓ ' : ''}Auto-redact new pictures`, run: () => this.#toggleAutoRedact() },
      { label: `${this.#store.snapArrows.value ? '✓ ' : ''}Snap arrows to text and pictures`, run: this.#toggleSnapArrows },
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
      { label: 'Present from here', disabled: !page?.shapes.length, run: () => void this.#present(pageId) },
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

  #setToolbarCollapsed(collapsed: boolean): void {
    this.#toolbarCollapsed = collapsed;
    try {
      localStorage.setItem('screenmarker_toolbar', collapsed ? 'min' : 'full');
    } catch {
      // per-browser nicety only
    }
    this.requestUpdate();
  }

  /** ‹ Page n / N › and + : always at the start of the toolbar. */
  #renderPageNav(activeId: string) {
    const pages = this.#store.pages.value;
    const index = pages.findIndex((p) => p.id === activeId);
    return html`
      <div class="group page-nav">
        <button ?disabled=${pages.length < 2} @click=${() => this.#gotoAdjacentPage(-1)} title="Previous page (←)">‹</button>
        <span class="page-nav-label" title=${pages[index]?.title || this.#pageLabel(index)}>${index + 1} / ${pages.length}</span>
        <button ?disabled=${pages.length < 2} @click=${() => this.#gotoAdjacentPage(1)} title="Next page (→)">›</button>
        <button @click=${() => this.#addPage()} title="Add a blank page">+</button>
      </div>
    `;
  }

  /** The minimized toolbar: tool icons, undo/redo, present and copy. */
  #renderCompactToolbar(noImage: boolean) {
    return html`
      <div class="group compact-tools">
        ${TOOLS.map(
          (t) => html`<button
            class=${this.#store.activeTool.value === t.type ? 'active' : ''}
            title="${t.label} (${t.key.toUpperCase()})"
            @click=${() => this.#setTool(t.type)}
          >${t.icon}</button>`
        )}
      </div>
      <div class="spacer"></div>
      <button @click=${this.#newDocument} title="New document (the current one stays in Drafts)">＋</button>
      <button @click=${this.#openDraftsDialog} title="Drafts">🗂</button>
      <button @click=${this.#saveDocument} title="Save (Cmd/Ctrl+S)">💾</button>
      <button @click=${() => this.#store.undo()} title="Undo (Cmd/Ctrl+Z)">↶</button>
      <button @click=${() => this.#store.redo()} title="Redo (Shift+Cmd/Ctrl+Z)">↷</button>
      <button ?disabled=${noImage} @click=${() => this.#present()} title="Present all pages as slides">▶</button>
      <button class="button-primary" ?disabled=${noImage} @click=${this.#copyImage} title="Copy image">📋</button>
    `;
  }

  #setStripCollapsed(collapsed: boolean): void {
    this.#stripCollapsed = collapsed;
    try {
      localStorage.setItem('screenmarker_page_strip', collapsed ? 'tabs' : 'strip');
    } catch {
      // per-browser nicety only
    }
    this.requestUpdate();
  }

  /** Collapsed form of the page strip: compact tabs in the title bar, as before the sidebar existed. */
  #renderPageTabs(activeId: string) {
    const pages = this.#store.pages.value;
    return html`
      <button class="strip-toggle" title="Show page thumbnails" @click=${() => this.#setStripCollapsed(false)}>▤</button>
      <div
        class="tabs-inline"
        @dragover=${(e: DragEvent) => {
          if (this.#draggingPageId) e.preventDefault();
        }}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          const fromId = this.#draggingPageId;
          this.#draggingPageId = null;
          this.#dragOverPageId = null;
          this.#dragOverSide = null;
          if (fromId && this.#store.reorderPageToEnd(fromId)) this.#flashMovedTab(fromId);
          else this.requestUpdate();
        }}
      >
        ${pages.map(
          (p, i) => html`
            <div
              class="tab ${p.id === activeId ? 'active' : ''} ${this.#dragOverPageId === p.id
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
              ${p.title || this.#pageLabel(i)}
              <span class="tab-close" title="Delete page" @click=${(e: Event) => this.#closePage(e, p.id)}>×</span>
            </div>
          `
        )}
        <div class="tab-add" @click=${() => this.#addPage()} title="Add page">+</div>
      </div>
    `;
  }

  #renderPageStrip(activeId: string) {
    if (this.#stripCollapsed) return '';
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
                ${thumb ? html`<img src=${thumb} alt="" draggable="false" />` : html`<span>${p.shapes.length ? '…' : 'Empty'}</span>`}
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
        <button class="page-add" @click=${() => this.#setStripCollapsed(true)} title="Collapse to tabs in the top bar">« Tabs</button>
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
        <label class="slide-reveal" title="When presenting, show this page's tags, step markers and magnifiers one per click, in the order you added them">
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

  /** Starts typing a text label in the middle of the view (the empty page's "Add text"). */
  #startBlankText(): void {
    this.#setTool('text');
    const fs = this.#store.activeFontSize.value;
    this.#startTextEdit(null, { x: Math.round(this.#cam.x - fs * 4), y: Math.round(this.#cam.y - fs) });
  }

  #renderEmpty() {
    const recent = !this.#hasContent() ? (this.#recent ?? []) : [];
    const drafts = !this.#hasContent() ? (this.#drafts ?? []).filter((d) => d.id !== this.#store.draftId) : [];
    return html`
      <div class="empty empty-overlay">
        <div>
          Paste a screenshot (Cmd/Ctrl+V), drag one in, or use "Open image…" above.<br />
          Drop a video (MP4, MOV) or use <button class="empty-text" @click=${this.#pickVideo}>🎞 Video frames…</button> to pick frames as pages.<br />
          Or use this page as a blank slide:
          <button class="empty-text" @click=${() => this.#startBlankText()}>T Add text</button>
          or pick any tool (text, arrows, shapes, tags…) and draw.
        </div>
        ${drafts.length
          ? html`
              <div class="recent-heading">
                Drafts in this browser
                ${drafts.length > 8 ? html`<button class="empty-text" @click=${this.#openDraftsDialog}>See all ${drafts.length}</button>` : ''}
              </div>
              ${this.#renderDraftCards(8)}
            `
          : ''}
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

  /** Fill outside the image for copies/downloads, per the export background setting; null is transparent. */
  #exportBackground(): string | null {
    const pref = this.#store.exportBackground.value;
    if (pref === 'transparent') return null;
    if (pref === 'theme') return this.#sceneColor();
    return pref;
  }

  /** The scene background as CSS (may be light-dark(), so it follows the color scheme). */
  #sceneCss(): string {
    const pref = this.#store.sceneBackground.value;
    if (pref === 'system') return 'light-dark(#ffffff, #000000)';
    if (pref === 'theme') return 'var(--bg)';
    return pref;
  }

  /** The scene background resolved to a concrete color (for exports and slides). */
  #sceneColor(): string {
    const stage = this.#stageRef.value;
    const c = stage ? getComputedStyle(stage).backgroundColor : '';
    return c && c !== 'rgba(0, 0, 0, 0)' ? c : '#ffffff';
  }

  /** A labeled background picker: fixed choices plus a custom color. */
  #renderBackgroundPicker(label: string, title: string, value: string, choices: [string, string][], set: (v: string) => void) {
    const fixed = choices.some(([v]) => v === value);
    return html`
      <label class="export-bg" title=${title}>
        ${label}
        <select
          .value=${fixed ? value : 'custom'}
          @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            set(v === 'custom' ? (fixed ? '#808080' : value) : v);
          }}
        >
          ${choices.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
          <option value="custom">Custom</option>
        </select>
        ${fixed ? '' : html`<input type="color" .value=${value} @input=${(e: Event) => set((e.target as HTMLInputElement).value)} />`}
      </label>
    `;
  }

  #renderExportBackground() {
    return this.#renderBackgroundPicker(
      'BG',
      'Background outside the image in copies and downloads',
      this.#store.exportBackground.value,
      [
        ['theme', 'Scene'],
        ['#ffffff', 'White'],
        ['transparent', 'Transparent'],
      ],
      (v) => this.#store.exportBackground.set(v)
    );
  }

  #renderSceneBackground() {
    return this.#renderBackgroundPicker(
      'Scene',
      'Background around the page in the editor and slides',
      this.#store.sceneBackground.value,
      [
        ['system', 'System'],
        ['theme', 'Theme'],
        ['#ffffff', 'White'],
        ['#000000', 'Black'],
      ],
      (v) => this.#store.sceneBackground.set(v)
    );
  }

  /**
   * What a copy should be limited to: the selection region, else the box
   * around the selected shapes (with their surroundings), else null for "everything".
   */
  #copyArea(): Rect | null {
    const region = this.#activeRegion();
    if (region) return region;
    const shapes = this.#store.selectedShapes;
    if (!shapes.length) return null;
    const pad = 8;
    const bs = shapes.map((s) => shapeBounds(s));
    const x1 = Math.floor(Math.min(...bs.map((b) => b.x)) - pad);
    const y1 = Math.floor(Math.min(...bs.map((b) => b.y)) - pad);
    const x2 = Math.ceil(Math.max(...bs.map((b) => b.x + b.width)) + pad);
    const y2 = Math.ceil(Math.max(...bs.map((b) => b.y + b.height)) + pad);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // ---------- command palette (Shift Shift) ----------

  /** Everything the Shift-Shift palette offers, for the current state (unavailable commands are left out). */
  #commands(): Command[] {
    const store = this.#store;
    const page = store.activePage;
    const hasImage = page.shapes.length > 0;
    const selected = store.selectedShapes;
    const pages = store.pages.value;
    const cmds: Command[] = [];
    const add = (id: string, label: string, run: () => void, hint?: string, when = true) => {
      if (when) cmds.push({ id, label, run, hint });
    };
    for (const t of TOOLS) add(`tool-${t.type}`, `Tool: ${t.label.replace(/ \(.*\)$/, '')}`, () => this.#setTool(t.type), t.key.toUpperCase());

    add('copy-image', this.#copyArea() ? 'Copy selection as image' : 'Copy image (all pages)', () => void this.#copyImage(), '', hasImage);
    add('copy-page', 'Copy current page as image', () => void this.#copyCurrentPage(), '', hasImage);
    add('copy-md', 'Copy as Markdown', () => void this.#copyAsMarkdown(), '', hasImage);
    add('download', 'Download PNG', () => void this.#download(), '', hasImage);
    add('preview', 'Preview export', () => void this.#openPreview(), '', hasImage);
    add('present', 'Present', () => void this.#present(), '', hasImage);
    add('share', 'Share presentation link', () => void this.#sharePresentation(), '', hasImage);

    add('find', 'Find text in image', () => this.#openSearch(), '⌘F', hasImage);
    add('redact', 'Redact secrets (blur emails, keys, tokens)', () => void this.#redactSecrets(), '', !!this.#mainPicture(page));
    add('snap', store.snapArrows.value ? 'Snap arrows to text and pictures: turn off' : 'Snap arrows to text and pictures: turn on', this.#toggleSnapArrows);
    add(
      'auto-redact',
      store.autoRedact.value ? 'Auto-redact new pictures: turn off' : 'Auto-redact new pictures: turn on',
      () => this.#toggleAutoRedact()
    );
    add('diff', 'Highlight changes vs previous page', () => this.#highlightChangesVsPrevious(), '', !!this.#mainPicture(page) && !!this.#previousImagePage());

    add('fit', 'Fit to window', () => void this.#fitToWindow(), 'F', hasImage);
    add('reset-view', 'Reset view (initial position)', this.#resetView, '', !!page.view);
    add('zoom-in', 'Zoom in', () => this.#zoomBy(1.2), '⌘+');
    add('zoom-out', 'Zoom out', () => this.#zoomBy(1 / 1.2), '⌘−');
    add('zoom-100', 'Zoom to 100%', () => this.#zoomBy(1 / store.zoom.value), '⌘0');

    add('undo', 'Undo', () => store.undo(), '⌘Z');
    add('redo', 'Redo', () => store.redo(), '⇧⌘Z');
    add('select-all', 'Select all shapes', () => store.selectShapes(page.shapes.map((s) => s.id)), '⌘A', page.shapes.length > 0);
    add('duplicate', 'Duplicate selection', () => store.duplicateSelectedShapes(), '⌘D', selected.length > 0);
    add('front', 'Bring to front', () => store.reorderSelectedShapes('front'), '⌘]', selected.length > 0);
    add('back', 'Send to back', () => store.reorderSelectedShapes('back'), '⌘[', selected.length > 0);
    add('delete', 'Delete selection', () => store.deleteSelectedShapes(), '⌫', selected.length > 0);
    add('arrange', 'Arrange pictures in a row', () => void this.#arrangePicturesInRow(), '', selected.some((s) => s.type === 'picture'));
    add('crop', 'Crop to selection', () => void this.#cropRegion(), 'Enter', !!this.#activeRegion());
    add('clear', 'Clear annotations on this page', () => store.clearActivePage(), '', page.shapes.length > 0);

    add('rotate-ccw', 'Rotate left', () => void this.#transformImage('rotate-ccw'), '', hasImage);
    add('rotate-cw', 'Rotate right', () => void this.#transformImage('rotate-cw'), '', hasImage);
    add('flip-h', 'Flip horizontally', () => void this.#transformImage('flip-h'), '', hasImage);
    add('flip-v', 'Flip vertically', () => void this.#transformImage('flip-v'), '', hasImage);

    add('new-page', 'New page', () => this.#addPage(), '');
    add('add-text', 'Add text in the middle of the view', () => this.#startBlankText());
    const labels = this.#textStyleContext();
    add('text-bold', 'Text: bold on/off', () => this.#toggleTextStyle('bold'), '⌘B', labels);
    add('text-italic', 'Text: italic on/off', () => this.#toggleTextStyle('italic'), '⌘I', labels);
    add('text-underline', 'Text: underline on/off', () => this.#toggleTextStyle('underline'), '⌘U', labels);
    add('dup-page', 'Duplicate page', () => this.#duplicatePage(page.id), '⇧⌘D');
    add('next-page', 'Next page', () => this.#gotoAdjacentPage(1), '→', pages.length > 1);
    add('prev-page', 'Previous page', () => this.#gotoAdjacentPage(-1), '←', pages.length > 1);
    add('delete-page', 'Delete page', () => this.#closePageWithConfirm(page.id), '');
    add('reveal', page.reveal ? 'Stop revealing tags one at a time' : 'Reveal tags & steps one at a time', () =>
      store.updatePageMeta(page.id, { reveal: !page.reveal }), '', hasImage);
    add('notes', this.#notesOpen ? 'Hide speaker notes' : 'Show speaker notes', () => {
      this.#notesOpen = !this.#notesOpen;
      this.requestUpdate();
    });
    add('strip', this.#stripCollapsed ? 'Show page thumbnails' : 'Collapse pages to tabs', () => this.#setStripCollapsed(!this.#stripCollapsed));

    add('open-image', 'Open image file…', () => this.#imageInputRef.value?.click());
    add('video-frames', 'Extract frames from a video (MP4, MOV)…', this.#pickVideo);
    add('save-file', 'Save document (to its file, or choose one)', () => this.#saveDocument(), '⌘S');
    add('save-file-as', 'Save document to a new file…', () => void this.#saveAsFile(), '⇧⌘S');
    add('load-file', 'Open document file…', () => void this.#openFile(), '⌘O');
    add('drafts', 'Drafts (documents kept in this browser)…', this.#openDraftsDialog, '');
    add('cloud-save', 'Save to folderfoo', () => void this.#saveToCloud(), '');
    add('cloud-save-as', 'Save to folderfoo as…', () => void this.#saveToCloud(true), '');
    add('cloud-open', 'Open from folderfoo…', () => void showFilePicker().catch((err: Error) => this.#flashStatus(`folderfoo unavailable: ${err.message}`)), '');
    add('new-doc', 'New document', () => this.#newDocument(), '');

    add('theme', 'Change color theme', () => this.#cycleTheme(), '');
    for (const [v, l] of [['system', 'System'], ['theme', 'Theme'], ['#ffffff', 'White'], ['#000000', 'Black']] as const) {
      add(`scene-${v}`, `Scene background: ${l}`, () => store.sceneBackground.set(v), '', store.sceneBackground.value !== v);
    }
    for (const [v, l] of [['theme', 'Scene'], ['#ffffff', 'White'], ['transparent', 'Transparent']] as const) {
      add(`export-${v}`, `Export background: ${l}`, () => store.exportBackground.set(v), '', store.exportBackground.value !== v);
    }
    return cmds;
  }

  #copyImage = async () => {
    // With a selection, the copy buttons copy only what is selected.
    if (this.#copyArea()) return this.#copyRegion();
    try {
      await copyImageOnly(this.#pagesWithImages(), this.#exportBackground());
      this.#flashStatus('Image copied to clipboard');
    } catch (err) {
      this.#flashStatus(`Copy failed: ${(err as Error).message}`);
    }
  };

  #copyCurrentPage = async () => {
    if (this.#copyArea()) return this.#copyRegion();
    try {
      await copyImageOnly([this.#store.activePage], this.#exportBackground());
      this.#flashStatus('Current page copied to clipboard');
    } catch (err) {
      this.#flashStatus(`Copy failed: ${(err as Error).message}`);
    }
  };

  #download = async () => {
    await downloadImage(this.#pagesWithImages(), this.#exportBackground());
  };

  #openPreview = async () => {
    try {
      const canvas = await flattenPagesToCanvas(this.#pagesWithImages(), this.#exportBackground());
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

  /** Starts a blank document. Nothing is lost: the current one stays in Drafts. */
  #newDocument = () => {
    this.#commitTextEdit();
    this.#rememberView();
    this.#store.newDocument();
    this.#setCloudName(null);
    this.#setLocalFile(null);
    void this.#afterDocumentSwitch();
    this.#flashStatus('New document — the previous one is in Drafts');
  };

  async #switchPage(id: string): Promise<void> {
    this.#commitTextEdit();
    if (id === this.#store.activePageId.value) return;
    this.#rememberView();
    this.#store.setActivePage(id);
    await this.updateComplete;
    await this.#redraw();
    await this.#restoreView();
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
    this.#rememberView();
    this.#store.duplicatePage(id);
    this.#flashStatus('Page duplicated');
  }

  #addPage(): void {
    this.#commitTextEdit();
    this.#rememberView();
    this.#store.addPage();
    void this.updateComplete.then(() => this.#restoreView());
  }

  /** Pages have no stored name — tabs are always labeled by current position, so reordering/closing/adding can never produce out-of-sequence numbers. */
  #pageLabel(index: number): string {
    return `Page ${index + 1}`;
  }

  /** Confirms (if the page has content) then closes it. Shared by the tab's × button and the Delete-key-on-selected-image shortcut. */
  #closePageWithConfirm(id: string): void {
    const index = this.#store.pages.value.findIndex((p) => p.id === id);
    const target = this.#store.pages.value[index];
    const hasContent = target && (target.shapes.length > 0);
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
    // Sidebar tiles stack vertically; collapsed title-bar tabs sit side by side.
    if (el.classList.contains('tab')) return e.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
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
    // A pan alone only moves the canvas, unless the view has left what it covers.
    const camOnly = this.#camOnlyUpdate;
    this.#camOnlyUpdate = false;
    if (!camOnly || !this.#viewCovered()) void this.#redraw();
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
    const { w, h } = this.#viewSize();
    const left = w / 2 + (this.#area.x - this.#cam.x) * scale;
    const top = h / 2 + (this.#area.y - this.#cam.y) * scale;
    return `width:${canvas.width * scale}px; height:${canvas.height * scale}px; left:${left}px; top:${top}px;`;
  }

  #canvasCursorCss(): string {
    if (this.#spaceHeld) return this.#pan ? 'grabbing' : 'grab';
    return this.#canvasCursor || (this.#store.activeTool.value === 'select' ? 'default' : 'crosshair');
  }

  render() {
    const page = this.#store.activePage;
    const style = this.#currentStyle();
    const hasShapes = this.#store.selectedIds.length > 0;
    const noImage = !page.shapes.length;
    // Switching pages with the find bar open searches the new page.
    if (this.#search?.query && this.#search.pageId !== page.id) queueMicrotask(() => void this.#runSearch());

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
        ${publicToken ? '' : this.#renderMcpButton()}
        ${this.#stripCollapsed ? this.#renderPageTabs(page.id) : ''}
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
          : this.#localFile
            ? html`
                <span class="cloud-name" title=${this.#localFile.handle ? 'Saved to this file on your computer' : 'Opened from this file'}>🖫 ${this.#localFile.name}</span>
                ${this.#localFile.handle ? html`<span class="save-state ${this.#fileState}">${this.#fileStateLabel()}</span>` : ''}
              `
            : this.#store.hasContent()
              ? html`<span class="cloud-name local-draft" title="Kept in this browser as you edit (🗂 Drafts). Save to a file or folderfoo to keep it elsewhere.">Draft saved in this browser</span>`
              : ''}
      </div>

      <div class="toolbar ${this.#toolbarCollapsed ? 'collapsed' : ''}">
        <button
          class="toolbar-toggle"
          title=${this.#toolbarCollapsed ? 'Show the full toolbar' : 'Minimize the toolbar'}
          @click=${() => this.#setToolbarCollapsed(!this.#toolbarCollapsed)}
        >
          ${this.#toolbarCollapsed ? '▾' : '▴'}
        </button>
        ${this.#renderPageNav(page.id)}
        ${this.#toolbarCollapsed ? this.#renderCompactToolbar(noImage) : html`
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
        ${this.#textStyleContext() ? this.#renderTextStyleControls(style.textStyle) : ''}
        <button
          class=${this.#store.snapArrows.value ? 'active' : ''}
          title="Snap arrow and line ends to text and pictures, so they follow when those move"
          @click=${this.#toggleSnapArrows}
        >
          🧲 Snap
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
          <button @click=${() => this.#zoomBy(1 / 1.2)} title="Zoom out (Cmd/Ctrl+-, Cmd/Ctrl+scroll, pinch)">−</button>
          <span class="zoom-level" @dblclick=${() => this.#zoomBy(1 / this.#store.zoom.value)} title="Double-click for 100%">
            ${Math.round(this.#store.zoom.value * 100)}%
          </span>
          <button @click=${() => this.#zoomBy(1.2)} title="Zoom in (Cmd/Ctrl+=, Cmd/Ctrl+scroll, pinch)">+</button>
          <button @click=${() => this.#fitToWindow()} title="Fit to window (F)">Fit</button>
          ${this.#renderSceneBackground()}
          <button
            ?disabled=${!page.view}
            @click=${this.#resetView}
            title="Back to the initial position: forget this page's panned/zoomed view (slides center on the images again)"
          >
            ⌖ Reset view
          </button>
        </div>
        <button @click=${() => this.#store.undo()} title="Undo (Cmd/Ctrl+Z)">↶ Undo</button>
        <button @click=${() => this.#store.redo()} title="Redo (Shift+Cmd/Ctrl+Z)">↷ Redo</button>
        <button @click=${() => this.#store.clearActivePage()}>Clear</button>
        <div class="group">
          <button @click=${this.#newDocument} title="Start a blank document (the current one stays in Drafts)">＋ New</button>
          <button @click=${this.#openDraftsDialog} title="Documents kept in this browser: reopen or delete">🗂 Drafts</button>
          <button @click=${this.#openFile} title="Open a document file from this computer (Cmd/Ctrl+O)">📂 Open file…</button>
          <button
            @click=${this.#saveDocument}
            title=${this.#cloudName
              ? `Save to folderfoo as "${this.#cloudName}" (Cmd/Ctrl+S)`
              : this.#localFile?.handle
                ? `Save to ${this.#localFile.name} (Cmd/Ctrl+S)`
                : 'Save the document to a file on this computer (Cmd/Ctrl+S)'}
          >
            💾 Save
          </button>
          <button @click=${this.#saveAsFile} title="Save to a new file on this computer (Shift+Cmd/Ctrl+S)">Save as…</button>
        </div>
        <label style="display:inline-flex; align-items:center; cursor:pointer; border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:13px;">
          <input ${ref(this.#imageInputRef)} type="file" accept="image/*" style="display:none" @change=${this.#onFilePick} />
          Open image…
        </label>
        <button @click=${this.#pickVideo} title="Open a video (MP4, MOV…) and pick frames to add as pages">🎞 Video frames…</button>
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
        <button ?disabled=${noImage} @click=${this.#copyAsMarkdown} title="Copy titles, steps and tags as Markdown; rich paste (Docs, Notion…) also gets the images">Copy as Markdown</button>
        <button ?disabled=${noImage} @click=${this.#download}>Download</button>
        ${this.#renderExportBackground()}
              `}
      </div>

      <div class="workspace">
      ${this.#renderPageStrip(page.id)}
      <div class="main">
      ${this.#renderSearchBar()}
      <div
        class="stage"
        style="background:${this.#sceneCss()}"
        ${ref(this.#stageRef)}
        @pointerdown=${this.#onStagePointerDown}
        @pointermove=${this.#onStagePointerMove}
        @pointerup=${this.#onStagePointerUp}
        @wheel=${this.#onWheel}
      >
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
        ${page.shapes.length || this.#textEdit || this.#drawing ? '' : this.#renderEmpty()}
      </div>
      ${this.#renderSlidePanel(page)}
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
      ${this.#renderDraftsDialog()}
      ${this.#video
        ? html`<screen-marker-video
            .file=${this.#video.file}
            .added=${this.#video.added}
            @frames=${this.#onVideoFrames}
            @close=${this.#closeVideo}
          ></screen-marker-video>`
        : ''}
      <screen-marker-palette .commands=${this.#commands()}></screen-marker-palette>
      ${this.#presenting
        ? html`
            <screen-marker-presenter
              .slides=${this.#presenting.slides}
              .index=${this.#presenting.index}
              .zoom=${this.#presenting.zoom ?? null}
              ?public-view=${this.#presenting.publicView}
              heading=${this.#presenting.heading}
              message=${this.#presenting.message}
              @presenter-close=${this.#closePresenter}
              @presenter-edit-copy=${this.#editPublicCopy}
              @presenter-copy-link=${this.#sharePresentation}
              status=${this.#statusMsg}
              background=${this.#sceneColor()}
            ></screen-marker-presenter>
          `
        : ''}
    `;
  }
}

customElements.define('screen-marker', ScreenMarker);
