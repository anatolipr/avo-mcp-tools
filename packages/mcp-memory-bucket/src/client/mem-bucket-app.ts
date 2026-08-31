import { LitElement, html, css } from 'lit';
import { Signal, Computed, SignalWatcher } from 'avosignals';

import './result-list.js';
import './detail-panel.js';
import './add-folder-modal.js';
import './tag-multiselect.js';
import './channel-view.js';
import './folder-view.js';
import './app-toolbar.js';
import './shared-with-me-panel.js';
import type { Entry, Facets, Selection, TypeFilter, FoldersResponse, Folder, ChannelSummary, ChannelDetail } from './types.js';
import type { SharedItemRow } from './shared-with-me-panel.js';
import { TENANT_ID, getFolderfooConfig } from './server-config.js';
import { parseFolderfooAddress } from './folderfoo-address.js';
import { currentIdentity, startIdentityStream } from './identity-stream.js';
import { startShareAccept } from './share-accept.js';

// Set once the folderfoo-profile-circle widget module has been dynamically imported (module
// execution, including its customElements.define, only happens once per URL) - lets later mount
// attempts (see #mountFolderfooProfileCircle) create the element synchronously instead of racing
// an async import()/getFolderfooConfig() chain against a fresh SignalWatcher-driven re-render.
let folderfooWidgetLoaded = false;

const TYPE_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'skill', label: 'Skills' },
  { value: 'memory', label: 'Memories' },
];

type TriState = 'all' | 'hide' | 'only';

const TRISTATE_OPTIONS: Array<{ value: TriState; label: string }> = [
  { value: 'all', label: 'Show all' },
  { value: 'hide', label: 'Hide' },
  { value: 'only', label: 'Only' },
];

const EMPTY_FACETS: Facets = { tags: [], statuses: [], owners: [], doc_types: [], key_types: [], folders: [] };
const EMPTY_FOLDERS: FoldersResponse = { skill: [], memory: [] };

const SPLIT_STORAGE_KEY = 'mem-bucket-split-pct';
const SPLIT_MIN_PCT = 20;
const SPLIT_MAX_PCT = 80;

function loadSplitPct(): number {
  const raw = Number(localStorage.getItem(SPLIT_STORAGE_KEY));
  return Number.isFinite(raw) && raw >= SPLIT_MIN_PCT && raw <= SPLIT_MAX_PCT ? raw : 40;
}

type ThemeMode = 'system' | 'light' | 'dark';
const THEME_STORAGE_KEY = 'mem-bucket-theme';
const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark'];

