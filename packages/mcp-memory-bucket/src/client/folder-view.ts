import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import './result-list.js';
import './detail-panel.js';
import type { Entry, Folder, Selection, Facets, TypeFilter } from './types.js';
import { groupByFolder, groupByTag, type FolderNode, type FolderSections, type TagNode } from './folder-view-aggregate.js';

type Mode = 'a' | 'b' | 'c';

const MODE_STORAGE_KEY = 'mem-bucket-folder-view-mode';
const EXPANDED_STORAGE_KEY = 'mem-bucket-folder-view-expanded';
const TREE_SPLIT_STORAGE_KEY = 'mem-bucket-folder-view-tree-split-pct';
const LIST_SPLIT_STORAGE_KEY = 'mem-bucket-folder-view-list-split-pct';
const TREE_SPLIT_MIN_PCT = 12;
const TREE_SPLIT_MAX_PCT = 40;
const LIST_SPLIT_MIN_PCT = 20;
const LIST_SPLIT_MAX_PCT = 80;

function loadSplitPct(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
}

const TYPE_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'skill', label: 'Skills' },
  { value: 'memory', label: 'Memories' },
];

const MODE_OPTIONS: Array<{ value: Mode; label: string }> = [
  { value: 'a', label: 'Folder tree' },
  { value: 'b', label: 'Breadcrumb drill-down' },
  { value: 'c', label: 'Tag → Name' },
];

function loadMode(): Mode {
  const raw = localStorage.getItem(MODE_STORAGE_KEY);
  return raw === 'a' || raw === 'b' || raw === 'c' ? raw : 'a';
}

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function saveExpanded(set: Set<string>) {
  localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...set]));
}

/** What the middle result-list pane is scoped to — set by clicking a folder or tag NODE (not a leaf
 * item). null means no list scope is active, so the middle pane is hidden entirely. `folder: null`
 * means a cross-folder tag scope (mode C's flat Tag → Name list has no folder level at all). */
interface ListScope {
  folder: string | null;
  tag: string | null; // null = whole folder, not narrowed to one tag
}

export class FolderView extends LitElement {
  static properties = {
    entries: { attribute: false },
    allFolders: { attribute: false },
    facets: { attribute: false },
    typeFilter: { attribute: false },
    onTypeChange: { attribute: false },
    onChanged: { attribute: false },
    onDateClick: { attribute: false },
    onKeyClick: { attribute: false },
  };

  declare entries: Entry[]; // unfiltered-by-folder/tag source for the tree (see mem-bucket-app.ts's #folderViewEntries)
  declare allFolders: Folder[];
  declare facets: Facets;
  declare typeFilter: TypeFilter;
  declare onTypeChange: (type: TypeFilter) => void;
  declare onChanged: (() => void) | undefined;
  declare onDateClick: ((date: string) => void) | undefined;
  declare onKeyClick: ((key: string) => void) | undefined;

  #mode = new Signal<Mode>(loadMode());
  #expanded = new Signal<Set<string>>(loadExpanded());
  #breadcrumbPath = new Signal<string[]>([]); // mode B: sequence of folder names drilled into (currently 0 or 1 deep)
  // Folder View's own navigation state — deliberately NOT the shared activeFolders/activeTags/
  // selected signals in mem-bucket-app.ts, so browsing here never disturbs the flat Filters view
  // (and vice versa). Only the broader query scope (typeFilter, search, dates, ...) is shared.
  #listScope = new Signal<ListScope | null>(null);
  #localSelected = new Signal<Selection | null>(null);
  // Two independent splitters over .body-region's width: tree-rail's own % (of the whole region),
  // and result-list's % of the space remaining after the tree-rail — detail-panel takes the rest.
  #treeSplitPct = new Signal<number>(loadSplitPct(TREE_SPLIT_STORAGE_KEY, 20, TREE_SPLIT_MIN_PCT, TREE_SPLIT_MAX_PCT));
  #listSplitPct = new Signal<number>(loadSplitPct(LIST_SPLIT_STORAGE_KEY, 40, LIST_SPLIT_MIN_PCT, LIST_SPLIT_MAX_PCT));
  #draggingSplitter = new Signal<'tree' | 'list' | null>(null);

