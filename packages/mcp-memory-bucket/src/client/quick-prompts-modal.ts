import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import './entity-card.js';
import type { QuickPrompt, Folder } from './types.js';
import { toast } from './toast.js';

// Single-slot undo, deliberately not a full stack (see the Quick Prompts spec) — module-level so
// it survives this modal being closed/reopened within the same tab session, but is lost on reload
// (in-memory only, matching the spec's "for the current session" scope).
let lastDeleted: { title: string; body: string; tags: string[]; pinned: boolean; folder: string } | null = null;

const GRID_MIN_COL_WIDTH = 200;
// Remembers which memory folder new quick prompts go to, same localStorage-preference pattern as
// folder-view.ts's MODE_STORAGE_KEY — needed because MemoryRepository.create() throws when more
// than one memory folder is configured and no folder is specified (resolveFolder can't guess).
const DEFAULT_FOLDER_STORAGE_KEY = 'mem-bucket-quick-prompts-folder';

export class QuickPromptsModal extends LitElement {
  static properties = {
    onClose: { attribute: false },
    memoryFolders: { attribute: false },
    openToAdd: { attribute: false },
  };

  declare onClose: () => void;
  declare memoryFolders: Folder[] | undefined;
  /** When true at connect, the modal mounts straight into the add-form (Cmd/Ctrl+Enter from the
   * main window — see mem-bucket-app.ts's #quickPromptsStartAdding) instead of the search grid. */
  declare openToAdd: boolean | undefined;

  #prompts = new Signal<QuickPrompt[]>([]);
  #loading = new Signal<boolean>(true);
  #query = new Signal<string>('');
  #selectedIndex = new Signal<number>(-1);
  #adding = new Signal<boolean>(false);
  // True only when the palette was mounted straight into the add-form (openToAdd, from the main
  // window's Cmd/Ctrl+Enter) rather than opened as a search palette the user then chose Add from —
  // there's no list underneath to "go back to" in that case, so Escape/Cancel should close the
  // whole modal instead of just falling back to the (never-seen) grid. Fixed at connect time, not
  // reactive to #adding, since a later Cmd+Enter from WITHIN the palette does have a list to return to.
  #openedDirectlyToAdd = false;
  // Non-null while editing an existing prompt instead of creating a new one — the add-form is
  // reused as-is for both (same fields, same layout), just prefilled and PATCHing on submit.
  #editingId = new Signal<string | null>(null);
  #newTitle = new Signal<string>('');
  #newBody = new Signal<string>('');
  #newFolder = new Signal<string>(localStorage.getItem(DEFAULT_FOLDER_STORAGE_KEY) ?? '');
  #error = new Signal<string>('');
  #restoreHint = new Signal<string>('');

  #boundOnKeydown = (e: KeyboardEvent) => this.#onKeydown(e);
  #boundOnWindowKeydown = (e: KeyboardEvent) => this.#onWindowKeydown(e);

  static styles = css`
    :host { display: block; }
    .backdrop {
      position: fixed; inset: 0; background: var(--overlay);
      display: flex; align-items: flex-start; justify-content: center; padding-top: 10vh; z-index: 200;
    }
    .modal {
      background: var(--bg);
      color: inherit;
      border-radius: 12px;
      width: min(760px, 92vw);
      max-height: 76vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 12px 48px var(--shadow);
      border: 1px solid var(--border);
      overflow: hidden;
    }
    .search-row {
      display: flex; align-items: center; gap: 8px; padding: 12px 16px;
      border-bottom: 1px solid var(--border);
    }
    .search-row input {
      flex: 1; border: none; background: none; color: inherit; font-size: 15px; outline: none;
    }
    .hint { font-size: 11px; opacity: 0.5; white-space: nowrap; }
    .body { flex: 1; overflow-y: auto; padding: 14px 16px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(${GRID_MIN_COL_WIDTH}px, 1fr));
      gap: 10px;
    }
    .add-tile {
      display: flex; align-items: center; justify-content: center;
      border: 1px dashed var(--border-strong);
      border-radius: 10px;
      min-height: 96px;
      cursor: pointer;
      font-size: 28px;
      opacity: 0.5;
      background: none;
      color: inherit;
    }
    .add-tile:hover { opacity: 1; background: var(--hover); }
    .empty { padding: 24px; text-align: center; opacity: 0.6; font-size: 13px; }
    .add-form { display: flex; flex-direction: column; gap: 8px; padding: 4px 0 2px; }
    .add-form input[type='text'] {
      padding: 6px 9px; font-size: 12.5px; border: 1px solid var(--border-strong); border-radius: 6px;
      background: none; color: inherit;
    }
    .add-form textarea {
      padding: 8px 9px; font-size: 13px; border: 1px solid var(--border-strong); border-radius: 6px;
      background: none; color: inherit; resize: vertical; min-height: 140px; font-family: inherit;
    }
    .add-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .folder-pill {
      flex: 0 0 auto;
      padding: 4px 10px; font-size: 11.5px; border: 1px solid var(--border-strong); border-radius: 999px;
      background: var(--bg-subtle); color: inherit; cursor: pointer;
    }
    .folder-pill:hover { background: var(--hover); }
    button.primary {
      background: var(--accent); border: 1px solid var(--accent); color: var(--accent-fg); padding: 6px 14px;
      border-radius: 6px; cursor: pointer; font-size: 13px;
    }
    button.secondary {
      background: none; border: 1px solid var(--border-strong); color: inherit; padding: 6px 14px;
      border-radius: 6px; cursor: pointer; font-size: 13px;
    }
    .error { color: var(--danger); font-size: 12px; padding: 0 16px 10px; }
    .footer-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 8px 16px; border-top: 1px solid var(--border); font-size: 11px; opacity: 0.6;
    }
  `;

