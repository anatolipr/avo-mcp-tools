import { Signal, effect } from 'avosignals';
import type { Page, Shape, Tool } from './types.js';
import { loadSession, saveSession } from './persistence.js';
import { getTabId } from './tab-identity.js';
import { loadPreferences, savePreferences } from './preferences.js';

function makeId(): string {
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

export type Selection = { type: 'shape'; id: string } | { type: 'image' } | null;
type Clipboard = { type: 'shape'; shape: Shape } | { type: 'image'; imageDataUrl: string } | null;

const initialPrefs = loadPreferences();

export class AnnotatorStore {
  pages = new Signal<Page[]>([makePage()]);
  activePageId = new Signal<string>(this.pages.value[0]!.id);
  activeTool = new Signal<Tool>('rect');
  // Color/lineWidth/fontSize are seeded from localStorage (see
  // preferences.ts) so the last-used values persist across sessions and
  // are shared by every tab — unlike document content, which is per-tab.
  activeColor = new Signal<string>(initialPrefs.color);
  activeLineWidth = new Signal<number>(initialPrefs.lineWidth);
  activeFontSize = new Signal<number>(initialPrefs.fontSize);
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

  #snapshot(): void {
    this.#undoStack.push({
      pages: structuredClone(this.pages.value),
      activePageId: this.activePageId.value,
    });
    this.#redoStack = [];
  }

  addPage(): void {
    const page = makePage();
    this.pages.set([...this.pages.value, page]);
    this.activePageId.set(page.id);
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

  setImage(pageId: string, dataUrl: string): void {
    this.pages.update((pages) =>
      pages.map((p) => (p.id === pageId ? { ...p, imageDataUrl: dataUrl } : p))
    );
  }

  addShape(shape: Shape): void {
    this.#snapshot();
    const id = this.activePageId.value;
    this.pages.update((pages) =>
      pages.map((p) => (p.id === id ? { ...p, shapes: [...p.shapes, shape] } : p))
    );
  }

  /** Translates a shape by (dx, dy). Undoable as a single step. */
  moveShape(id: string, dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.#snapshot();
    const pageId = this.activePageId.value;
    this.pages.update((pages) =>
      pages.map((p) =>
        p.id === pageId
          ? {
              ...p,
              shapes: p.shapes.map((s) =>
                s.id === id ? { ...s, points: s.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) } : s
              ),
            }
          : p
      )
    );
  }

  /** Updates a shape's color, lineWidth, and/or fontSize in place. Undoable as a single step. */
  updateShapeStyle(id: string, style: { color?: string; lineWidth?: number; fontSize?: number }): void {
    this.#snapshot();
    const pageId = this.activePageId.value;
    this.pages.update((pages) =>
      pages.map((p) =>
        p.id === pageId ? { ...p, shapes: p.shapes.map((s) => (s.id === id ? { ...s, ...style } : s)) } : p
      )
    );
  }

  deleteShape(id: string): void {
    this.#snapshot();
    const pageId = this.activePageId.value;
    this.pages.update((pages) =>
      pages.map((p) => (p.id === pageId ? { ...p, shapes: p.shapes.filter((s) => s.id !== id) } : p))
    );
    const sel = this.selection.value;
    if (sel && sel.type === 'shape' && sel.id === id) this.selection.set(null);
  }

  deleteSelectedShape(): void {
    const sel = this.selection.value;
    if (sel && sel.type === 'shape') this.deleteShape(sel.id);
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
    this.#snapshot();
    const id = this.activePageId.value;
    this.pages.update((pages) =>
      pages.map((p) => (p.id === id ? { ...p, shapes: [] } : p))
    );
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

  /** Copies the current selection (a shape, or just the active page's background image — no annotations) into the in-app clipboard. No-op if nothing selected. */
  copySelection(): void {
    const sel = this.selection.value;
    if (!sel) return;

    if (sel.type === 'shape') {
      const shape = this.activePage.shapes.find((s) => s.id === sel.id);
      if (shape) this.#clipboard = { type: 'shape', shape: structuredClone(shape) };
    } else if (this.activePage.imageDataUrl) {
      this.#clipboard = { type: 'image', imageDataUrl: this.activePage.imageDataUrl };
    }
  }

  /**
   * Pastes whatever's in the in-app clipboard onto the active page — pasting
   * never creates a new page. A copied shape is added (offset slightly,
   * selected). A copied image replaces just the active page's background
   * image — its own shapes are left untouched, and none of the source
   * page's annotations come along. No-op if the clipboard is empty.
   */
  paste(): void {
    if (!this.#clipboard) return;
    this.#snapshot();
    const pageId = this.activePageId.value;

    if (this.#clipboard.type === 'shape') {
      const original = this.#clipboard.shape;
      const pasted: Shape = {
        ...structuredClone(original),
        id: makeId(),
        points: original.points.map((p) => ({ x: p.x + PASTE_OFFSET, y: p.y + PASTE_OFFSET })),
      };
      this.pages.update((pages) =>
        pages.map((p) => (p.id === pageId ? { ...p, shapes: [...p.shapes, pasted] } : p))
      );
      this.selection.set({ type: 'shape', id: pasted.id });
    } else {
      const imageDataUrl = this.#clipboard.imageDataUrl;
      this.pages.update((pages) => pages.map((p) => (p.id === pageId ? { ...p, imageDataUrl } : p)));
      this.selection.set({ type: 'image' });
    }
  }

  zoomIn(): void {
    this.zoom.set(Math.min(ZOOM_MAX, this.zoom.value * ZOOM_STEP));
  }

  zoomOut(): void {
    this.zoom.set(Math.max(ZOOM_MIN, this.zoom.value / ZOOM_STEP));
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