  #boundOnDragMove = (e: PointerEvent) => this.#onDragMove(e);
  #boundOnDragEnd = () => this.#onDragEnd();

  static styles = css`
    :host { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
    /* padding-right reserves room for mem-bucket-app's absolutely-positioned .header-toolbar
       overlay (rendered outside this element entirely - see its own comment), which lines up with
       this row's top-right corner via matching padding. */
    .mode-row {
      display: flex; align-items: center; gap: 8px; padding: 10px 320px 10px 16px;
      border-bottom: 1px solid var(--border); background: var(--bg-subtle);
    }
    .mode-row .filter-label { font-size: 12px; opacity: 0.6; font-weight: 600; }
    .mode-row select {
      font-size: 13px; padding: 6px 8px; height: 30px; box-sizing: border-box;
      border: 1px solid var(--border-strong); border-radius: 6px; background: none; color: inherit;
    }
    .type-toggle { display: flex; gap: 0; }
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
    .tree-rail { flex: 0 0 auto; overflow-y: auto; padding: 8px 0; box-sizing: border-box; }
    result-list { flex: 0 0 auto; overflow-y: auto; box-sizing: border-box; }
    detail-panel { flex: 1 1 auto; min-width: 0; overflow-y: auto; }
    .no-selection {
      flex: 1 1 auto; display: flex; align-items: center; justify-content: center;
      opacity: 0.5; font-size: 13px;
    }
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
    .section-header {
      padding: 8px 14px 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; opacity: 0.55;
    }
    .node {
      display: flex; align-items: center; gap: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px;
      border: none; background: none; color: inherit; width: 100%; text-align: left; box-sizing: border-box;
    }
    .node:hover { background: var(--hover); }
    .node.active { background: var(--accent-tint); }
    .node .caret { width: 12px; flex: 0 0 auto; opacity: 0.6; font-size: 10px; }
    .node .icon { flex: 0 0 auto; }
    .node .label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .node .count { flex: 0 0 auto; opacity: 0.5; font-size: 11px; }
    .node.remote .icon { color: var(--accent); }
    .indent-1 { padding-left: 30px; }
    .indent-2 { padding-left: 46px; }
    .empty { padding: 24px; opacity: 0.6; font-size: 13px; }
    .breadcrumb-bar { display: flex; align-items: center; gap: 6px; padding: 8px 14px; font-size: 13px; }
    .breadcrumb-bar button {
      background: none; border: none; color: inherit; cursor: pointer; padding: 2px 4px;
      text-decoration: underline; text-underline-offset: 2px; font: inherit;
    }
    .breadcrumb-sep { opacity: 0.5; }
    .folder-card {
      display: flex; align-items: center; gap: 8px; padding: 8px 14px; cursor: pointer; font-size: 13px;
      border: none; background: none; color: inherit; width: 100%; text-align: left; box-sizing: border-box;
    }
    .folder-card:hover { background: var(--hover); }
  `;

  constructor() {
    super();
    new SignalWatcher(this);
  }