  constructor() {
    super();
    new SignalWatcher(this);
  }

  // Runs on every update, including the first — unlike calling #ensureValidFolder from
  // connectedCallback alone, this re-validates whenever memoryFolders itself changes, which covers
  // the case where the property binding from mem-bucket-app.ts (.memoryFolders=${...}) commits
  // AFTER this element's connectedCallback already ran with an empty/stale list (Lit doesn't
  // guarantee child property assignment strictly before connectedCallback on first mount).
  willUpdate(changed: Map<string, unknown>) {
    if (changed.has('memoryFolders')) this.#ensureValidFolder();
  }

  connectedCallback() {
    super.connectedCallback();
    this.#load();
    this.#ensureValidFolder();
    if (this.openToAdd) {
      this.#openedDirectlyToAdd = true;
      this.#startAdd();
    }
    // @keydown on the search input covers arrow/Enter navigation while it has focus (the normal
    // case); the window listener below additionally catches Cmd+Z even when focus is elsewhere in
    // the modal (e.g. right after a delete moved focus), per the undo scope decision (see #onWindowKeydown).
    window.addEventListener('keydown', this.#boundOnWindowKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.#boundOnWindowKeydown);
  }

  firstUpdated() {
    (this.renderRoot.querySelector('.search-row input') as HTMLInputElement | null)?.focus();
  }

  async #load() {
    this.#loading.set(true);
    try {
      const res = await fetch('/api/quick-prompts');
      const data = (await res.json()) as QuickPrompt[];
      this.#prompts.set(data);
    } catch (err) {
      this.#error.set((err as Error).message);
    } finally {
      this.#loading.set(false);
    }
  }

