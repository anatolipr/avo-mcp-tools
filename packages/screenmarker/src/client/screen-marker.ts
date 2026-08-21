import { LitElement, html, css } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import { Signal, SignalWatcher } from 'avosignals';
import { AnnotatorStore } from './store.js';
import { drawShapes, drawShape, drawSelectionOutline, drawImageSelectionOutline, hitTestShapes, flattenPagesToCanvas } from './render.js';
import { copyImageOnly, downloadImage } from './export.js';
import { downloadDocument, readDocumentFile } from './save-load.js';
import { parseContainer, promptForFileName, serializeContainer } from './container.js';
import { getCurrentCloudUser, loadFromCloud, saveToCloud } from './cloud-sync.js';
import { FOLDERFOO_HOST, TENANT_ID } from './server-config.js';
import { HOSTED } from './hosted.js';
import type { Page, Point, Shape, Tool } from './types.js';

const TOOLS: { type: Tool; label: string; icon: string; key: string }[] = [
  { type: 'select', label: 'Select', icon: '↖', key: 'v' },
  { type: 'rect', label: 'Rectangle', icon: '▭', key: 'r' },
  { type: 'arrow', label: 'Arrow', icon: '↗', key: 'a' },
  { type: 'text', label: 'Text', icon: 'T', key: 't' },
  { type: 'pen', label: 'Pen', icon: '✎', key: 'p' },
  { type: 'highlight', label: 'Highlight', icon: '▮', key: 'h' },
];

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#007aff', '#000000', '#ffffff'];
const LINE_WIDTHS = [1, 2, 3, 5, 8, 12];
const FONT_SIZES = [12, 14, 18, 24, 32, 48, 64];

// Below this drag distance (in canvas pixels), a pointerdown→pointerup with a
// draw tool active is treated as a click-to-select rather than a real drag —
// a shape that small would be a useless zero-size artifact anyway.
const CLICK_THRESHOLD = 3;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
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

