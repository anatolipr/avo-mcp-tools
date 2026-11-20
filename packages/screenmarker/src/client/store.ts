import { Signal, effect } from 'avosignals';
import type { Page, Shape, TagArrow, Tool } from './types.js';
import { loadSession, saveSession } from './persistence.js';
import { getTabId } from './tab-identity.js';
import { loadPreferences, savePreferences } from './preferences.js';

export function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Pages no longer carry a meaningful display name — tabs are always labeled
// by current position (see #pageLabel in screen-marker.ts) so reordering,
// closing, and adding pages can never produce out-of-sequence or colliding
// numbers. `name` is kept on the type only so older saved documents still
// parse; new pages get an empty one.
function makePage(): Page {
  return { id: makeId(), name: '', imageDataUrl: null, shapes: [] };
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.2;
const PASTE_OFFSET = 16;

/** One or more shapes (ids in no particular order), the page's background image, or nothing. */
export type Selection = { type: 'shapes'; ids: string[] } | { type: 'image' } | null;
type Clipboard = { type: 'shapes'; shapes: Shape[] } | { type: 'image'; imageDataUrl: string } | null;

export type ShapeStyle = { color?: string; lineWidth?: number; fontSize?: number; fill?: boolean; tagArrow?: TagArrow };

const initialPrefs = loadPreferences();

function offsetShape(shape: Shape, dx: number, dy: number): Shape {
  return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
}

export class AnnotatorStore {
  pages = new Signal<Page[]>([makePage()]);
  activePageId = new Signal<string>(this.pages.value[0]!.id);
  activeTool = new Signal<Tool>('rect');
  // Color/lineWidth/fontSize/fill are seeded from localStorage (see
  // preferences.ts) so the last-used values persist across sessions and
  // are shared by every tab — unlike document content, which is per-tab.
  activeColor = new Signal<string>(initialPrefs.color);
  activeLineWidth = new Signal<number>(initialPrefs.lineWidth);
  activeFontSize = new Signal<number>(initialPrefs.fontSize);
  activeFill = new Signal<boolean>(initialPrefs.fill);
  activeTagArrow = new Signal<TagArrow>('bottom-center');
  zoom = new Signal<number>(1);
  previewZoom = new Signal<number>(1);
  selection = new Signal<Selection>(null);
  #clipboard: Clipboard = null;

  #undoStack: { pages: Page[]; activePageId: string }[] = [];
  #redoStack: { pages: Page[]; activePageId: string }[] = [];
  #restored = false;
  #tabId: string | null = null;

  constructor() {
    effect(() => {
      // Read both signals so the effect re-runs on either change; skip the
      // very first tick until restore() has run (and #tabId is known), so a
      // fresh load doesn't clobber a not-yet-loaded persisted session with
      // the default empty page.
      const pages = this.pages.value;
      const activePageId = this.activePageId.value;
      if (!this.#restored || !this.#tabId) return;
      void saveSession(this.#tabId, { pages, activePageId });
    });

    effect(() => {
      savePreferences({
        color: this.activeColor.value,
        lineWidth: this.activeLineWidth.value,
        fontSize: this.activeFontSize.value,
        fill: this.activeFill.value,
      });
    });
  }

  /**
   * Resolves this tab's isolated document id, then loads any persisted
   * session for it from IndexedDB, replacing current state. Call once on
   * startup — every other page/tab in the browser gets its own document,
   * even a duplicated tab (see tab-identity.ts).
   */
  async restore(): Promise<void> {
    this.#tabId = await getTabId();
    const session = await loadSession(this.#tabId);
    if (session && session.pages.length > 0) {
      this.pages.set(session.pages);
      this.activePageId.set(session.activePageId);
    }
    this.#restored = true;
  }

  get activePage(): Page {
    const id = this.activePageId.value;
    return this.pages.value.find((p) => p.id === id) ?? this.pages.value[0]!;
  }

  /** Ids of the selected shapes that still exist on the active page, in stacking order. */
  get selectedIds(): string[] {
    const sel = this.selection.value;
    if (sel?.type !== 'shapes') return [];
    const ids = new Set(sel.ids);
    return this.activePage.shapes.filter((s) => ids.has(s.id)).map((s) => s.id);
  }

  get selectedShapes(): Shape[] {
    const sel = this.selection.value;
    if (sel?.type !== 'shapes') return [];
    const ids = new Set(sel.ids);
    return this.activePage.shapes.filter((s) => ids.has(s.id));
  }

  selectShapes(ids: string[]): void {
    this.selection.set(ids.length ? { type: 'shapes', ids } : null);
  }

  /** Adds the shape to the selection, or removes it if already selected (Shift+click). */
  toggleShapeSelected(id: string): void {
    const current = this.selectedIds;
    this.selectShapes(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  }

  #snapshot(): void {
    this.#undoStack.push({
      pages: structuredClone(this.pages.value),
      activePageId: this.activePageId.value,
    });
    this.#redoStack = [];
  }

  /** Applies `fn` to the active page's shape list. Undoable. */
  #updateActiveShapes(fn: (shapes: Shape[]) => Shape[]): void {
    this.#snapshot();
    const pageId = this.activePageId.value;
    this.pages.update((pages) => pages.map((p) => (p.id === pageId ? { ...p, shapes: fn(p.shapes) } : p)));
  }

  addPage(): void {
    const page = makePage();
    this.pages.set([...this.pages.value, page]);
    this.activePageId.set(page.id);
  }

  /** Inserts a copy of a page (image and annotations, with fresh ids) right after it and switches to it. Undoable. */
  duplicatePage(id: string): void {
    const pages = this.pages.value;
    const index = pages.findIndex((p) => p.id === id);
    if (index === -1) return;
    this.#snapshot();
    const source = pages[index]!;
    const copy: Page = {
      ...structuredClone(source),
      id: makeId(),
      shapes: source.shapes.map((s) => ({ ...structuredClone(s), id: makeId() })),
    };
    this.pages.set([...pages.slice(0, index + 1), copy, ...pages.slice(index + 1)]);
    this.activePageId.set(copy.id);
    this.selection.set(null);
  }

  /**
   * Moves page `fromId` to sit just before page `beforeId`. Not undoable —
   * purely organizational, not content. Returns whether the order actually
   * changed (false if fromId was already immediately before beforeId, or
   * the ids are invalid/equal) — callers use this to skip UI feedback for
   * a no-op drop.
   */
  reorderPage(fromId: string, beforeId: string): boolean {
    if (fromId === beforeId) return false;
    const pages = this.pages.value;
    const from = pages.find((p) => p.id === fromId);
    if (!from) return false;
    const withoutFrom = pages.filter((p) => p.id !== fromId);
    const targetIndex = withoutFrom.findIndex((p) => p.id === beforeId);
    if (targetIndex === -1) return false;
    withoutFrom.splice(targetIndex, 0, from);
    const changed = withoutFrom.some((p, i) => p.id !== pages[i]?.id);
    if (changed) this.pages.set(withoutFrom);
    return changed;
  }

  /** Moves page `fromId` to the end. Not undoable. Returns whether the order actually changed (false if it was already last). */
  reorderPageToEnd(fromId: string): boolean {
    const pages = this.pages.value;
    const from = pages.find((p) => p.id === fromId);
    if (!from) return false;
    if (pages[pages.length - 1]?.id === fromId) return false;
    this.pages.set([...pages.filter((p) => p.id !== fromId), from]);
    return true;
  }

  setActivePage(id: string): void {
    this.activePageId.set(id);
    this.selection.set(null);
  }

  /** Swaps the active page with its neighbor in the given direction. Not undoable. Returns whether it moved (false at either end). */
  moveActivePage(direction: -1 | 1): boolean {
    const pages = this.pages.value;
    const id = this.activePageId.value;
    const index = pages.findIndex((p) => p.id === id);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= pages.length) return false;
    const next = [...pages];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    this.pages.set(next);
    return true;
  }

  /** Closes one page. If it's the last remaining page, replaces it with a fresh blank page. Undoable. */
  closePage(id: string): void {
    this.#snapshot();
    const closingIndex = this.pages.value.findIndex((p) => p.id === id);
    if (closingIndex === -1) return;

    if (this.pages.value.length === 1) {
      const page = makePage();
      this.pages.set([page]);
      this.activePageId.set(page.id);
      this.selection.set(null);
      return;
    }

    const remaining = this.pages.value.filter((p) => p.id !== id);
    this.pages.set(remaining);
    this.selection.set(null);

    if (this.activePageId.value === id) {
      const fallbackIndex = Math.min(closingIndex, remaining.length - 1);
      this.activePageId.set(remaining[fallbackIndex]!.id);
    }
  }

  /** Updates a page's slide metadata (title / notes / reveal). Not undoable: typing in the slide panel would flood the history. */
  updatePageMeta(pageId: string, meta: Partial<Pick<Page, 'title' | 'notes' | 'reveal'>>): void {
    this.pages.update((pages) => pages.map((p) => (p.id === pageId ? { ...p, ...meta } : p)));
  }

  /** Moves a page one position up/down in the list. Not undoable. Returns whether it moved. */
  movePage(pageId: string, direction: -1 | 1): boolean {
    const pages = this.pages.value;
    const index = pages.findIndex((p) => p.id === pageId);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= pages.length) return false;
    const next = [...pages];
    [next[index], next[target]] = [next[target]!, next[index]!];
    this.pages.set(next);
    return true;
  }

  setImage(pageId: string, dataUrl: string): void {
    this.pages.update((pages) =>
      pages.map((p) => (p.id === pageId ? { ...p, imageDataUrl: dataUrl } : p))
    );
  }

  addShape(shape: Shape): void {
    this.#updateActiveShapes((shapes) => [...shapes, shape]);
  }

  /** Replaces one shape wholesale (resize, text edit). Undoable. */
  replaceShape(shape: Shape): void {
    this.#updateActiveShapes((shapes) => shapes.map((s) => (s.id === shape.id ? shape : s)));
  }

  /** Translates the given shapes by (dx, dy). Undoable as a single step. */
  moveShapes(ids: string[], dx: number, dy: number): void {
    if ((dx === 0 && dy === 0) || ids.length === 0) return;
    const set = new Set(ids);
    this.#updateActiveShapes((shapes) => shapes.map((s) => (set.has(s.id) ? offsetShape(s, dx, dy) : s)));
  }

  /**
   * Restyles the given shapes. Font size only applies to text/step, line
   * width only to the others, and fill only to shapes that support it, so
   * one toolbar change on a mixed selection does the sensible thing for
   * each. Undoable as a single step.
   */
  updateShapesStyle(ids: string[], style: ShapeStyle): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    this.#updateActiveShapes((shapes) =>
      shapes.map((s) => {
        if (!set.has(s.id)) return s;
        const next: Shape = { ...s };
        if (style.color !== undefined) next.color = style.color;
        const sized = s.type === 'text' || s.type === 'step' || s.type === 'tag';
        if (style.fontSize !== undefined && sized) next.fontSize = style.fontSize;
        if (style.lineWidth !== undefined && !sized) next.lineWidth = style.lineWidth;
        if (style.fill !== undefined && (s.type === 'rect' || s.type === 'ellipse' || s.type === 'text')) {
          next.fill = style.fill;
        }
        if (style.tagArrow !== undefined && s.type === 'tag') next.tagArrow = style.tagArrow;
        return next;
      })
    );
  }

  deleteShapes(ids: string[]): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    this.#updateActiveShapes((shapes) => shapes.filter((s) => !set.has(s.id)));
    const remaining = this.selectedIds.filter((id) => !set.has(id));
    if (this.selection.value?.type === 'shapes') this.selectShapes(remaining);
  }

  deleteSelectedShapes(): void {
    this.deleteShapes(this.selectedIds);
  }

  /** Copies the selected shapes in place, offset slightly, and selects the copies. Undoable. */
  duplicateSelectedShapes(): void {
    const selected = this.selectedShapes;
    if (selected.length === 0) return;
    const copies = selected.map((s) => ({ ...offsetShape(structuredClone(s), PASTE_OFFSET, PASTE_OFFSET), id: makeId() }));
    this.#updateActiveShapes((shapes) => [...shapes, ...copies]);
    this.selectShapes(copies.map((c) => c.id));
  }

  /** Moves the selected shapes to the top (drawn last) or bottom of the stack, keeping their relative order. Undoable. */
  reorderSelectedShapes(where: 'front' | 'back'): void {
    const set = new Set(this.selectedIds);
    if (set.size === 0) return;
    this.#updateActiveShapes((shapes) => {
      const picked = shapes.filter((s) => set.has(s.id));
      const rest = shapes.filter((s) => !set.has(s.id));
      return where === 'front' ? [...rest, ...picked] : [...picked, ...rest];
    });
  }

  /** A number the user typed for the next step marker (e.g. to continue from a previous slide); used once. */
  nextStepOverride = new Signal<number | null>(null);

  /** The number the next step marker will show: the override if set, else one past the highest on the page. */
  peekNextStepNumber(): number {
    const override = this.nextStepOverride.value;
    if (override !== null) return override;
    const steps = this.activePage.shapes.filter((s) => s.type === 'step').map((s) => s.stepNumber ?? 0);
    return steps.length ? Math.max(...steps) + 1 : 1;
  }

  /** Like peekNextStepNumber, but consumes the override so later markers count up from the page again. */
  takeNextStepNumber(): number {
    const n = this.peekNextStepNumber();
    this.nextStepOverride.set(null);
    return n;
  }

  /**
   * Replaces the active page's image and shapes in one undoable step — used
   * by crop, rotate, and flip, which change both together.
   */
  replaceActivePageContent(imageDataUrl: string, shapes: Shape[]): void {
    this.#snapshot();
    const pageId = this.activePageId.value;
    this.pages.update((pages) => pages.map((p) => (p.id === pageId ? { ...p, imageDataUrl, shapes } : p)));
    this.selection.set(null);
  }

  /**
   * Replaces the active page's image with an already-cropped one and shifts
   * every shape by (-dx, -dy) so annotations stay put relative to the image
   * content. Shapes left fully outside the new bounds are kept (they just
   * won't render) so Undo is the only thing that ever drops content. Undoable.
   */
  cropActivePage(imageDataUrl: string, dx: number, dy: number): void {
    this.replaceActivePageContent(
      imageDataUrl,
      this.activePage.shapes.map((s) => offsetShape(s, -dx, -dy))
    );
  }

  /** Replaces the whole document (all pages) with loaded content. Undoable. */
  loadDocument(pages: Page[], activePageId: string): void {
    this.#snapshot();
    this.pages.set(pages);
    this.activePageId.set(activePageId || pages[0]?.id || '');
    this.selection.set(null);
  }

  /** Wipes all pages back to a single blank page. Undoable. */
  newDocument(): void {
    this.#snapshot();
    const page = makePage();
    this.pages.set([page]);
    this.activePageId.set(page.id);
    this.selection.set(null);
  }

  clearActivePage(): void {
    this.#updateActiveShapes(() => []);
    this.selection.set(null);
  }

  undo(): void {
    const prev = this.#undoStack.pop();
    if (!prev) return;
    this.#redoStack.push({
      pages: structuredClone(this.pages.value),
      activePageId: this.activePageId.value,
    });
    this.pages.set(prev.pages);
    this.activePageId.set(prev.activePageId);
    this.selection.set(null);
  }

  redo(): void {
    const next = this.#redoStack.pop();
    if (!next) return;
    this.#undoStack.push({
      pages: structuredClone(this.pages.value),
      activePageId: this.activePageId.value,
    });
    this.pages.set(next.pages);
    this.activePageId.set(next.activePageId);
    this.selection.set(null);
  }

  hasClipboard(): boolean {
    return this.#clipboard !== null;
  }

  /** Copies the current selection (shapes, or just the active page's background image — no annotations) into the in-app clipboard. No-op if nothing selected. */
  copySelection(): void {
    const sel = this.selection.value;
    if (!sel) return;

    if (sel.type === 'shapes') {
      const shapes = this.selectedShapes;
      if (shapes.length) this.#clipboard = { type: 'shapes', shapes: structuredClone(shapes) };
    } else if (this.activePage.imageDataUrl) {
      this.#clipboard = { type: 'image', imageDataUrl: this.activePage.imageDataUrl };
    }
  }

  /**
   * Pastes whatever's in the in-app clipboard onto the active page — pasting
   * never creates a new page. Copied shapes are added (offset slightly,
   * selected). A copied image replaces just the active page's background
   * image — its own shapes are left untouched, and none of the source
   * page's annotations come along. No-op if the clipboard is empty.
   */
  paste(): void {
    if (!this.#clipboard) return;

    if (this.#clipboard.type === 'shapes') {
      const pasted = this.#clipboard.shapes.map((s) => ({
        ...offsetShape(structuredClone(s), PASTE_OFFSET, PASTE_OFFSET),
        id: makeId(),
      }));
      this.#updateActiveShapes((shapes) => [...shapes, ...pasted]);
      this.selectShapes(pasted.map((p) => p.id));
    } else {
      this.#snapshot();
      const pageId = this.activePageId.value;
      const imageDataUrl = this.#clipboard.imageDataUrl;
      this.pages.update((pages) => pages.map((p) => (p.id === pageId ? { ...p, imageDataUrl } : p)));
      this.selection.set({ type: 'image' });
    }
  }

  setZoom(z: number): void {
    this.zoom.set(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
  }

  zoomIn(): void {
    this.setZoom(this.zoom.value * ZOOM_STEP);
  }

  zoomOut(): void {
    this.setZoom(this.zoom.value / ZOOM_STEP);
  }

  zoomReset(): void {
    this.zoom.set(1);
  }

  previewZoomIn(): void {
    this.previewZoom.set(Math.min(ZOOM_MAX, this.previewZoom.value * ZOOM_STEP));
  }

  previewZoomOut(): void {
    this.previewZoom.set(Math.max(ZOOM_MIN, this.previewZoom.value / ZOOM_STEP));
  }

  previewZoomReset(): void {
    this.previewZoom.set(1);
  }
}