  // Pinned float above recency order (already the server's default sort within each group); done
  // client-side rather than as a server param since the live search-as-you-type filter below is
  // also client-side and both need to stay in sync trivially. Also scopes to the folder-pill's
  // current selection — #newFolder doubles as "which folder's prompts are showing" per the folder
  // pill's dual role (save target AND view filter), not just a write-time default.
  #visiblePrompts(): QuickPrompt[] {
    const byFolder = this.#newFolder.value
      ? this.#prompts.value.filter((p) => p.folder === this.#newFolder.value)
      : this.#prompts.value;
    const q = this.#query.value.trim().toLowerCase();
    const filtered = q
      ? byFolder.filter(
          (p) => p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q))
        )
      : byFolder;
    return [...filtered].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }

  // Keeps the same tile selected across a keystroke when it's still in the filtered results (so
  // typing to narrow down a prompt doesn't lose your place), falling back to the first tile when it
  // drops out of the filtered set (or nothing was selected yet) — so "type, then Enter" always has
  // something to copy without an extra arrow-key press first.
  #onSearchInput(e: Event) {
    const previouslySelected = this.#visiblePrompts()[this.#selectedIndex.value];
    this.#query.set((e.target as HTMLInputElement).value);
    const next = this.#visiblePrompts();
    const stillThere = previouslySelected ? next.findIndex((p) => p.id === previouslySelected.id) : -1;
    this.#selectedIndex.set(stillThere !== -1 ? stillThere : next.length > 0 ? 0 : -1);
  }

  // Grid is a responsive auto-fill (see .grid's minmax), not a fixed column count — read the
  // actual rendered column count off the grid's own computed style so up/down moves by a real row
  // regardless of modal width, rather than assuming a number that could be wrong at any given size.
  #gridColumns(): number {
    const grid = this.renderRoot.querySelector('.grid') as HTMLElement | null;
    if (!grid) return 1;
    const template = getComputedStyle(grid).gridTemplateColumns;
    return Math.max(1, template.split(' ').filter(Boolean).length);
  }

  #onKeydown(e: KeyboardEvent) {
    // Cmd/Ctrl+Enter opens the add-form from anywhere in the palette — search box focused, a tile
    // selected, no selection at all — regardless of what's focused. Once the add-form is already
    // open, Cmd/Ctrl+Enter instead SUBMITS it (see #onAddFormKeydown, which stops this from
    // re-firing via stopPropagation-free bubbling since #adding is true by then).
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !this.#adding.value) {
      e.preventDefault();
      this.#startAdd();
      return;
    }
    const items = this.#visiblePrompts();
    const cols = this.#gridColumns();
    // Left/Right must not be hijacked while there's actual text to move the cursor through in a
    // text field (search input or quick-add title/textarea) — those live inside this same .modal
    // and their keydowns bubble here, so without this guard Option/Cmd+Arrow word-jump and native
    // text-cursor movement broke while editing text. But the search box is focused by default the
    // instant the palette opens and is very often EMPTY at that point — an empty/single-line field
    // has nothing for native Left/Right to do, so treating "focus is in a text field" alone as
    // reason to bail (as an earlier version of this guard did) silently ate every Left/Right tile
    // navigation whenever the search box merely had focus, which is nearly always. Only defer to
    // native behavior when the field genuinely has content on at least one side of the caret.
    const target = e.target as HTMLElement | null;
    const isTextInput = target instanceof HTMLInputElement;
    const isTextarea = target instanceof HTMLTextAreaElement;
    const hasNavigableText = (isTextInput || isTextarea) && target.value.length > 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (hasNavigableText) return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (isTextarea) return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      let idx = this.#selectedIndex.value;
      if (idx === -1) {
        idx = 0;
      } else if (e.key === 'ArrowDown') {
        idx = Math.min(items.length - 1, idx + cols);
      } else if (e.key === 'ArrowUp') {
        idx = Math.max(0, idx - cols);
      } else if (e.key === 'ArrowRight') {
        idx = Math.min(items.length - 1, idx + 1);
      } else if (e.key === 'ArrowLeft') {
        idx = Math.max(0, idx - 1);
      }
      this.#selectedIndex.set(idx);
      return;
    }
    if (e.key === 'Enter') {
      const selected = items[this.#selectedIndex.value];
      if (selected) {
        e.preventDefault();
        this.#copyAndClose(selected);
      }
      return;
    }
    if (e.key === 'Escape' && !this.#adding.value) {
      this.onClose();
    }
  }

  // Scoped to while the modal is open (not a global window-level hotkey outside it) — undo only
  // makes sense in the context of a delete the user just made from this palette, and a global
  // Cmd+Z would risk fighting a text field's own native undo elsewhere in the app.
  #onWindowKeydown(e: KeyboardEvent) {
    const isUndo = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z';
    if (isUndo && lastDeleted) {
      e.preventDefault();
      this.#restoreLastDeleted();
    }
  }

  async #copyAndClose(prompt: QuickPrompt) {
    try {
      await navigator.clipboard.writeText(prompt.body);
      // Fires from toast-stack, mounted once at the app root (mem-bucket-app.ts) — the toast
      // outlives this modal closing right after, since it's a separate module-level queue, not a
      // child of this component.
      toast.success('Copied to clipboard');
    } catch {
      // clipboard write can fail (permissions/insecure context) — closing anyway matches the
      // "Enter copies + closes" spec; a failed copy isn't worth blocking the close over.
      toast.danger('Copy failed');
    }
    this.onClose();
  }

  async #togglePin(prompt: QuickPrompt) {
    const nextPinned = !prompt.pinned;
    this.#prompts.set(this.#prompts.value.map((p) => (p.id === prompt.id ? { ...p, pinned: nextPinned } : p)));
    await fetch(`/api/quick-prompts/${encodeURIComponent(prompt.id)}/pinned`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: nextPinned }),
    });
  }

  async #deletePrompt(prompt: QuickPrompt) {
    lastDeleted = { title: prompt.title, body: prompt.body, tags: prompt.tags, pinned: prompt.pinned, folder: prompt.folder };
    this.#prompts.set(this.#prompts.value.filter((p) => p.id !== prompt.id));
    this.#restoreHint.set('Deleted — press Cmd+Z / Ctrl+Z to undo');
    try {
      await fetch(`/api/quick-prompts/${encodeURIComponent(prompt.id)}`, { method: 'DELETE' });
    } catch (err) {
      this.#error.set((err as Error).message);
    }
  }

  async #restoreLastDeleted() {
    const toRestore = lastDeleted;
    if (!toRestore) return;
    lastDeleted = null;
    this.#restoreHint.set('');
    try {
      const res = await fetch('/api/quick-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: toRestore.title, body: toRestore.body, tags: toRestore.tags, folder: toRestore.folder }),
      });
      const created = (await res.json()) as QuickPrompt;
      if (toRestore.pinned) {
        await fetch(`/api/quick-prompts/${encodeURIComponent(created.id)}/pinned`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: true }),
        });
        created.pinned = true;
      }
      this.#prompts.set([created, ...this.#prompts.value]);
      this.#restoreHint.set('Prompt restored');
      setTimeout(() => this.#restoreHint.set(''), 2000);
    } catch (err) {
      this.#error.set((err as Error).message);
    }
  }

  // Falls back to the first configured memory folder when the localStorage-remembered one no
  // longer exists (folder renamed/removed) — called on connect so the always-visible folder-pill
  // button never shows a stale/blank value, and again defensively before add/edit in case
  // memoryFolders arrived or changed after connect.
  #ensureValidFolder() {
    const folders = this.memoryFolders ?? [];
    if (folders.length === 0) return;
    if (!folders.some((f) => f.name === this.#newFolder.value)) {
      this.#newFolder.set(folders[0]!.name);
    }
  }

  #startAdd() {
    this.#editingId.set(null);
    this.#newTitle.set('');
    this.#newBody.set('');
    this.#ensureValidFolder();
    this.#adding.set(true);
    this.#focusBodyWhenRendered();
  }

  // Same add-form, prefilled from the existing prompt and PATCHing instead of POSTing on submit —
  // deliberately not a separate form/modal (see #submitAdd's branch on #editingId).
  #startEdit(prompt: QuickPrompt) {
    this.#editingId.set(prompt.id);
    this.#newTitle.set(prompt.title);
    this.#newBody.set(prompt.body);
    this.#newFolder.set(prompt.folder);
    this.#adding.set(true);
    this.#focusBodyWhenRendered();
  }

  // Signal-driven re-render (via SignalWatcher) happens asynchronously after #adding flips true, so
  // the textarea doesn't exist in renderRoot yet at the point #startAdd/#startEdit run — wait for
  // updateComplete before querying for it, same reasoning as firstUpdated's initial search-input focus.
  #focusBodyWhenRendered() {
    this.updateComplete.then(() => {
      (this.renderRoot.querySelector('.add-form textarea') as HTMLTextAreaElement | null)?.focus();
    });
  }

  #focusSearchWhenRendered() {
    this.updateComplete.then(() => {
      (this.renderRoot.querySelector('.search-row input') as HTMLInputElement | null)?.focus();
    });
  }

  #onFolderChange(name: string) {
    this.#newFolder.set(name);
    localStorage.setItem(DEFAULT_FOLDER_STORAGE_KEY, name);
    // The pill also scopes the visible grid (#visiblePrompts), so a stale keyboard-nav selection
    // from the previous folder's tile set could otherwise point at the wrong item after switching.
    this.#selectedIndex.set(-1);
  }

  #cancelAdd() {
    // Opened straight into the add-form (no list the user ever saw to "go back" to) — Cancel/Escape
    // closes the whole palette here instead of revealing a grid that was never part of this flow.
    if (this.#openedDirectlyToAdd) {
      this.onClose();
      return;
    }
    this.#adding.set(false);
    this.#editingId.set(null);
    // Without this, focus is left on the now-removed textarea, which the browser drops to <body> —
    // outside .modal's subtree, so .modal's own @keydown listener (Escape-to-close, arrow-key nav,
    // Enter-to-copy) stops receiving any further keydowns at all until focus re-enters the modal.
    this.#focusSearchWhenRendered();
  }

  async #submitAdd() {
    const body = this.#newBody.value.trim();
    if (!body) return;
    this.#error.set('');
    const editingId = this.#editingId.value;
    try {
      const res = await fetch(editingId ? `/api/quick-prompts/${encodeURIComponent(editingId)}` : '/api/quick-prompts', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: this.#newTitle.value.trim(), body, folder: this.#newFolder.value || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.#error.set(data.error ?? (editingId ? 'failed to update prompt' : 'failed to create prompt'));
        return;
      }
      if (editingId) {
        this.#prompts.set(this.#prompts.value.map((p) => (p.id === editingId ? (data as QuickPrompt) : p)));
      } else {
        this.#prompts.set([data as QuickPrompt, ...this.#prompts.value]);
      }
      this.#adding.set(false);
      this.#editingId.set(null);
    } catch (err) {
      this.#error.set((err as Error).message);
    }
  }

  #onAddFormKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.#cancelAdd();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      this.#submitAdd();
    }
  }

  render() {
    const items = this.#visiblePrompts();
    return html`
      <div class="backdrop" @click=${(e: Event) => e.target === e.currentTarget && this.onClose()}>
        <div class="modal" @keydown=${this.#boundOnKeydown}>
          <div class="search-row">
            <input
              type="search"
              placeholder="Search quick prompts…"
              .value=${this.#query.value}
              @input=${(e: Event) => this.#onSearchInput(e)}
            />
            ${(this.memoryFolders?.length ?? 0) > 1
              ? html`
                  <select
                    class="folder-pill"
                    title="Shows and saves quick prompts for this folder"
                    .value=${this.#newFolder.value}
                    @change=${(e: Event) => this.#onFolderChange((e.target as HTMLSelectElement).value)}
                  >
                    ${this.memoryFolders!.map(
                      (f) => html`<option value=${f.name}>${f.remote ? '☁' : '📁'} ${f.name}</option>`
                    )}
                  </select>
                `
              : ''}
            <span class="hint">${this.#restoreHint.value || '↑↓←→ navigate · Enter copy · Esc close'}</span>
          </div>
          ${this.#error.value ? html`<div class="error">${this.#error.value}</div>` : ''}
          <div class="body">
            ${this.#adding.value
              ? html`
                  <div class="add-form" @keydown=${this.#onAddFormKeydown}>
                    <input
                      type="text"
                      placeholder="Title (optional)"
                      .value=${this.#newTitle.value}
                      @input=${(e: Event) => this.#newTitle.set((e.target as HTMLInputElement).value)}
                    />
                    <textarea
                      placeholder="Prompt text…"
                      .value=${this.#newBody.value}
                      @input=${(e: Event) => this.#newBody.set((e.target as HTMLTextAreaElement).value)}
                    ></textarea>
                    <div class="add-form-actions">
                      <button class="secondary" @click=${() => this.#cancelAdd()}>Cancel</button>
                      <button class="primary" ?disabled=${!this.#newBody.value.trim()} @click=${() => this.#submitAdd()}>
                        ${this.#editingId.value ? 'Save changes' : 'Add prompt'}
                      </button>
                    </div>
                  </div>
                `
              : this.#loading.value
                ? html`<div class="empty">Loading…</div>`
                : items.length === 0 && !this.#query.value
                  ? html`
                      <div class="grid">
                        <button class="add-tile" title="Add a quick prompt" @click=${() => this.#startAdd()}>+</button>
                      </div>
                      <div class="empty">No quick prompts yet — add one to get started.</div>
                    `
                  : html`
                      <div class="grid">
                        <button class="add-tile" title="Add a quick prompt" @click=${() => this.#startAdd()}>+</button>
                        ${items.map(
                          (p, i) => html`
                            <entity-card
                              .entityTitle=${p.title}
                              .description=${p.body}
                              .tags=${p.tags}
                              .iconOrEmoji=${p.remote ? '☁' : '📝'}
                              .pinned=${p.pinned}
                              .selected=${i === this.#selectedIndex.value}
                              .onPin=${() => this.#togglePin(p)}
                              .onCopy=${() => this.#copyAndClose(p)}
                              copyIcon="📋"
                              .onEdit=${() => this.#startEdit(p)}
                              .onDelete=${() => this.#deletePrompt(p)}
                              .onClick=${() => this.#copyAndClose(p)}
                              .onActivate=${() => this.#copyAndClose(p)}
                            ></entity-card>
                          `
                        )}
                      </div>
                    `}
          </div>
          <div class="footer-bar">
            <span>${items.length} quick prompt${items.length === 1 ? '' : 's'}</span>
            <span>⌘/Ctrl+Enter to add · Double-Shift to toggle this palette</span>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('quick-prompts-modal', QuickPromptsModal);