function loadTheme(): ThemeMode {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

function applyTheme(mode: ThemeMode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}

interface FilterState {
  query: string;
  typeFilter: TypeFilter;
  activeTags: string[];
  activeFolders: string[];
  sort: string;
  deprecatedFilter: TriState;
  pausedFilter: TriState;
  dateFrom: string;
  dateTo: string;
}

function loadFilterState(): Partial<FilterState> {
  const raw = location.hash.slice(1);
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  const state: Partial<FilterState> = {};
  const q = params.get('q');
  if (q) state.query = q;
  const type = params.get('type');
  if (type === 'skill' || type === 'memory' || type === 'all') state.typeFilter = type;
  const tags = params.getAll('tag');
  if (tags.length) state.activeTags = tags;
  const folders = params.getAll('folder');
  if (folders.length) state.activeFolders = folders;
  const sort = params.get('sort');
  if (sort) state.sort = sort;
  const deprecated = params.get('deprecated');
  if (deprecated === '0') state.deprecatedFilter = 'hide';
  else if (deprecated === '1') state.deprecatedFilter = 'only';
  const paused = params.get('paused');
  if (paused === '0') state.pausedFilter = 'hide';
  else if (paused === '1') state.pausedFilter = 'only';
  const dateFrom = params.get('date_from');
  if (dateFrom) state.dateFrom = dateFrom;
  const dateTo = params.get('date_to');
  if (dateTo) state.dateTo = dateTo;
  return state;
}

export class MemBucketApp extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; height: 100vh; position: relative; }
    /* Overlays whichever header row #renderBody() renders for the current mode (.folders-bar,
       .toolbar-bar, or folder-view's own .mode-row) - all three share the same 10px/16px padding,
       so this lines up with them pixel-for-pixel without needing to sit inside any of them. */
    .header-toolbar { position: absolute; top: 10px; right: 16px; z-index: 1; }
    .filters {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .search-field {
      position: relative;
      flex: 1 1 240px;
      max-width: 480px;
    }
    .filters input[type='search'] {
      font-size: 13px;
      padding: 6px 28px 6px 10px;
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      background: none;
      color: inherit;
      height: 30px;
    }
    .filters input[type='search']::-webkit-search-cancel-button { display: none; }
    .search-clear-btn {
      position: absolute;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      border: none;
      background: transparent;
      cursor: pointer;
      color: inherit;
      opacity: 0.6;
      font-size: 12px;
      line-height: 1;
      padding: 4px 6px;
      border-radius: 50%;
    }
    .search-clear-btn:hover { opacity: 1; background: var(--hover); }
    .date-range { display: flex; align-items: center; gap: 4px; }
    .date-range input[type='date'] {
      font-size: 13px;
      padding: 5px 8px;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      background: none;
      color: inherit;
      height: 30px;
      box-sizing: border-box;
    }
    .date-range-sep { opacity: 0.5; font-size: 12px; }
    .date-range-clear {
      position: static;
      transform: none;
      opacity: 0.6;
      font-size: 12px;
      line-height: 1;
      padding: 4px 6px;
      border: none;
      background: transparent;
      cursor: pointer;
      color: inherit;
      border-radius: 50%;
    }
    .date-range-clear:hover { opacity: 1; background: var(--hover); }
    .search-row { align-items: center; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .filter-label { font-size: 12px; opacity: 0.6; font-weight: 600; }
    .type-toggle { gap: 0; }
    .type-toggle button {
      border: 1px solid var(--border-strong);
      background: none;
      color: inherit;
      padding: 6px 12px;
      font-size: 13px;
      cursor: pointer;
      height: 30px;
      box-sizing: border-box;
    }
    .type-toggle button.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
    .type-toggle button:first-child { border-radius: 6px 0 0 6px; }
    .type-toggle button:last-child { border-radius: 0 6px 6px 0; }
    .type-toggle button:not(:first-child) { border-left: none; }
    .body-region { display: flex; flex: 1 1 auto; min-height: 0; }
    result-list { overflow-y: auto; flex: 0 0 auto; }
    detail-panel { overflow-y: auto; flex: 1 1 auto; min-width: 0; }
    .splitter {
      flex: 0 0 auto;
      width: 6px;
      cursor: col-resize;
      background: var(--hover);
      position: relative;
    }
    .splitter:hover, .splitter.dragging { background: var(--accent-tint); }
    .splitter::after {
      content: '';
      position: absolute;
      top: 0; bottom: 0;
      left: -3px; right: -3px;
    }
    label.small { font-size: 12px; opacity: 0.7; }
    /* padding-right reserves room for .header-toolbar (an absolutely-positioned overlay, so it
       takes no space in this row's own flex layout) so wrapped folder chips don't run under it. */
    .folders-bar {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      padding: 10px 320px 10px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-subtle);
    }
    .folders-bar .folder-chips {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      flex: 1 1 auto;
      min-width: 0;
    }
    .toolbar-bar {
      display: flex;
      align-items: center;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-subtle);
    }
    .folder-chip {
      border: 1px solid var(--border-strong); border-radius: 999px; padding: 3px 8px 3px 10px; font-size: 12px;
      cursor: pointer; background: none; color: inherit; display: inline-flex; align-items: center; gap: 6px;
    }
    /* Active chips invert to a solid white fill with dark text in both themes, so they read
       clearly against remote chips' accent outline instead of blending into a similar tint. */
    .folder-chip.active { background: #ffffff; border-color: var(--purple); color: #111111; }
    /* Remote (folderfoo) folders get the accent color instead of the default border, so they're
       visually distinct from local folders at a glance — active-state purple still wins when both apply. */
    .folder-chip.remote { border-color: var(--accent); color: var(--accent); }
    .folder-chip.remote.active { background: #ffffff; border-color: var(--purple); color: #111111; }
    .folder-chip .remote-dot {
      width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0;
    }
    .folder-chip.active .remote-dot { background: var(--purple); }
    .folder-chip .kind {
      opacity: 0.55; font-size: 10px;
    }
    .folder-chip .remove {
      opacity: 0.6; font-size: 12px; line-height: 1; padding: 2px; border-radius: 50%;
    }
    .folder-chip .remove:hover { opacity: 1; background: var(--hover-strong); }
    .add-folder-btn {
      border: 1px dashed var(--border-strong); border-radius: 999px; padding: 3px 10px; font-size: 12px;
      cursor: pointer; background: none; color: inherit; opacity: 0.75;
    }
    .add-folder-btn:hover { opacity: 1; }
    .folderfoo-open-banner {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 8px 16px; font-size: 12px; background: var(--accent-tint); border-bottom: 1px solid var(--border);
    }
    .folderfoo-open-banner .dismiss {
      background: none; border: none; color: inherit; cursor: pointer; opacity: 0.6; padding: 2px; border-radius: 50%;
    }
    .folderfoo-open-banner .dismiss:hover { opacity: 1; background: var(--hover-strong); }
    .first-run {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      flex: 1 1 auto; gap: 16px; text-align: center; padding: 24px;
    }
    .first-run h1 { font-size: 18px; margin: 0; }
    .first-run p { opacity: 0.7; font-size: 13px; max-width: 420px; margin: 0; }
    select {
      font-size: 13px;
      padding: 6px 8px;
      height: 30px;
      box-sizing: border-box;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      background: none;
      color: inherit;
    }
    .bulk-bar {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 6px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--accent-tint);
      font-size: 12px;
    }
    .bulk-bar button {
      font-size: 11px;
      padding: 4px 10px;
      border: 1px solid var(--border);
      background: transparent;
      color: inherit;
      border-radius: 4px;
      cursor: pointer;
    }
    .bulk-bar button.danger { border-color: var(--danger); color: var(--danger); }
  `;

  #initialFilters = loadFilterState();
  #query = new Signal(this.#initialFilters.query ?? '');
  #typeFilter = new Signal<TypeFilter>(this.#initialFilters.typeFilter ?? 'all');
  #activeTags = new Signal<string[]>(this.#initialFilters.activeTags ?? []);
  #activeFolders = new Signal<string[]>(this.#initialFilters.activeFolders ?? []);
  #results = new Signal<Entry[]>([]);
  #facets = new Signal<Facets>(EMPTY_FACETS);
  #selected = new Signal<Selection | null>(null);
  #folders = new Signal<FoldersResponse>(EMPTY_FOLDERS);
  #showAddFolder = new Signal<boolean>(false);
  #removingFolder = new Signal<string>('');
  #foldersLoaded = new Signal<boolean>(false);
  #splitPct = new Signal<number>(loadSplitPct());
  #folderfooOpenStatus = new Signal<string>(''); // transient banner for the folderfoo-file-open handler's result/miss message
  #dragging = new Signal<boolean>(false);
  // '' means "no explicit user choice" — server defaults to relevance when q is set, mtime_desc otherwise.
  #sort = new Signal<string>(this.#initialFilters.sort ?? '');
  #deprecatedFilter = new Signal<TriState>(this.#initialFilters.deprecatedFilter ?? 'all');
  #pausedFilter = new Signal<TriState>(this.#initialFilters.pausedFilter ?? 'all');
  #dateFrom = new Signal<string>(this.#initialFilters.dateFrom ?? '');
  #dateTo = new Signal<string>(this.#initialFilters.dateTo ?? '');
  #selectedIds = new Signal<Set<string>>(new Set());
  #theme = new Signal<ThemeMode>(loadTheme());
  #reindexing = new Signal<boolean>(false);
  #view = new Signal<'entries' | 'channels' | 'folder-view' | 'shared'>('entries');
  #folderViewEntries = new Signal<Entry[]>([]);
  #channels = new Signal<ChannelSummary[]>([]);
  #selectedChannel = new Signal<string | null>(null);
  #channelDetail = new Signal<ChannelDetail | null>(null);
  #channelLoading = new Signal<boolean>(false);
  // Populated ONLY by an explicit GET on view-switch (loading whatever the server currently has,
  // never a fetch-and-refresh) and by the recycle-icon's onRefresh — see shared-with-me-panel.ts's
  // own comment for why this deliberately never auto-refreshes on a timer/focus.
  #sharedItems = new Signal<SharedItemRow[]>([]);
  #sharedRefreshing = new Signal<boolean>(false);
  #sharedRefreshSummary = new Signal<{ added: number; updated: number; revoked: number; unchanged: number } | null>(null);

  #boundOnDragMove = (e: PointerEvent) => this.#onDragMove(e);
  #boundOnDragEnd = () => this.#onDragEnd();

  constructor() {
    super();
    new SignalWatcher(this);
    applyTheme(this.#theme.value);
  }

  #setTheme(mode: ThemeMode) {
    this.#theme.set(mode);
    localStorage.setItem(THEME_STORAGE_KEY, mode);
    applyTheme(mode);
  }

  #cycleTheme() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(this.#theme.value) + 1) % THEME_CYCLE.length]!;
    this.#setTheme(next);
  }

  async #reindex() {
    if (this.#reindexing.value) return;
    this.#reindexing.set(true);
    try {
      await fetch('/api/rebuild-cache', { method: 'POST' });
      await Promise.all([this.#refetchFolders(), this.#refetchFacets(), this.#refetch()]);
    } finally {
      this.#reindexing.set(false);
    }
  }

  #onDragStart(e: PointerEvent) {
    e.preventDefault();
    this.#dragging.set(true);
    document.addEventListener('pointermove', this.#boundOnDragMove);
    document.addEventListener('pointerup', this.#boundOnDragEnd);
  }

  #onDragMove(e: PointerEvent) {
    const region = this.renderRoot.querySelector('.body-region') as HTMLElement | null;
    if (!region) return;
    const rect = region.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    this.#splitPct.set(Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, pct)));
  }

  #onDragEnd() {
    this.#dragging.set(false);
    document.removeEventListener('pointermove', this.#boundOnDragMove);
    document.removeEventListener('pointerup', this.#boundOnDragEnd);
    localStorage.setItem(SPLIT_STORAGE_KEY, String(this.#splitPct.value));
  }

  #requestQuery = new Computed(() => {
    const params = new URLSearchParams();
    if (this.#typeFilter.value !== 'all') params.set('type', this.#typeFilter.value);
    if (this.#query.value.trim()) params.set('q', this.#query.value.trim());
    for (const tag of this.#activeTags.value) params.append('tag', tag);
    for (const folder of this.#activeFolders.value) params.append('folder', folder);
    if (this.#sort.value) params.set('sort', this.#sort.value);
    if (this.#deprecatedFilter.value === 'hide') params.set('deprecated', '0');
    else if (this.#deprecatedFilter.value === 'only') params.set('deprecated', '1');
    if (this.#pausedFilter.value === 'hide') params.set('paused', '0');
    else if (this.#pausedFilter.value === 'only') params.set('paused', '1');
    if (this.#dateFrom.value) params.set('date_from', this.#dateFrom.value);
    if (this.#dateTo.value) params.set('date_to', this.#dateTo.value);
    return params.toString();
  });

  // Same scope as #requestQuery minus the tag/folder params — Folder View's tree is built by
  // aggregating this set client-side, so folder/tag membership itself must NOT be pre-filtered out.
  #folderViewQuery = new Computed(() => {
    const params = new URLSearchParams();
    if (this.#typeFilter.value !== 'all') params.set('type', this.#typeFilter.value);
    if (this.#query.value.trim()) params.set('q', this.#query.value.trim());
    if (this.#deprecatedFilter.value === 'hide') params.set('deprecated', '0');
    else if (this.#deprecatedFilter.value === 'only') params.set('deprecated', '1');
    if (this.#pausedFilter.value === 'hide') params.set('paused', '0');
    else if (this.#pausedFilter.value === 'only') params.set('paused', '1');
    if (this.#dateFrom.value) params.set('date_from', this.#dateFrom.value);
    if (this.#dateTo.value) params.set('date_to', this.#dateTo.value);
    return params.toString();
  });

  #boundOnFocus = () => this.#onFocus();
  #boundOnFolderfooFileOpen = (e: Event) => this.#onFolderfooFileOpen(e as CustomEvent<{ name: string }>);
  #boundOnFolderfooFolderChanged = (e: Event) =>
    this.#onFolderfooFolderChanged(e as CustomEvent<{ path: string; action: 'delete' | 'rename' | 'move'; newPath?: string }>);
  #boundOnFolderfooAuthChange = () => this.#onFolderfooAuthChange();
  #unsubscribeIdentity?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this.#refetch();
    this.#refetchFacets();
    // Awaited (unlike every other call here) so the #onFocus() below sees a
    // populated #folders signal - #onFocus only force-resyncs when
    // #allFolders() already contains a remote folder, and on a cold page
    // load that list starts out empty until this fetch resolves.
    this.#refetchFolders().then(() => this.#onFocus());
    window.addEventListener('focus', this.#boundOnFocus);
    document.addEventListener('visibilitychange', this.#boundOnFocus);
    // Runs the same force-resync #onFocus does on a real focus transition,
    // for the initial page load itself - otherwise a tab opened once and
    // left open/visible (no focus/visibilitychange event ever refires) only
    // ever shows whatever was last synced, even if another device wrote to
    // a connected remote folder before this tab was opened.
    document.addEventListener('folderfoo-file-open', this.#boundOnFolderfooFileOpen);
    document.addEventListener('folderfoo-folder-changed', this.#boundOnFolderfooFolderChanged);
    window.addEventListener('folderfoo-auth-change', this.#boundOnFolderfooAuthChange);
    // Covers the case where the browser already holds a valid folderfoo
    // session when this page loads (e.g. the server was restarted, or this
    // is a fresh tab) - no folderfoo-auth-change event fires for "already
    // logged in," so without this check the server's process-wide identity
    // would stay unset (hiding every remote folder) until the user manually
    // logged out and back in.
    this.#onFolderfooAuthChange();
    startIdentityStream();
    startShareAccept((entry) => this.#acceptSharedItem(entry));
    // Loaded once up front (not just on-demand when the panel opens) so showShared's "has at least
    // one shared item" fallback is correct on the very first render — a public-link item accepted
    // in a prior session needs the button visible immediately, not only after the user somehow
    // finds a now-hidden panel to open it from.
    this.#loadSharedItems();
    // The server pushes identity changes (from ANY tab's login/logout) over
    // SSE - re-fetch folders whenever that arrives so this tab's visible
    // list reflects the current identity live, without a page reload.
    this.#unsubscribeIdentity = currentIdentity.subscribe(() => {
      this.#refetchFolders();
      // Without these, the ENTRIES list and filter facets (tags/owners/folders dropdowns) kept
      // showing stale rows/options from a remote folder that just became invisible (e.g. logging
      // out, or switching to a different folderfoo login) until some unrelated action (search,
      // filter change) happened to trigger the next refetch — a real, confirmed bug: the folder chip
      // correctly vanished, but its rows lingered in the list/search results underneath it.
      this.#refetch();
      this.#refetchFacets();
      // Bounce back to the default view if the login that made "Shared" meaningful just
      // disappeared out from under an already-open panel — matches showShared's own gating in
      // #renderToolbar (the button that opened this view is about to vanish too).
      if (this.#view.value === 'shared' && currentIdentity.value.username === null) this.#setView('entries');
    });
  }

  // Opens a file picked via folderfoo's own File Open dialog directly in
  // this app's right panel, IF its folder is already connected here as a
  // remote source — see /api/folderfoo/resolve-open's own doc comment for
  // the matching logic and why a miss is a real, expected case (folderfoo's
  // File Open browses the user's whole tree, not just connected folders).
  // Once selected, the existing detail panel + PATCH /api/entries route
  // already push any edit straight through to folderfoo (see M5's live-
  // write design) — no separate "save to cloud" wiring needed for that half.
  //
  // Scoped to the CURRENT folderfoo session only (owner-shared files opened
  // from someone else's tree don't resolve here, since a connected
  // RemoteFolder's folderPath is always relative to ITS OWNER's tree, not
  // the viewer's) - a real but narrow gap, not attempted here.
  async #onFolderfooFileOpen(e: CustomEvent<{ name: string }>) {
    const address = e.detail?.name;
    if (!address) return;
    const parsed = parseFolderfooAddress(address);
    if (parsed.owner) {
      this.#folderfooOpenStatus.set(`"${parsed.name}" is from a shared folder — opening shared files here isn't supported yet.`);
      return;
    }
    const { folderfooMode, folderfooHost } = await getFolderfooConfig();
    if (folderfooMode === 'off' || !folderfooHost) return; // no session to resolve against
    try {
      const res = await fetch('/api/folderfoo/resolve-open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: folderfooHost, tenantId: TENANT_ID, folderPath: parsed.folderPath, name: parsed.name }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.#folderfooOpenStatus.set(data.error ?? `couldn't open "${parsed.name}"`);
        return;
      }
      this.#folderfooOpenStatus.set('');
      this.#selected.set({ table: data.table, id: data.id });
    } catch (err) {
      this.#folderfooOpenStatus.set((err as Error).message);
    }
  }

  // Fired by the embedded File Open dialog (folderfoo-file-open.js's _dispatchFolderChanged, see
  // that file's doc comment) the moment a folder is deleted/renamed/moved from within THIS tab's
  // dialog — a same-tab optimization layered on top of #onFocus's reload-triggered resync above,
  // not a replacement for it (a change made via folderfoo.com directly, another device, or another
  // tab still only surfaces on next focus/reload, since there's no cross-tab/cross-origin event
  // for those). 'delete' needs no server call here: GET /api/folders (in #refetchFolders below)
  // already prunes any remote source folderfoo confirms is gone (see routes.ts's
  // pruneDeletedRemoteFolders), so a plain refetch picks it up. 'rename'/'move' repoint the
  // affected source(s) in place first (POST /api/folders/renamed — same content, new remote path,
  // never a delete+reconnect) before refetching.
  async #onFolderfooFolderChanged(e: CustomEvent<{ path: string; action: 'delete' | 'rename' | 'move'; newPath?: string }>) {
    const { path: oldPath, action, newPath } = e.detail ?? {};
    if (oldPath === undefined || !action) return;
    if ((action === 'rename' || action === 'move') && newPath) {
      const { folderfooHost } = await getFolderfooConfig();
      if (!folderfooHost) return;
      try {
        await fetch('/api/folders/renamed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server: folderfooHost, oldPath, newPath }),
        });
      } catch {
        // Best-effort — the source stays registered at its old (now-stale) folderPath until the
        // next successful poll/focus resync surfaces the mismatch as a live-call failure; no worse
        // than before this event existed.
      }
    }
    this.#refetchFolders();
  }

  // Per the adding-folderfoo-integration skill's Step 4: dynamically import
  // and mount folderfoo's own login/account widget, exactly like every
  // other folderfoo-consuming app (mindfoo, bulletino, screenmarker) does —
  // never vendor/copy these files, so this stays current with the server's
  // widget automatically. This is a SEPARATE login from the "Connect
  // folderfoo" flow in add-folder-modal.ts: this one authenticates the
  // human viewing this page (stored in this page's own localStorage), the
  // modal's flow reads that same token back out to also persist it
  // server-side for the Node process (poller, live reads/writes) to use.
  //
  // No-ops entirely when --folderfoo-mode/FOLDERFOO_MODE is "off" (the
  // default) — most users run mcp-memory-bucket with no folderfoo account
  // and shouldn't see a login prompt or pay for the network calls a
  // logged-out widget still makes (GET /me, refresh scheduling).
  // .folderfoo-slot lives inside <app-toolbar>'s own shadow root (see app-toolbar.ts) - a
  // light-DOM query for <app-toolbar> (an element, not a class selector, so it crosses into its
  // shadow root via .shadowRoot below) rather than caching the slot reference once, since
  // app-toolbar.ts's own font-inheritance requirements (see its file-level comment) mean this
  // stays the single source of truth for "where is the toolbar right now."
  #findFolderfooSlot(): Element | null {
    return this.shadowRoot?.querySelector('app-toolbar')?.shadowRoot?.querySelector('.folderfoo-slot') ?? null;
  }

  #appendFolderfooCircle(slot: Element) {
    const el = document.createElement('folderfoo-profile-circle');
    el.setAttribute('app-name', 'Memory Bucket');
    el.setAttribute('tenant-id', TENANT_ID);
    // :host in folderfoo's shadow DOM is `all: initial`, and its .avatar
    // is a fixed 32px sized independently of :host, so shrinking it to
    // match the 28px theme/reindex toggles needs a scale applied as an
    // inline style on the host element. Using `zoom` (not `transform`)
    // here specifically: `transform` makes the host a new containing
    // block for its `position: fixed` descendants, which breaks
    // folderfoo's login/file-open modals (they render relative to this
    // tiny circle instead of the real viewport).
    (el.style as CSSStyleDeclaration & { zoom?: string }).zoom = '0.875';
    slot.appendChild(el);
  }

  async #mountFolderfooProfileCircle() {
    const slot = this.#findFolderfooSlot();
    // Bails when there's no toolbar yet or a circle is already mounted. <app-toolbar> is a single
    // persistent element (see render()), so in practice this only does real work once - but stays
    // defensive against being called more than once in a row (e.g. multiple renders before the
    // async work below settles) by finding/creating the circle synchronously wherever the CURRENT
    // slot is when its async work resolves, rather than trusting the slot instance captured here.
    if (!slot || slot.querySelector('folderfoo-profile-circle')) return;
    if (folderfooWidgetLoaded) {
      // Already imported once (module execution — including customElements.define — only happens
      // once per URL): mount synchronously, no async gap for a re-render to race past.
      this.#appendFolderfooCircle(slot);
      return;
    }
    if (slot.hasAttribute('data-ff-attempted')) return;
    slot.setAttribute('data-ff-attempted', '');
    const { folderfooMode, folderfooHost } = await getFolderfooConfig();
    if (folderfooMode === 'off' || !folderfooHost) return;
    import(/* @vite-ignore */ `${folderfooHost}/elements/folderfoo-profile-circle.js`)
      .then(async () => {
        folderfooWidgetLoaded = true;
        await this.updateComplete; // ensure app-toolbar's shadow root exists
        // The view may have switched (tearing down this exact <app-toolbar>/slot instance) one or
        // more times while the import above was in flight — re-look-up the CURRENTLY live slot
        // rather than trusting the one captured at the top of this call, which may be long gone.
        const liveSlot = this.#findFolderfooSlot();
        if (liveSlot && !liveSlot.querySelector('folderfoo-profile-circle')) this.#appendFolderfooCircle(liveSlot);
      })
      .catch((err) => {
        // Best-effort, matching every other consuming app's posture: the
        // rest of the page works fine without it if folderfoo is
        // unreachable, just no login widget appears.
        console.warn('folderfoo-profile-circle unavailable:', (err as Error).message);
      });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('focus', this.#boundOnFocus);
    document.removeEventListener('visibilitychange', this.#boundOnFocus);
    document.removeEventListener('folderfoo-file-open', this.#boundOnFolderfooFileOpen);
    document.removeEventListener('folderfoo-folder-changed', this.#boundOnFolderfooFolderChanged);
    window.removeEventListener('folderfoo-auth-change', this.#boundOnFolderfooAuthChange);
    this.#unsubscribeIdentity?.();
  }

  // folderfoo's own widget fires this window event on login, register,
  // logout, AND a failed token refresh (see auth-guard.js's
  // broadcastAuthChange) - it carries no payload, so the only way to tell
  // "logged in" from "logged out" is to check whether a token is still in
  // localStorage right after it fires. Real bug fixed here: a re-login via
  // the PAGE-LEVEL circle (#mountFolderfooProfileCircle) never opens
  // add-folder-modal.ts, so its #ffPersistToken flow (the only other place
  // that POSTs /api/folderfoo/login) never runs - the server's process-wide
  // identity stayed cleared even though the browser was logged back in,
  // permanently hiding already-connected remote folders after any logout/
  // login cycle that didn't happen to go through the modal. This handler
  // now POSTs /api/folderfoo/login itself whenever a token IS present,
  // covering the page-level circle's login the same way it already covers
  // its logout.
  async #onFolderfooAuthChange() {
    let token: string | null = null;
    try {
      token = localStorage.getItem('folderfoo_token');
    } catch {
      // localStorage unavailable - nothing to detect either way
      return;
    }
    if (!token) {
      fetch('/api/folderfoo/logout', { method: 'POST' }).catch(() => {
        // best-effort - the SSE stream will simply keep showing the last-known identity until a future call succeeds
      });
      return;
    }
    const { folderfooMode, folderfooHost } = await getFolderfooConfig();
    if (folderfooMode === 'off' || !folderfooHost) return; // no page-level widget was ever mounted - nothing to attribute this login to
    fetch('/api/folderfoo/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: folderfooHost, token }),
    }).catch(() => {
      // best-effort - the SSE stream will simply keep showing the last-known identity until a future call succeeds
    });
  }

  #resyncingOnFocus = false; // guards against overlapping resync-all calls when focus fires repeatedly (fast tab-switching)

  async #onFocus() {
    if (document.visibilityState !== 'visible') return;
    // Force-resyncs every remote source before refetching, so a change made
    // remotely (e.g. deleting a doc via folderfoo's own UI) shows up on
    // tab-focus instead of requiring the user to hit the rebuild-cache
    // button by hand and wait out the fixed poll interval. Only bothers
    // calling this when at least one remote folder is actually connected -
    // the common local-only case pays no extra round trip. Best-effort: a
    // failed resync (folderfoo unreachable, session expired) still lets the
    // normal local refetch below proceed, same "local always works" posture
    // remote failures have everywhere else in this app.
    if (this.#allFolders().some((f) => f.remote) && !this.#resyncingOnFocus) {
      this.#resyncingOnFocus = true;
      try {
        await fetch('/api/remote-folders/resync-all', { method: 'POST' });
      } catch {
        // best-effort - local refetch below still runs regardless
      } finally {
        this.#resyncingOnFocus = false;
      }
    }
    this.#refetch();
    this.#refetchFacets();
    this.#refetchFolders();
    (this.renderRoot.querySelector('detail-panel') as (Element & { refresh?: () => void }) | null)?.refresh?.();
  }

  async #refetch() {
    const query = this.#requestQuery.value;
    history.replaceState(null, '', query ? `#${query}` : location.pathname + location.search);
    const res = await fetch(`/api/entries?${query}`);
    this.#results.set((await res.json()) as Entry[]);
    this.renderRoot.querySelector('result-list')?.scrollTo(0, 0);
    // Folder View's tree-source dataset shares every filter #requestQuery builds from except
    // tag/folder (see #folderViewQuery) - keep it in sync with the same triggers that call
    // #refetch(), but only while Folder View is actually open, to avoid a wasted fetch otherwise.
    if (this.#view.value === 'folder-view') this.#refetchFolderViewEntries();
  }

  async #refetchFolderViewEntries() {
    const res = await fetch(`/api/entries?${this.#folderViewQuery.value}`);
    this.#folderViewEntries.set((await res.json()) as Entry[]);
  }

  async #refetchFacets() {
    const type = this.#typeFilter.value === 'all' ? '' : `?type=${this.#typeFilter.value}`;
    const res = await fetch(`/api/facets${type}`);
    this.#facets.set((await res.json()) as Facets);
  }

  async #refetchFolders() {
    const res = await fetch('/api/folders');
    const folders = (await res.json()) as FoldersResponse;
    this.#folders.set(folders);
    this.#foldersLoaded.set(true);
    // A folder can drop out of this list between refetches (identity change
    // hiding a remote folder on logout/login, or a local folder removed) -
    // an active selection referencing a name that's no longer here would
    // otherwise keep filtering the results list by a folder the user can no
    // longer see or control, silently showing an empty/stale result set.
    const names = new Set([...folders.skill, ...folders.memory].map((f) => f.name));
    const pruned = this.#activeFolders.value.filter((f) => names.has(f));
    if (pruned.length !== this.#activeFolders.value.length) {
      this.#activeFolders.set(pruned);
      this.#refetch();
    }
    // Same reasoning applies to the right-hand detail panel's open selection: if it's showing an
    // entry from a folder that just dropped out of the list, clear it rather than leaving stale
    // content on screen referencing a folder the user can no longer see or control.
    const selected = this.#selected.value;
    if (selected) {
      const entry = this.#entriesById().get(selected.id);
      if (entry && !names.has(entry.folder)) this.#selected.set(null);
    }
  }

  #setView(view: 'entries' | 'channels' | 'folder-view' | 'shared') {
    this.#view.set(view);
    if (view === 'channels') this.#refetchChannels();
    else if (view === 'folder-view') this.#refetchFolderViewEntries();
    // 'shared' loads whatever's CURRENTLY cached immediately (so the panel isn't blank while the
    // network round-trip below is in flight), then kicks off the same diff-against-folderfoo the
    // recycle-icon button does — opening the panel is the moment a user actually wants to know
    // "did anyone share something with me," and a direct (non-link) share has no other way to
    // surface here (see refreshSharedItems' own doc comment) — silently stale-by-default until a
    // manual click was surprising in practice, so this replaces that "explicit-only" posture.
    else if (view === 'shared') {
      this.#loadSharedItems();
      this.#refreshSharedItems();
    }
  }

  async #loadSharedItems() {
    const res = await fetch('/api/shared-items');
    this.#sharedItems.set(res.ok ? ((await res.json()) as SharedItemRow[]) : []);
  }

  async #refreshSharedItems() {
    this.#sharedRefreshing.set(true);
    try {
      const res = await fetch('/api/shared-items/refresh', { method: 'POST' });
      if (res.ok) this.#sharedRefreshSummary.set(await res.json());
      await this.#loadSharedItems();
    } finally {
      this.#sharedRefreshing.set(false);
    }
  }

  async #dismissSharedItem(originId: string) {
    await fetch(`/api/shared-items/${encodeURIComponent(originId)}`, { method: 'DELETE' });
    await this.#loadSharedItems();
  }

  #openSharedItem(item: SharedItemRow) {
    if (!item.entryId) return;
    this.#selected.set({ table: item.kind === 'skill' ? 'skills' : 'memory_docs', id: item.entryId });
    this.#setView('entries');
  }

  // Called by share-accept.ts once a redeemed share-link/public-link resolves to an item-level
  // share (Phase 3) — posts it into shared_items and switches straight into the "Shared with me"
  // panel so accepting a link feels the same as Bulletino force-opening a shared document, not a
  // silent background change the user has to go looking for.
  async #acceptSharedItem(entry: {
    owner: string;
    path: string;
    originId: string;
    kind: 'memory' | 'skill';
    role: 'member' | 'editor';
    server: string;
    tenantId: string;
  }) {
    const res = await fetch('/api/shared-items/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert((body as { error?: string }).error || 'Failed to accept the shared item.');
      return;
    }
    this.#setView('shared');
  }

  // Writes an independent copy of a shared item into a folder the user owns — see
  // POST /api/shared-items/:originId/fork's own doc comment for why this carries no ongoing
  // shared_items linkage afterward. Returns a result object (not throwing) since the panel shows
  // the outcome inline rather than via a toast/alert.
  async #forkSharedItem(item: SharedItemRow, folder: string): Promise<{ ok: boolean; message: string }> {
    const res = await fetch(`/api/shared-items/${encodeURIComponent(item.origin_id)}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: body.error || `Fork failed (${res.status}).` };
    await this.#refetch();
    return { ok: true, message: `Copied into "${folder}".` };
  }

  async #refetchChannels() {
    const res = await fetch('/api/channels');
    this.#channels.set((await res.json()) as ChannelSummary[]);
    // Keep an already-open channel's content in sync (e.g. after a manual refresh click).
    if (this.#selectedChannel.value) this.#selectChannel(this.#selectedChannel.value);
  }

  async #selectChannel(name: string) {
    this.#selectedChannel.set(name);
    this.#channelLoading.set(true);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(name)}`);
      this.#channelDetail.set(res.ok ? ((await res.json()) as ChannelDetail) : null);
    } finally {
      this.#channelLoading.set(false);
    }
  }

  #toggleFolder(name: string) {
    const current = this.#activeFolders.value;
    this.#activeFolders.set(current.includes(name) ? current.filter((f) => f !== name) : [...current, name]);
    this.#refetch();
  }

  async #removeFolder(folder: Folder, e: Event) {
    e.stopPropagation();
    const confirmed = window.prompt(`Type "${folder.name}" to remove this ${folder.kind} folder (files on disk are untouched):`);
    if (confirmed !== folder.name) return;
    this.#removingFolder.set(folder.name);
    try {
      await fetch(`/api/folders/${folder.kind}/${encodeURIComponent(folder.name)}`, { method: 'DELETE' });
      this.#activeFolders.set(this.#activeFolders.value.filter((f) => f !== folder.name));
      await Promise.all([this.#refetchFolders(), this.#refetchFacets(), this.#refetch()]);
    } finally {
      this.#removingFolder.set('');
    }
  }

  #onFolderAdded(warning?: string) {
    this.#showAddFolder.set(false);
    this.#refetchFolders();
    this.#refetchFacets();
    this.#refetch();
    // Best-effort "did you pick the wrong kind" heuristic from POST /api/remote-folders (see
    // routes.ts's detectKindMismatch) — a dismissible warning, not a block, since the connect
    // already succeeded and the folder is already usable either way.
    if (warning) alert(warning);
  }

  // Remote (folderfoo) folders sort after every local folder - they're the
  // ones whose membership can change out from under the user (identity
  // switches), so keeping them visually grouped at the end makes that
  // churn easier to track at a glance than if they were interleaved.
  #allFolders(): Folder[] {
    return [...this.#folders.value.skill, ...this.#folders.value.memory].sort(
      (a, b) => Number(a.remote) - Number(b.remote)
    );
  }

  #setType(type: TypeFilter) {
    this.#typeFilter.set(type);
    this.#activeTags.set([]); // tag vocabulary changes with type, stale selections wouldn't apply
    this.#refetchFacets();
    this.#refetch();
  }

  #toggleTag(tag: string) {
    const current = this.#activeTags.value;
    this.#activeTags.set(current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]);
    this.#refetch();
  }

  // Adds-only (never toggles off) — used when a tag/folder pill in the detail panel is clicked as a
  // shortcut to filter by it, which reads as "show me more like this," not an on/off control.
  #addTagFilter(tag: string) {
    if (!this.#activeTags.value.includes(tag)) this.#activeTags.set([...this.#activeTags.value, tag]);
    this.#refetch();
  }

  #addFolderFilter(name: string) {
    if (!this.#activeFolders.value.includes(name)) this.#activeFolders.set([...this.#activeFolders.value, name]);
    this.#refetch();
  }

  #setDateFilter(date: string) {
    this.#dateFrom.set(date);
    this.#dateTo.set(date);
    this.#refetch();
  }

  #onSearchInput(e: Event) {
    this.#query.set((e.target as HTMLInputElement).value);
    this.#refetch();
  }

  #setSearch(value: string) {
    this.#query.set(value);
    this.#refetch();
  }

  #clearSearch() {
    this.#query.set('');
    this.#refetch();
  }

  #onSelect(entry: Entry) {
    this.#selected.set({ table: entry._table, id: entry.id });
  }

  #onSortChange(e: Event) {
    this.#sort.set((e.target as HTMLSelectElement).value);
    this.#refetch();
  }

  #onDeprecatedFilterChange(e: Event) {
    this.#deprecatedFilter.set((e.target as HTMLSelectElement).value as TriState);
    this.#refetch();
  }

  #onPausedFilterChange(e: Event) {
    this.#pausedFilter.set((e.target as HTMLSelectElement).value as TriState);
    this.#refetch();
  }

  #onDateFromChange(e: Event) {
    this.#dateFrom.set((e.target as HTMLInputElement).value);
    this.#refetch();
  }

  #onDateToChange(e: Event) {
    this.#dateTo.set((e.target as HTMLInputElement).value);
    this.#refetch();
  }

  #clearDateRange() {
    this.#dateFrom.set('');
    this.#dateTo.set('');
    this.#refetch();
  }

  #onToggleSelect(entry: Entry) {
    const current = new Set(this.#selectedIds.value);
    if (current.has(entry.id)) current.delete(entry.id);
    else current.add(entry.id);
    this.#selectedIds.set(current);
  }

  #entriesById(): Map<string, Entry> {
    return new Map(this.#results.value.map((r) => [r.id, r]));
  }

  /** Bulk actions require a single table — group selected ids by table and act per-group. */
  #selectedByTable(): Map<'skills' | 'memory_docs', string[]> {
    const byTable = new Map<'skills' | 'memory_docs', string[]>();
    const entries = this.#entriesById();
    for (const id of this.#selectedIds.value) {
      const entry = entries.get(id);
      if (!entry) continue;
      const list = byTable.get(entry._table) ?? [];
      list.push(id);
      byTable.set(entry._table, list);
    }
    return byTable;
  }

  async #bulkSetDeprecated(deprecated: boolean) {
    const byTable = this.#selectedByTable();
    await Promise.all(
      [...byTable.entries()].map(([table, ids]) =>
        fetch(`/api/entries/${table}/bulk/deprecated`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, deprecated }),
        })
      )
    );
    this.#selectedIds.set(new Set());
    await this.#refetch();
  }

  async #bulkSetPaused(paused: boolean) {
    const byTable = this.#selectedByTable();
    await Promise.all(
      [...byTable.entries()].map(([table, ids]) =>
        fetch(`/api/entries/${table}/bulk/paused`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, paused }),
        })
      )
    );
    this.#selectedIds.set(new Set());
    await this.#refetch();
  }

  async #bulkDelete() {
    if (!window.confirm(`Delete ${this.#selectedIds.value.size} doc(s)? This can't be undone.`)) return;
    const byTable = this.#selectedByTable();
    await Promise.all(
      [...byTable.entries()].map(([table, ids]) =>
        fetch(`/api/entries/${table}/bulk/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
      )
    );
    this.#selectedIds.set(new Set());
    await this.#refetch();
  }

  // Rendered exactly once, at a fixed position in the top-level template (see render()) rather
  // than inline inside each mode branch - so <app-toolbar> is never one of several structurally
  // different html`` templates and Lit never tears it down/recreates it on a mode switch. That
  // matters beyond visual flicker: the folderfoo-profile-circle widget mounted into its
  // .folderfoo-slot (see #mountFolderfooProfileCircle) does real async work (module import,
  // config fetch) that a same-tick teardown/recreate cycle could otherwise race and lose.
  #renderToolbar() {
    const showReindex =
      this.#view.value !== 'channels' && this.#view.value !== 'shared' && this.#foldersLoaded.value && this.#allFolders().length > 0;
    // Gated on login OR having at least one already-accepted shared item — NOT login alone, unlike
    // remote folders. A public-link accept (role always 'member', see share-accept.ts) needs no
    // folderfoo login at all by design, so hiding the button whenever logged out would strand a
    // user who only ever accepted a public link with no way back into the panel that already has
    // their content in it.
    const showShared = currentIdentity.value.username !== null || this.#sharedItems.value.length > 0;
    return html`
      <app-toolbar
        .showReindex=${showReindex}
        .reindexing=${this.#reindexing.value}
        .channelsActive=${this.#view.value === 'channels'}
        .folderViewActive=${this.#view.value === 'folder-view'}
        .showShared=${showShared}
        .sharedActive=${this.#view.value === 'shared'}
        .theme=${this.#theme.value}
        .onReindex=${() => this.#reindex()}
        .onToggleChannels=${() => this.#setView(this.#view.value === 'channels' ? 'entries' : 'channels')}
        .onToggleFolderView=${() => this.#setView(this.#view.value === 'folder-view' ? 'entries' : 'folder-view')}
        .onToggleShared=${() => this.#setView(this.#view.value === 'shared' ? 'entries' : 'shared')}
        .onCycleTheme=${() => this.#cycleTheme()}
      ></app-toolbar>
    `;
  }

  updated() {
    // Runs after every render, not just the first: connectedCallback() fires before this
    // element's own first render, so <app-toolbar> (and its .folderfoo-slot) doesn't exist in
    // the DOM yet at that point - calling this from connectedCallback raced #findFolderfooSlot()
    // and lost every time. <app-toolbar> is now a single persistent element (see render()) that's
    // never torn down by a mode switch, so this is a one-time mount in practice; the
    // already-mounted guard inside #mountFolderfooProfileCircle() just makes repeat calls harmless.
    this.#mountFolderfooProfileCircle();
  }

  // <app-toolbar> lives here, outside #renderBody()'s mode branches, so it's always the same
  // element in the same DOM position no matter which mode is active - see #renderToolbar's
  // comment for why that matters beyond visual flicker. `.header-toolbar` positions it to line up
  // visually with each mode's own header row (folders-bar / toolbar-bar / folder-view's mode-row),
  // which all share the same height and padding (see their CSS).
  render() {
    return html` <div class="header-toolbar">${this.#renderToolbar()}</div>${this.#renderBody()} `;
  }

  #renderBody() {
    const facets = this.#facets.value;
    const allFolders = this.#allFolders();

    if (this.#view.value === 'shared') {
      return html`
        <div class="toolbar-bar"></div>
        <shared-with-me-panel
          .items=${this.#sharedItems.value}
          .refreshing=${this.#sharedRefreshing.value}
          .lastRefreshSummary=${this.#sharedRefreshSummary.value}
          .memoryFolderNames=${this.#folders.value.memory.map((f) => f.name)}
          .skillFolderNames=${this.#folders.value.skill.map((f) => f.name)}
          .onRefresh=${() => this.#refreshSharedItems()}
          .onDismiss=${(originId: string) => this.#dismissSharedItem(originId)}
          .onOpen=${(item: SharedItemRow) => this.#openSharedItem(item)}
          .onFork=${(item: SharedItemRow, folder: string) => this.#forkSharedItem(item, folder)}
        ></shared-with-me-panel>
      `;
    }

    if (this.#view.value === 'channels') {
      return html`
        <div class="toolbar-bar"></div>
        <channel-view
          .channels=${this.#channels.value}
          .selected=${this.#selectedChannel.value}
          .detail=${this.#channelDetail.value}
          .loading=${this.#channelLoading.value}
          .onSelect=${(name: string) => this.#selectChannel(name)}
          .onRefresh=${() => this.#refetchChannels()}
        ></channel-view>
      `;
    }

    if (this.#view.value === 'folder-view') {
      return html`
        <folder-view
          .entries=${this.#folderViewEntries.value}
          .allFolders=${allFolders}
          .facets=${facets}
          .typeFilter=${this.#typeFilter.value}
          .onTypeChange=${(t: TypeFilter) => this.#setType(t)}
          .onChanged=${() => {
            this.#refetch();
            this.#refetchFacets();
          }}
          .onDateClick=${(d: string) => this.#setDateFilter(d)}
          .onKeyClick=${(key: string) => this.#setSearch(key)}
        ></folder-view>
      `;
    }

    if (this.#foldersLoaded.value && allFolders.length === 0 && !this.#showAddFolder.value) {
      return html`
        <div class="toolbar-bar"></div>
        <div class="first-run">
          <h1>No folders configured yet</h1>
          <p>
            Add a folder of skills or memory docs to get started. You can add more folders later —
            e.g. a personal skills repo plus a shared company repo.
          </p>
          <button class="add-folder-btn" @click=${() => this.#showAddFolder.set(true)}>+ Add your first folder</button>
        </div>
        ${this.#showAddFolder.value
          ? html`<add-folder-modal
              .defaultKind=${'skill'}
              .lockKind=${false}
              .onAdded=${(warning?: string) => this.#onFolderAdded(warning)}
              .onCancel=${() => this.#showAddFolder.set(false)}
            ></add-folder-modal>`
          : ''}
      `;
    }

    return html`
      <div class="folders-bar">
        <span class="filter-label">Folders:</span>
        <div class="folder-chips">
          ${allFolders.map(
            (folder) => html`
              <button
                class="folder-chip ${folder.remote ? 'remote' : ''} ${this.#activeFolders.value.includes(folder.name) ? 'active' : ''}"
                title=${folder.remote ? `${folder.path} (remote — folderfoo)` : folder.path}
                @click=${() => this.#toggleFolder(folder.name)}
              >
                ${folder.remote ? html`<span class="remote-dot"></span>` : '📁'} ${folder.name}
                <span class="kind">(${folder.kind === 'skill' ? 's' : 'm'})</span>
                <span
                  class="remove"
                  title="Remove folder"
                  @click=${(e: Event) => this.#removeFolder(folder, e)}
                >${this.#removingFolder.value === folder.name ? '…' : '✕'}</span
                >
              </button>
            `
          )}
          <button class="add-folder-btn" @click=${() => this.#showAddFolder.set(true)}>+ Add folder</button>
        </div>
      </div>
      ${this.#folderfooOpenStatus.value
        ? html`
            <div class="folderfoo-open-banner">
              ${this.#folderfooOpenStatus.value}
              <button class="dismiss" @click=${() => this.#folderfooOpenStatus.set('')}>✕</button>
            </div>
          `
        : ''}
      <div class="filters">
        <div class="row search-row">
          <div class="search-field">
            <input
              type="search"
              placeholder="Search descriptions, bodies, tags..."
              .value=${this.#query.value}
              @input=${(e: Event) => this.#onSearchInput(e)}
            />
            ${this.#query.value
              ? html`
                  <button
                    class="search-clear-btn"
                    title="Clear search"
                    aria-label="Clear search"
                    @click=${() => this.#clearSearch()}
                  >
                    ✕
                  </button>
                `
              : ''}
          </div>
          <div class="row type-toggle">
            ${TYPE_OPTIONS.map(
              (opt) => html`
                <button
                  class=${this.#typeFilter.value === opt.value ? 'active' : ''}
                  @click=${() => this.#setType(opt.value)}
                >
                  ${opt.label}
                </button>
              `
            )}
          </div>
          ${facets.tags.length === 0
            ? html`<span class="filter-label">Tags:</span> <label class="small">no tags yet</label>`
            : html`
                <tag-multiselect
                  .tags=${facets.tags}
                  .active=${this.#activeTags.value}
                  .onToggle=${(tag: string) => this.#toggleTag(tag)}
                  .width=${'260px'}
                ></tag-multiselect>
              `}
          <span class="filter-label">Dates:</span>
          <div class="date-range">
            <input
              type="date"
              aria-label="From date"
              .value=${this.#dateFrom.value}
              @change=${(e: Event) => this.#onDateFromChange(e)}
            />
            <span class="date-range-sep">–</span>
            <input
              type="date"
              aria-label="To date"
              .value=${this.#dateTo.value}
              @change=${(e: Event) => this.#onDateToChange(e)}
            />
            ${this.#dateFrom.value || this.#dateTo.value
              ? html`
                  <button
                    class="date-range-clear"
                    title="Clear date range"
                    aria-label="Clear date range"
                    @click=${() => this.#clearDateRange()}
                  >
                    ✕
                  </button>
                `
              : ''}
          </div>
          <span class="filter-label">Sort:</span>
          <select
            .value=${this.#sort.value || (this.#query.value.trim() ? 'relevance' : 'mtime_desc')}
            @change=${(e: Event) => this.#onSortChange(e)}
          >
            ${this.#query.value.trim() ? html`<option value="relevance">Relevance</option>` : ''}
            <option value="mtime_desc">Recently touched</option>
            <option value="mtime_asc">Least recently touched</option>
            <option value="created_at_asc">Oldest first</option>
            <option value="name_asc">Name</option>
          </select>
          <span class="filter-label">Deprecated:</span>
          <select .value=${this.#deprecatedFilter.value} @change=${(e: Event) => this.#onDeprecatedFilterChange(e)}>
            ${TRISTATE_OPTIONS.map((opt) => html`<option value=${opt.value}>${opt.label}</option>`)}
          </select>
          <span class="filter-label">Paused:</span>
          <select .value=${this.#pausedFilter.value} @change=${(e: Event) => this.#onPausedFilterChange(e)}>
            ${TRISTATE_OPTIONS.map((opt) => html`<option value=${opt.value}>${opt.label}</option>`)}
          </select>
        </div>
      </div>
      ${this.#selectedIds.value.size > 0
        ? html`
            <div class="bulk-bar">
              <span>${this.#selectedIds.value.size} selected</span>
              <button @click=${() => this.#bulkSetDeprecated(true)}>Mark deprecated</button>
              <button @click=${() => this.#bulkSetDeprecated(false)}>Un-deprecate</button>
              <button @click=${() => this.#bulkSetPaused(true)}>Pause</button>
              <button @click=${() => this.#bulkSetPaused(false)}>Resume</button>
              <button class="danger" @click=${() => this.#bulkDelete()}>Delete</button>
              <button @click=${() => this.#selectedIds.set(new Set())}>Clear</button>
            </div>
          `
        : ''}
      <div class="body-region">
        <result-list
          style=${`width: ${this.#splitPct.value}%; border-right: 1px solid var(--border);`}
          .results=${this.#results.value}
          .showFolder=${allFolders.length > 1}
          .onSelect=${(e: Entry) => this.#onSelect(e)}
          .selectedIds=${this.#selectedIds.value}
          .onToggleSelect=${(e: Entry) => this.#onToggleSelect(e)}
          .onKeyClick=${(key: string) => this.#setSearch(key)}
        ></result-list>
        <div
          class="splitter ${this.#dragging.value ? 'dragging' : ''}"
          @pointerdown=${(e: PointerEvent) => this.#onDragStart(e)}
        ></div>
        <detail-panel
          .selected=${this.#selected.value}
          .facets=${facets}
          .onChanged=${() => {
            this.#refetch();
            this.#refetchFacets();
          }}
          .onTagClick=${(t: string) => this.#addTagFilter(t)}
          .onFolderClick=${(f: string) => this.#addFolderFilter(f)}
          .onDateClick=${(d: string) => this.#setDateFilter(d)}
          .onKeyClick=${(key: string) => this.#setSearch(key)}
          .onGone=${() => this.#selected.set(null)}
        ></detail-panel>
      </div>
      ${this.#showAddFolder.value
        ? html`<add-folder-modal
            .defaultKind=${'skill'}
            .lockKind=${false}
            .onAdded=${(warning?: string) => this.#onFolderAdded(warning)}
            .onCancel=${() => this.#showAddFolder.set(false)}
          ></add-folder-modal>`
        : ''}
    `;
  }
}

customElements.define('mem-bucket-app', MemBucketApp);