export class ScreenMarker extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .theme-toggle {
      position: fixed;
      top: 10px;
      right: 12px;
      z-index: 10;
      width: 28px;
      height: 28px;
      border: 1px solid var(--border);
      border-radius: 50%;
      background: var(--panel);
      color: inherit;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.75;
    }
    .theme-toggle:hover {
      opacity: 1;
    }
    .tabs {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 8px 0;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      user-select: none;
    }
    .tab {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px 8px 14px;
      border-radius: 8px 8px 0 0;
      cursor: pointer;
      font-size: 13px;
      border: 1px solid transparent;
      user-select: none;
    }
    /* Vertical bar at the tab's edge showing exactly where a dragged page
       will be inserted — left edge = before this tab, right edge = after it. */
    .tab.drag-over-before::before,
    .tab.drag-over-after::after {
      content: '';
      position: absolute;
      top: -2px;
      bottom: -2px;
      width: 3px;
      background: var(--accent);
      border-radius: 2px;
    }
    .tab.drag-over-before::before {
      left: -2px;
    }
    .tab.drag-over-after::after {
      right: -2px;
    }
    .tab.just-moved {
      animation: tab-flash 1.5s ease-out;
    }
    @keyframes tab-flash {
      0% {
        background: #ffd60a;
      }
      100% {
        background: transparent;
      }
    }
    .tab-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 4px;
      font-size: 13px;
      line-height: 1;
      opacity: 0.5;
    }
    .tab-close:hover {
      opacity: 1;
      background: rgba(128, 128, 128, 0.25);
    }
    .tab.active {
      background: var(--bg);
      border-color: var(--border);
      border-bottom-color: var(--bg);
      margin-bottom: -1px;
    }
    .tab-add {
      padding: 6px 10px;
      cursor: pointer;
      font-size: 16px;
      opacity: 0.6;
    }
    .tab-add:hover {
      opacity: 1;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
      user-select: none;
    }
    button,
    select {
      font: inherit;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
    }
    button.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    button.button-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    button.button-primary:hover:not(:disabled) {
      filter: brightness(1.1);
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .swatch {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 2px solid transparent;
      box-shadow: inset 0 0 0 1px var(--border);
      cursor: pointer;
      padding: 0;
    }
    .swatch.active {
      border-color: var(--text);
    }
    .spacer {
      flex: 1;
    }
    .stage {
      flex: 1;
      display: flex;
      overflow: auto;
      padding: 16px;
    }
    .canvas-wrap {
      position: relative;
      margin: auto;
      box-shadow: 0 2px 16px rgba(0, 0, 0, 0.15);
      background: var(--panel);
      flex: none;
      overflow: hidden;
    }
    canvas {
      display: block;
      transform-origin: 0 0;
    }
    .zoom-controls {
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .zoom-level {
      font-size: 12px;
      opacity: 0.7;
      min-width: 42px;
      text-align: center;
    }
    .empty {
      color: var(--text);
      opacity: 0.6;
      text-align: center;
      font-size: 14px;
      max-width: 320px;
      line-height: 1.6;
    }
    .status {
      padding: 4px 14px 8px;
      font-size: 12px;
      opacity: 0.6;
    }
    .preview-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: grid;
      place-items: center;
      padding: 32px;
      z-index: 100;
    }
    .preview-card {
      background: var(--panel);
      border-radius: 10px;
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);
      max-width: 90vw;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .preview-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .preview-header-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .preview-header button {
      padding: 2px 8px;
    }
    .preview-body {
      flex: 1;
      overflow: auto;
      padding: 16px;
      display: flex;
    }
    .preview-img-wrap {
      position: relative;
      margin: auto;
      flex: none;
      overflow: hidden;
    }
    .preview-img-wrap img {
      display: block;
      transform-origin: 0 0;
    }
  `;

  #store = new AnnotatorStore();
  #canvasRef = createRef<HTMLCanvasElement>();
  #loadDocumentInputRef = createRef<HTMLInputElement>();
  #drawing = false;
  #currentPoints: Point[] = [];
  #dragStart: Point | null = null;
  #movingShapeId: string | null = null;
  #moveDelta: Point = { x: 0, y: 0 };
  #statusMsg = '';
  #previewUrl: string | null = null;
  #previewSize: { width: number; height: number } | null = null;
  #draggingPageId: string | null = null;
  #dragOverPageId: string | null = null;
  #dragOverSide: 'before' | 'after' | null = null;
  #justMovedPageId: string | null = null;
  #theme: ThemeMode = loadTheme();
  #cloudUsername = new Signal<string | null>(null);
  #onAuthChange = () => {
    getCurrentCloudUser().then((user) => this.#cloudUsername.set(user?.username ?? null));
  };

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
    this.addEventListener('dragover', this.#onDragOver);
    this.addEventListener('drop', this.#onDrop);
    this.#store.restore().then(() => {
      this.requestUpdate();
      this.updateComplete.then(() => this.#redraw());
    });

    if (HOSTED) {
      import(/* @vite-ignore */ `${FOLDERFOO_HOST}/elements/folderfoo-profile-circle.js`).then(() => {
        const el = document.createElement('folderfoo-profile-circle');
        el.setAttribute('app-name', 'Screenmarker');
        el.setAttribute('tenant-id', TENANT_ID);
        document.body.appendChild(el);
      });
      window.addEventListener('folderfoo-auth-change', this.#onAuthChange);
      document.addEventListener('folderfoo-file-open', this.#onCloudFileOpen);
      this.#onAuthChange();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('paste', this.#onPaste);
    window.removeEventListener('keydown', this.#onKeydown);
    if (HOSTED) {
      window.removeEventListener('folderfoo-auth-change', this.#onAuthChange);
      document.removeEventListener('folderfoo-file-open', this.#onCloudFileOpen);
    }
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

  #onKeydown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

    if (e.key === 'Escape' && this.#previewUrl) {
      e.preventDefault();
      this.#closePreview();
      return;
    }

    if (e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const interactive = target && (typing || target.tagName === 'BUTTON' || target.tagName === 'SELECT');
      if (interactive) return;
      e.preventDefault();
      if (this.#previewUrl) this.#closePreview();
      else if (this.#store.activePage.imageDataUrl) this.#openPreview();
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey) {
      if (typing) return;
      const sel = this.#store.selection.value;
      if (sel?.type === 'shape') {
        e.preventDefault();
        this.#store.deleteSelectedShape();
        this.#redraw();
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

    if (!e.metaKey && !e.ctrlKey && !e.altKey && !typing) {
      const tool = TOOLS.find((t) => t.key === e.key.toLowerCase());
      if (tool) {
        e.preventDefault();
        this.#store.activeTool.set(tool.type);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.#gotoAdjacentPage(-1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.#gotoAdjacentPage(1);
        return;
      }
      if (e.key === ',') {
        e.preventDefault();
        const moved = this.#store.moveActivePage(-1);
        if (moved) this.#flashMovedTab(this.#store.activePageId.value);
        return;
      }
      if (e.key === '.') {
        e.preventDefault();
        const moved = this.#store.moveActivePage(1);
        if (moved) this.#flashMovedTab(this.#store.activePageId.value);
        return;
      }
      if (e.key === '[') {
        e.preventDefault();
        if (this.#styleContextIsText()) this.#adjustFontSize(-2);
        else this.#adjustLineWidth(-1);
        return;
      }
      if (e.key === ']') {
        e.preventDefault();
        if (this.#styleContextIsText()) this.#adjustFontSize(2);
        else this.#adjustLineWidth(1);
        return;
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.#store.zoomIn();
        return;
      }
      if (e.key === '-') {
        e.preventDefault();
        this.#store.zoomOut();
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        this.#store.zoomReset();
        return;
      }
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key.toLowerCase() === 'z' && e.shiftKey) {
      e.preventDefault();
      this.#store.redo();
      this.#redraw();
    } else if (e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.#store.undo();
      this.#redraw();
    } else if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      this.#store.zoomIn();
    } else if (e.key === '-') {
      e.preventDefault();
      this.#store.zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      this.#store.zoomReset();
    } else if (e.key.toLowerCase() === 'c' && !typing) {
      e.preventDefault();
      const sel = this.#store.selection.value;
      if (sel?.type === 'shape') {
        // In-app clipboard copy — pastes back as a new, still-editable shape.
        this.#store.copySelection();
        this.#flashStatus('Shape copied');
      } else if (sel?.type === 'image') {
        // The image is selected: copy the page to the OS clipboard AND the
        // in-app clipboard, so Cmd+V can still duplicate it onto another page.
        this.#store.copySelection();
        void this.#copyCurrentPage();
      } else if (this.#store.activePage.imageDataUrl) {
        // Nothing selected: copy the whole scene (all pages) to the OS clipboard.
        void this.#copyImage();
      }
    } else if (e.key.toLowerCase() === 'v' && this.#store.hasClipboard()) {
      e.preventDefault();
      this.#store.paste();
      this.updateComplete.then(() => this.#redraw());
    } else if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.#saveDocument();
    } else if (e.key.toLowerCase() === 'o') {
      e.preventDefault();
      this.#loadDocumentInputRef.value?.click();
    }
  };

  async #loadImageFile(file: File): Promise<void> {
    const dataUrl = await fileToDataUrl(file);
    this.#store.setImage(this.#store.activePageId.value, dataUrl);
    this.#store.zoomReset();
    await this.updateComplete;
    this.#redraw();
  }

  #onFilePick = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) await this.#loadImageFile(file);
    input.value = '';
  };

  #saveDocument = async () => {
    const saved = await downloadDocument(this.#store.pages.value, this.#store.activePageId.value);
    if (saved) this.#flashStatus('Document saved');
  };

  #confirmReplaceIfNeeded(): boolean {
    const hasContent =
      this.#store.pages.value.length > 1 ||
      this.#store.pages.value.some((p) => p.imageDataUrl !== null || p.shapes.length > 0);
    return !hasContent || window.confirm('Load this document? It will replace everything currently open. You can Undo (Cmd/Ctrl+Z) afterward.');
  }

  async #applyLoadedDocument(pages: Page[], activePageId: string): Promise<void> {
    this.#store.loadDocument(pages, activePageId);
    this.#store.zoomReset();
    await this.updateComplete;
    this.#redraw();
  }

  #onLoadDocumentPick = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!this.#confirmReplaceIfNeeded()) return;

    try {
      const { pages, activePageId } = await readDocumentFile(file);
      await this.#applyLoadedDocument(pages, activePageId);
      this.#flashStatus('Document loaded');
    } catch (err) {
      this.#flashStatus(`Load failed: ${(err as Error).message}`);
    }
  };

  #saveToCloud = async () => {
    const name = promptForFileName();
    if (name === null) return;
    try {
      const blob = await serializeContainer(this.#store.pages.value, this.#store.activePageId.value);
      await saveToCloud(name, blob);
      this.#flashStatus(`Saved '${name}' to cloud`);
    } catch (err) {
      this.#flashStatus(`Cloud save failed: ${(err as Error).message}`);
    }
  };

  #onCloudFileOpen = async (e: Event) => {
    const name = (e as CustomEvent<{ name: string }>).detail?.name;
    if (!name) return;
    if (!this.#confirmReplaceIfNeeded()) return;

    try {
      const blob = await loadFromCloud(name);
      const { pages, activePageId } = await parseContainer(await blob.arrayBuffer());
      await this.#applyLoadedDocument(pages, activePageId);
      this.#flashStatus(`Loaded '${name}' from cloud`);
    } catch (err) {
      this.#flashStatus(`Cloud load failed: ${(err as Error).message}`);
    }
  };

  async #redraw(): Promise<void> {
    const page = this.#store.activePage;
    const canvas = this.#canvasRef.value;
    if (!canvas || !page.imageDataUrl) return;

    const img = new Image();
    img.src = page.imageDataUrl;
    await img.decode();
    const sizeChanged = canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    drawShapes(ctx, page.shapes);
    const sel = this.#store.selection.value;
    if (sel?.type === 'shape') {
      const selected = page.shapes.find((s) => s.id === sel.id);
      if (selected) drawSelectionOutline(ctx, selected);
    } else if (sel?.type === 'image') {
      drawImageSelectionOutline(ctx, canvas.width, canvas.height);
    }
    // canvas.width/height just changed the wrap's target size (#canvasWrapStyle
    // reads it) — re-render once so the wrap picks up the new box on first load.
    if (sizeChanged) this.requestUpdate();
  }

  #canvasPoint(e: PointerEvent): Point {
    const canvas = this.#canvasRef.value!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  /** A pointerdown directly on the .stage padding (not bubbled from the canvas) means the user clicked outside the image — clear any selection. */
  #onStagePointerDown = (e: PointerEvent) => {
    if (e.target === e.currentTarget && this.#store.selection.value) {
      this.#store.selection.set(null);
      this.#redraw();
    }
  };

  #onPointerDown = (e: PointerEvent) => {
    if (!this.#store.activePage.imageDataUrl) return;
    const tool = this.#store.activeTool.value;
    const pt = this.#canvasPoint(e);

    if (tool === 'select') {
      const hit = hitTestShapes(this.#store.activePage.shapes, pt);
      this.#store.selection.set(hit ? { type: 'shape', id: hit.id } : { type: 'image' });
      if (hit) {
        // Arm a potential drag-to-move; #onPointerUp decides whether it was
        // a real drag (commit the move) or just a click (leave it selected).
        this.#movingShapeId = hit.id;
        this.#dragStart = pt;
        this.#moveDelta = { x: 0, y: 0 };
        (e.target as Element).setPointerCapture(e.pointerId);
      }
      this.#redraw();
      return;
    }

    if (tool === 'text') {
      const label = window.prompt('Annotation text:');
      if (label) {
        this.#store.addShape({
          id: makeId(),
          type: 'text',
          color: this.#store.activeColor.value,
          lineWidth: this.#store.activeLineWidth.value,
          fontSize: this.#store.activeFontSize.value,
          points: [pt],
          label,
        });
        this.#redraw();
      }
      return;
    }

    this.#drawing = true;
    this.#dragStart = pt;
    this.#currentPoints = [pt];
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  #onPointerMove = (e: PointerEvent) => {
    if (this.#movingShapeId && this.#dragStart) {
      const pt = this.#canvasPoint(e);
      this.#moveDelta = { x: pt.x - this.#dragStart.x, y: pt.y - this.#dragStart.y };
      this.#previewMove();
      return;
    }

    if (!this.#drawing) return;
    const tool = this.#store.activeTool.value;
    const pt = this.#canvasPoint(e);

    if (tool === 'pen') {
      this.#currentPoints.push(pt);
    } else {
      this.#currentPoints = [this.#currentPoints[0]!, pt];
    }
    this.#previewDraw();
  };

  #onPointerUp = (e: PointerEvent) => {
    if (this.#movingShapeId) {
      const id = this.#movingShapeId;
      const { x: dx, y: dy } = this.#moveDelta;
      this.#movingShapeId = null;
      this.#dragStart = null;
      this.#moveDelta = { x: 0, y: 0 };
      if (Math.hypot(dx, dy) >= CLICK_THRESHOLD) {
        this.#store.moveShape(id, dx, dy);
      }
      this.#redraw();
      return;
    }

    if (!this.#drawing) return;
    this.#drawing = false;
    const tool = this.#store.activeTool.value;
    const pt = this.#canvasPoint(e);
    const start = this.#dragStart;
    const dragDistance = start ? Math.hypot(pt.x - start.x, pt.y - start.y) : Infinity;

    // #drawing is only ever set true for draw tools (select/text return early
    // in #onPointerDown before reaching setPointerCapture), so tool here is
    // always a real ShapeType — but narrow explicitly rather than casting.
    if (tool !== 'select' && dragDistance < CLICK_THRESHOLD) {
      // A click (no real drag) with a draw tool active would only produce a
      // degenerate zero-size shape — treat it as "select whatever's under
      // the cursor" instead, same as the Select tool would.
      const hit = start ? hitTestShapes(this.#store.activePage.shapes, start) : null;
      this.#store.selection.set(hit ? { type: 'shape', id: hit.id } : { type: 'image' });
    } else if (tool !== 'select' && this.#currentPoints.length >= 2) {
      this.#store.addShape({
        id: makeId(),
        type: tool,
        color: this.#store.activeColor.value,
        lineWidth: this.#store.activeLineWidth.value,
        points: this.#currentPoints,
      });
    }
    this.#currentPoints = [];
    this.#dragStart = null;
    this.#redraw();
  };

  async #previewDraw(): Promise<void> {
    const page = this.#store.activePage;
    const canvas = this.#canvasRef.value;
    const tool = this.#store.activeTool.value;
    if (!canvas || !page.imageDataUrl || tool === 'select') return;
    const img = new Image();
    img.src = page.imageDataUrl;
    await img.decode();
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    drawShapes(ctx, page.shapes);
    const previewShape: Shape = {
      id: 'preview',
      type: tool,
      color: this.#store.activeColor.value,
      lineWidth: this.#store.activeLineWidth.value,
      points: this.#currentPoints,
    };
    drawShape(ctx, previewShape);
  }

  async #previewMove(): Promise<void> {
    const page = this.#store.activePage;
    const canvas = this.#canvasRef.value;
    if (!canvas || !page.imageDataUrl || !this.#movingShapeId) return;
    const img = new Image();
    img.src = page.imageDataUrl;
    await img.decode();
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const { x: dx, y: dy } = this.#moveDelta;
    for (const shape of page.shapes) {
      if (shape.id !== this.#movingShapeId) {
        drawShape(ctx, shape);
        continue;
      }
      const moved: Shape = { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      drawShape(ctx, moved);
      drawSelectionOutline(ctx, moved);
    }
  }

  async #flashStatus(msg: string): Promise<void> {
    this.#statusMsg = msg;
    this.requestUpdate();
    setTimeout(() => {
      this.#statusMsg = '';
      this.requestUpdate();
    }, 2000);
  }

  #pagesWithImages() {
    return this.#store.pages.value.filter((p) => p.imageDataUrl !== null);
  }

  /** The currently-selected shape, if the selection is a shape (not the image, not nothing). */
  #selectedShape(): Shape | null {
    const sel = this.#store.selection.value;
    if (sel?.type !== 'shape') return null;
    return this.#store.activePage.shapes.find((s) => s.id === sel.id) ?? null;
  }

  /**
   * Whether the line-width/font-size controls (toolbar dropdowns and [ / ]
   * shortcuts) should currently act on text (font size) or on stroke width.
   * Selecting a shape overrides the active tool: editing a selected text
   * shape's size shouldn't require switching to the Text tool first.
   */
  #styleContextIsText(): boolean {
    const selected = this.#selectedShape();
    if (selected) return selected.type === 'text';
    return this.#store.activeTool.value === 'text';
  }

  #adjustLineWidth(delta: number): void {
    const selected = this.#selectedShape();
    const current = selected ? selected.lineWidth : this.#store.activeLineWidth.value;
    const next = Math.max(1, Math.min(30, current + delta));
    this.#store.activeLineWidth.set(next);
    if (selected) {
      this.#store.updateShapeStyle(selected.id, { lineWidth: next });
      this.#redraw();
    }
  }

  #adjustFontSize(delta: number): void {
    const selected = this.#selectedShape();
    const current = selected ? (selected.fontSize ?? 18) : this.#store.activeFontSize.value;
    const next = Math.max(8, Math.min(96, current + delta));
    this.#store.activeFontSize.set(next);
    if (selected) {
      this.#store.updateShapeStyle(selected.id, { fontSize: next });
      this.#redraw();
    }
  }

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
    this.updateComplete.then(() => this.#redraw());
  };

  #switchPage(id: string): void {
    this.#store.setActivePage(id);
    this.updateComplete.then(() => this.#redraw());
  }

  #gotoAdjacentPage(direction: -1 | 1): void {
    const pages = this.#store.pages.value;
    if (pages.length < 2) return;
    const currentIndex = pages.findIndex((p) => p.id === this.#store.activePageId.value);
    const nextIndex = (currentIndex + direction + pages.length) % pages.length;
    this.#switchPage(pages[nextIndex]!.id);
  }

  #addPage(): void {
    this.#store.addPage();
    this.updateComplete.then(() => this.#redraw());
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
    this.updateComplete.then(() => this.#redraw());
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
    this.#redraw();
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
    const width = canvas.width * scale;
    const height = canvas.height * scale;
    return `width:${width}px; height:${height}px;`;
  }

  render() {
    const page = this.#store.activePage;

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
              @click=${() => this.#store.activeTool.set(t.type)}
            >
              ${t.icon} ${t.label} (${t.key})
            </button>
          `
        )}
        <div class="spacer" style="width:8px; flex:0"></div>
        <button
          ?disabled=${this.#store.selection.value?.type !== 'shape'}
          @click=${() => {
            this.#store.deleteSelectedShape();
            this.#redraw();
          }}
          title="Delete selected shape (Delete/Backspace)"
        >
          🗑 Delete
        </button>
        <div class="spacer" style="width:8px; flex:0"></div>
        ${COLORS.map((c) => {
          const current = this.#selectedShape()?.color ?? this.#store.activeColor.value;
          return html`
            <button
              class="swatch ${current === c ? 'active' : ''}"
              style="background:${c}"
              title=${c}
              @click=${() => {
                const selected = this.#selectedShape();
                this.#store.activeColor.set(c);
                if (selected) {
                  this.#store.updateShapeStyle(selected.id, { color: c });
                  this.#redraw();
                }
              }}
            ></button>
          `;
        })}
        <div class="spacer" style="width:8px; flex:0"></div>
        ${this.#styleContextIsText()
          ? html`
              <select
                title="Font size ([ / ])"
                @change=${(e: Event) => {
                  const size = Number((e.target as HTMLSelectElement).value);
                  const selected = this.#selectedShape();
                  this.#store.activeFontSize.set(size);
                  if (selected) {
                    this.#store.updateShapeStyle(selected.id, { fontSize: size });
                    this.#redraw();
                  }
                }}
              >
                ${FONT_SIZES.map((s) => {
                  const current = this.#selectedShape()?.fontSize ?? this.#store.activeFontSize.value;
                  return html`<option value=${s} ?selected=${current === s}>${s}px</option>`;
                })}
              </select>
            `
          : html`
              <select
                title="Line thickness ([ / ])"
                @change=${(e: Event) => {
                  const width = Number((e.target as HTMLSelectElement).value);
                  const selected = this.#selectedShape();
                  this.#store.activeLineWidth.set(width);
                  if (selected) {
                    this.#store.updateShapeStyle(selected.id, { lineWidth: width });
                    this.#redraw();
                  }
                }}
              >
                ${LINE_WIDTHS.map((w) => {
                  const current = this.#selectedShape()?.lineWidth ?? this.#store.activeLineWidth.value;
                  return html`<option value=${w} ?selected=${current === w}>${w}px</option>`;
                })}
              </select>
            `}
        <div class="spacer"></div>
        <div class="zoom-controls">
          <button @click=${() => this.#store.zoomOut()} title="Zoom out (Cmd/Ctrl+-)">−</button>
          <span class="zoom-level" @dblclick=${() => this.#store.zoomReset()} title="Double-click to reset">
            ${Math.round(this.#store.zoom.value * 100)}%
          </span>
          <button @click=${() => this.#store.zoomIn()} title="Zoom in (Cmd/Ctrl+=)">+</button>
        </div>
        <button @click=${() => this.#store.undo()} title="Undo (Cmd/Ctrl+Z)">↶ Undo</button>
        <button @click=${() => this.#store.redo()} title="Redo (Shift+Cmd/Ctrl+Z)">↷ Redo</button>
        <button @click=${() => this.#store.clearActivePage()}>Clear</button>
        <button @click=${this.#newDocument} title="Wipe all pages and start fresh">New document</button>
        <button @click=${this.#saveDocument} title="Save the whole document (all pages) to a file (Cmd/Ctrl+S)">Save</button>
        ${HOSTED && this.#cloudUsername.value
          ? html`<button @click=${this.#saveToCloud} title="Save the whole document to your folderfoo account">☁ Save to cloud</button>`
          : ''}
        <label style="display:inline-flex; align-items:center; cursor:pointer; border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:13px;" title="Load a document file, replacing everything currently open (Cmd/Ctrl+O)">
          <input
            ${ref(this.#loadDocumentInputRef)}
            type="file"
            accept=".smk"
            style="display:none"
            @change=${this.#onLoadDocumentPick}
          />
          Load…
        </label>
        <label style="display:inline-flex; align-items:center; cursor:pointer; border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:13px;">
          <input type="file" accept="image/*" style="display:none" @change=${this.#onFilePick} />
          Open image…
        </label>
        <button class="button-primary" ?disabled=${!page.imageDataUrl} @click=${this.#copyImage}>📋 Copy Image</button>
        <button class="button-primary" ?disabled=${!page.imageDataUrl} @click=${this.#copyCurrentPage}>📋 Copy Current Page</button>
        <button ?disabled=${!page.imageDataUrl} @click=${this.#openPreview}>Preview</button>
        <button ?disabled=${!page.imageDataUrl} @click=${this.#download}>Download</button>
      </div>

      <div class="stage" @pointerdown=${this.#onStagePointerDown}>
        ${page.imageDataUrl
          ? html`
              <div
                class="canvas-wrap"
                style=${this.#canvasWrapStyle()}
              >
                <canvas
                  ${ref(this.#canvasRef)}
                  style="transform: scale(${this.#displayScale()})"
                  @pointerdown=${this.#onPointerDown}
                  @pointermove=${this.#onPointerMove}
                  @pointerup=${this.#onPointerUp}
                ></canvas>
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