  #setMode(mode: Mode) {
    this.#mode.set(mode);
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    // Mode switch always resets to a fresh top-level view — no per-mode remembered position.
    this.#expanded.set(new Set());
    saveExpanded(new Set());
    this.#breadcrumbPath.set([]);
    this.#listScope.set(null);
    this.#localSelected.set(null);
  }

  #onModeChange(e: Event) {
    this.#setMode((e.target as HTMLSelectElement).value as Mode);
  }

  #onDragStart(which: 'tree' | 'list', e: PointerEvent) {
    e.preventDefault();
    this.#draggingSplitter.set(which);
    document.addEventListener('pointermove', this.#boundOnDragMove);
    document.addEventListener('pointerup', this.#boundOnDragEnd);
  }

  #onDragMove(e: PointerEvent) {
    const which = this.#draggingSplitter.value;
    if (!which) return;
    const region = this.renderRoot.querySelector('.body-region') as HTMLElement | null;
    if (!region) return;
    const rect = region.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    if (which === 'tree') {
      this.#treeSplitPct.set(Math.min(TREE_SPLIT_MAX_PCT, Math.max(TREE_SPLIT_MIN_PCT, pct)));
    } else {
      // list splitter's stored pct is relative to the space remaining after the tree rail.
      const remaining = 100 - this.#treeSplitPct.value;
      const pctOfRemaining = remaining > 0 ? ((pct - this.#treeSplitPct.value) / remaining) * 100 : 0;
      this.#listSplitPct.set(Math.min(LIST_SPLIT_MAX_PCT, Math.max(LIST_SPLIT_MIN_PCT, pctOfRemaining)));
    }
  }

  #onDragEnd() {
    const which = this.#draggingSplitter.value;
    this.#draggingSplitter.set(null);
    document.removeEventListener('pointermove', this.#boundOnDragMove);
    document.removeEventListener('pointerup', this.#boundOnDragEnd);
    if (which === 'tree') localStorage.setItem(TREE_SPLIT_STORAGE_KEY, String(this.#treeSplitPct.value));
    else if (which === 'list') localStorage.setItem(LIST_SPLIT_STORAGE_KEY, String(this.#listSplitPct.value));
  }

  #toggleExpanded(path: string) {
    const next = new Set(this.#expanded.value);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.#expanded.set(next);
    saveExpanded(next);
  }

  // Folder/tag NODE click: opens (or narrows) the middle result-list scope, does not touch the
  // right-pane selection — a node represents a list of files, not one file.
  #onNodeClick(folder: string | null, tag: string | null) {
    this.#listScope.set({ folder, tag });
  }

  // Leaf ITEM click directly in the tree (mode A/B's flat item rows, or mode C's tag-expanded
  // rows): opens the item in the right-pane detail-panel AND closes the middle result-list, since
  // clicking a specific file in the tree is a "just show me this one file" action, not a list.
  #onTreeLeafClick(entry: Entry) {
    this.#listScope.set(null);
    this.#localSelected.set({ table: entry._table, id: entry.id });
  }

  // Leaf ITEM click from inside the middle result-list (which is already scoped to a folder/tag):
  // opens the item on the right but leaves the list open, since you're browsing that list and may
  // want to open another item from it next.
  #onListLeafClick(entry: Entry) {
    this.#localSelected.set({ table: entry._table, id: entry.id });
  }

  #renderFolderRow(node: FolderNode, path: string) {
    const expanded = this.#expanded.value.has(path);
    const count = node.tagGroups.reduce((n, g) => n + g.items.length, 0);
    const active = this.#listScope.value?.folder === node.folder.name && this.#listScope.value?.tag === null;
    return html`
      <button class="node ${node.folder.remote ? 'remote' : ''} ${active ? 'active' : ''}" @click=${() => this.#toggleExpanded(path)}>
        <span class="caret">${expanded ? '▾' : '▸'}</span>
        <span class="icon">${node.folder.remote ? '☁' : '📁'}</span>
        <span
          class="label"
          @click=${(e: Event) => {
            e.stopPropagation();
            this.#onNodeClick(node.folder.name, null);
          }}
          >${node.folder.name}</span
        >
        <span class="count">${count}</span>
      </button>
    `;
  }

  // Design A: folder rows only, click expands to reveal a flat item list under it.
  #renderModeA(sections: FolderSections) {
    const renderGroup = (nodes: FolderNode[], label: string) => {
      if (nodes.length === 0) return '';
      return html`
        <div class="section-header">${label}</div>
        ${nodes.map((node) => {
          const path = `folder:${node.folder.name}`;
          const expanded = this.#expanded.value.has(path);
          const items = node.tagGroups[0]?.items ?? [];
          return html`
            ${this.#renderFolderRow(node, path)}
            ${expanded
              ? items.map(
                  (item) => html`
                    <button class="node indent-1" @click=${() => this.#onTreeLeafClick(item)}>
                      <span class="caret"></span>
                      <span class="icon">${item._table === 'skills' ? '⚡' : '📝'}</span>
                      <span class="label">${item.name}</span>
                    </button>
                  `
                )
              : ''}
          `;
        })}
      `;
    };
    return sections.local.length === 0 && sections.remote.length === 0
      ? html`<div class="empty">No entries.</div>`
      : html`${renderGroup(sections.local, 'Folders')}${renderGroup(sections.remote, 'Remote')}`;
  }

  // Design B: breadcrumb drill-down — top-level folder cards, or the entries inside a chosen folder.
  #renderModeB(sections: FolderSections) {
    const path = this.#breadcrumbPath.value;
    if (path.length === 0) {
      const allNodes = [...sections.local, ...sections.remote];
      return allNodes.length === 0
        ? html`<div class="empty">No entries.</div>`
        : allNodes.map((node) => {
            const count = node.tagGroups.reduce((n, g) => n + g.items.length, 0);
            return html`
              <button
                class="folder-card ${node.folder.remote ? 'remote' : ''}"
                @click=${() => this.#breadcrumbPath.set([node.folder.name])}
              >
                <span class="icon">${node.folder.remote ? '☁' : '📁'}</span>
                <span class="label">${node.folder.name}</span>
                <span class="count">${count}</span>
              </button>
            `;
          });
    }
    const folderName = path[0]!;
    const node = [...sections.local, ...sections.remote].find((n) => n.folder.name === folderName);
    const items = node?.tagGroups[0]?.items ?? [];
    return html`
      <div class="breadcrumb-bar">
        <button @click=${() => this.#breadcrumbPath.set([])}>🏠 Folders</button>
        <span class="breadcrumb-sep">›</span>
        <span>${folderName}</span>
      </div>
      ${items.length === 0
        ? html`<div class="empty">No entries in this folder.</div>`
        : items.map(
            (item) => html`
              <button class="node" @click=${() => this.#onTreeLeafClick(item)}>
                <span class="caret"></span>
                <span class="icon">${item._table === 'skills' ? '⚡' : '📝'}</span>
                <span class="label">${item.name}</span>
              </button>
            `
          )}
    `;
  }

  // Design C: Tag -> Name, flat and cross-folder — an item with N tags appears under every one of
  // its tags regardless of which folder it's in, so browsing by tag isn't scoped to one folder.
  #renderModeC(tagGroups: TagNode[]) {
    if (tagGroups.length === 0) return html`<div class="empty">No entries.</div>`;
    return tagGroups.map((group) => {
      const tagPath = `tag:${group.tag ?? ''}`;
      const tagExpanded = this.#expanded.value.has(tagPath);
      const active = this.#listScope.value?.folder === null && this.#listScope.value?.tag === group.tag;
      return html`
        <button class="node ${active ? 'active' : ''}" @click=${() => this.#toggleExpanded(tagPath)}>
          <span class="caret">${tagExpanded ? '▾' : '▸'}</span>
          <span class="icon">${group.tag === null ? '' : '🏷'}</span>
          <span
            class="label"
            @click=${(e: Event) => {
              e.stopPropagation();
              this.#onNodeClick(null, group.tag);
            }}
            >${group.tag ?? '(untagged)'}</span
          >
          <span class="count">${group.items.length}</span>
        </button>
        ${tagExpanded
          ? group.items.map(
              (item) => html`
                <button class="node indent-1" @click=${() => this.#onTreeLeafClick(item)}>
                  <span class="caret"></span>
                  <span class="icon">${item._table === 'skills' ? '⚡' : '📝'}</span>
                  <span class="label">${item.name}</span>
                  <span class="count">${item.folder}</span>
                </button>
              `
            )
          : ''}
      `;
    });
  }

  // The middle result-list pane's dataset: entries in #entries matching the active #listScope
  // (folder, and tag if one was picked) — computed client-side from the same tree-source data,
  // no extra fetch needed.
  #listEntries(): Entry[] {
    const scope = this.#listScope.value;
    if (!scope) return [];
    const entries = this.entries ?? [];
    return entries.filter(
      (e) => (scope.folder === null || e.folder === scope.folder) && (scope.tag === null || e.tags.includes(scope.tag))
    );
  }

  render() {
    const mode = this.#mode.value;
    const entries = this.entries ?? [];
    const allFolders = this.allFolders ?? [];
    // Mode C is flat and cross-folder (Tag -> Name, no folder level), so it uses its own
    // aggregation entirely separate from A/B's folder-scoped FolderSections.
    const sections = mode === 'c' ? null : groupByFolder(entries, allFolders);
    const tagGroups = mode === 'c' ? groupByTag(entries) : null;
    const listScope = this.#listScope.value;
    const localSelected = this.#localSelected.value;

    return html`
      <div class="mode-row">
        <span class="filter-label">View:</span>
        <select .value=${mode} @change=${(e: Event) => this.#onModeChange(e)}>
          ${MODE_OPTIONS.map((opt) => html`<option value=${opt.value}>${opt.label}</option>`)}
        </select>
        <div class="type-toggle">
          ${TYPE_OPTIONS.map(
            (opt) => html`
              <button
                class=${this.typeFilter === opt.value ? 'active' : ''}
                @click=${() => this.onTypeChange(opt.value)}
              >
                ${opt.label}
              </button>
            `
          )}
        </div>
      </div>
      <div class="body-region">
        <div
          class="tree-rail"
          style=${`width: ${this.#treeSplitPct.value}%; border-right: 1px solid var(--border);`}
        >
          ${mode === 'a' ? this.#renderModeA(sections!) : mode === 'b' ? this.#renderModeB(sections!) : this.#renderModeC(tagGroups!)}
        </div>
        ${listScope
          ? html`
              <div
                class="splitter ${this.#draggingSplitter.value === 'tree' ? 'dragging' : ''}"
                @pointerdown=${(e: PointerEvent) => this.#onDragStart('tree', e)}
              ></div>
              <result-list
                style=${`width: ${this.#listSplitPct.value}%; border-right: 1px solid var(--border);`}
                .results=${this.#listEntries()}
                .showFolder=${true}
                .onSelect=${(e: Entry) => this.#onListLeafClick(e)}
                .selectedIds=${new Set<string>()}
                .onToggleSelect=${() => {}}
                .onKeyClick=${this.onKeyClick}
              ></result-list>
              <div
                class="splitter ${this.#draggingSplitter.value === 'list' ? 'dragging' : ''}"
                @pointerdown=${(e: PointerEvent) => this.#onDragStart('list', e)}
              ></div>
            `
          : html`
              <div
                class="splitter ${this.#draggingSplitter.value === 'tree' ? 'dragging' : ''}"
                @pointerdown=${(e: PointerEvent) => this.#onDragStart('tree', e)}
              ></div>
            `}
        ${localSelected
          ? html`
              <detail-panel
                .selected=${localSelected}
                .facets=${this.facets}
                .onChanged=${this.onChanged}
                .onTagClick=${() => {}}
                .onFolderClick=${() => {}}
                .onDateClick=${this.onDateClick}
                .onKeyClick=${this.onKeyClick}
              ></detail-panel>
            `
          : html`<div class="no-selection">Select an item to view it.</div>`}
      </div>
    `;
  }
}

customElements.define('folder-view', FolderView);
