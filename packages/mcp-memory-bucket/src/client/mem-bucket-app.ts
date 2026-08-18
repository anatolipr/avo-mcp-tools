import { LitElement, html, css } from 'lit';
import { Signal, Computed, SignalWatcher } from 'avosignals';

import './result-list.js';
import './detail-panel.js';
import './add-root-modal.js';
import './tag-multiselect.js';
import type { Entry, Facets, Selection, TypeFilter, RootsResponse, Root } from './types.js';

const TYPE_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'skill', label: 'Skills' },
  { value: 'memory', label: 'Memories' },
];

const EMPTY_FACETS: Facets = { tags: [], statuses: [], owners: [], doc_types: [], key_types: [], roots: [] };
const EMPTY_ROOTS: RootsResponse = { skill: [], memory: [] };

const SPLIT_STORAGE_KEY = 'mem-bucket-split-pct';
const SPLIT_MIN_PCT = 20;
const SPLIT_MAX_PCT = 80;

function loadSplitPct(): number {
  const raw = Number(localStorage.getItem(SPLIT_STORAGE_KEY));
  return Number.isFinite(raw) && raw >= SPLIT_MIN_PCT && raw <= SPLIT_MAX_PCT ? raw : 40;
}

export class MemBucketApp extends LitElement {
  static styles = css`
    :host { display: block; height: 100vh; }
    .filters {
      padding: 12px 16px;
      border-bottom: 1px solid #8883;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .filters input[type='search'] {
      font-size: 14px;
      padding: 8px 10px;
      width: 100%;
      max-width: 480px;
      box-sizing: border-box;
    }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .filter-label { font-size: 12px; opacity: 0.6; font-weight: 600; }
    .type-toggle button {
      border: 1px solid #8886;
      background: none;
      color: inherit;
      padding: 5px 12px;
      font-size: 13px;
      cursor: pointer;
    }
    .type-toggle button.active { background: #2563eb; border-color: #2563eb; color: white; }
    .type-toggle button:first-child { border-radius: 6px 0 0 6px; }
    .type-toggle button:last-child { border-radius: 0 6px 6px 0; }
    .body-region { display: flex; height: calc(100vh - 130px); }
    result-list { overflow-y: auto; flex: 0 0 auto; }
    detail-panel { overflow-y: auto; flex: 1 1 auto; min-width: 0; }
    .splitter {
      flex: 0 0 auto;
      width: 6px;
      cursor: col-resize;
      background: #8882;
      position: relative;
    }
    .splitter:hover, .splitter.dragging { background: #2563eb55; }
    .splitter::after {
      content: '';
      position: absolute;
      top: 0; bottom: 0;
      left: -3px; right: -3px;
    }
    label.small { font-size: 12px; opacity: 0.7; }
    .roots-bar {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      padding: 10px 16px;
      border-bottom: 1px solid #8883;
      background: #8881a;
    }
    .root-chip {
      border: 1px solid #8886; border-radius: 999px; padding: 3px 8px 3px 10px; font-size: 12px;
      cursor: pointer; background: none; color: inherit; display: inline-flex; align-items: center; gap: 6px;
    }
    .root-chip.active { background: #a78bfa33; border-color: #a78bfa; color: #6d28d9; }
    @media (prefers-color-scheme: dark) {
      .root-chip.active { background: #a78bfa33; border-color: #a78bfa; color: #d8caff; }
    }
    .root-chip .remove {
      opacity: 0.6; font-size: 12px; line-height: 1; padding: 2px; border-radius: 50%;
    }
    .root-chip .remove:hover { opacity: 1; background: #0002; }
    .add-root-btn {
      border: 1px dashed #8886; border-radius: 999px; padding: 3px 10px; font-size: 12px;
      cursor: pointer; background: none; color: inherit; opacity: 0.75;
    }
    .add-root-btn:hover { opacity: 1; }
    .first-run {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100vh; gap: 16px; text-align: center; padding: 24px;
    }
    .first-run h1 { font-size: 18px; margin: 0; }
    .first-run p { opacity: 0.7; font-size: 13px; max-width: 420px; margin: 0; }
  `;

  #query = new Signal('');
  #typeFilter = new Signal<TypeFilter>('all');
  #activeTags = new Signal<string[]>([]);
  #activeRoots = new Signal<string[]>([]);
  #results = new Signal<Entry[]>([]);
  #facets = new Signal<Facets>(EMPTY_FACETS);
  #selected = new Signal<Selection | null>(null);
  #roots = new Signal<RootsResponse>(EMPTY_ROOTS);
  #showAddRoot = new Signal<boolean>(false);
  #removingRoot = new Signal<string>('');
  #rootsLoaded = new Signal<boolean>(false);
  #splitPct = new Signal<number>(loadSplitPct());
  #dragging = new Signal<boolean>(false);

  #boundOnDragMove = (e: PointerEvent) => this.#onDragMove(e);
  #boundOnDragEnd = () => this.#onDragEnd();

  constructor() {
    super();
    new SignalWatcher(this);
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
    for (const root of this.#activeRoots.value) params.append('root', root);
    return params.toString();
  });

  connectedCallback() {
    super.connectedCallback();
    this.#refetch();
    this.#refetchFacets();
    this.#refetchRoots();
  }

  async #refetch() {
    const res = await fetch(`/api/entries?${this.#requestQuery.value}`);
    this.#results.set((await res.json()) as Entry[]);
  }

  async #refetchFacets() {
    const type = this.#typeFilter.value === 'all' ? '' : `?type=${this.#typeFilter.value}`;
    const res = await fetch(`/api/facets${type}`);
    this.#facets.set((await res.json()) as Facets);
  }

  async #refetchRoots() {
    const res = await fetch('/api/roots');
    this.#roots.set((await res.json()) as RootsResponse);
    this.#rootsLoaded.set(true);
  }

  #toggleRoot(name: string) {
    const current = this.#activeRoots.value;
    this.#activeRoots.set(current.includes(name) ? current.filter((r) => r !== name) : [...current, name]);
    this.#refetch();
  }

  async #removeRoot(root: Root, e: Event) {
    e.stopPropagation();
    const confirmed = window.prompt(`Type "${root.name}" to remove this ${root.kind} root (files on disk are untouched):`);
    if (confirmed !== root.name) return;
    this.#removingRoot.set(root.name);
    try {
      await fetch(`/api/roots/${root.kind}/${encodeURIComponent(root.name)}`, { method: 'DELETE' });
      this.#activeRoots.set(this.#activeRoots.value.filter((r) => r !== root.name));
      await Promise.all([this.#refetchRoots(), this.#refetchFacets(), this.#refetch()]);
    } finally {
      this.#removingRoot.set('');
    }
  }

  #onRootAdded() {
    this.#showAddRoot.set(false);
    this.#refetchRoots();
    this.#refetchFacets();
    this.#refetch();
  }

  #allRoots(): Root[] {
    return [...this.#roots.value.skill, ...this.#roots.value.memory];
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

  #onSearchInput(e: Event) {
    this.#query.set((e.target as HTMLInputElement).value);
    this.#refetch();
  }

  #onSelect(entry: Entry) {
    this.#selected.set({ table: entry._table, id: entry.id });
  }

  render() {
    const facets = this.#facets.value;
    const allRoots = this.#allRoots();

    if (this.#rootsLoaded.value && allRoots.length === 0 && !this.#showAddRoot.value) {
      return html`
        <div class="first-run">
          <h1>No roots configured yet</h1>
          <p>
            Add a folder of skills or memory docs to get started. You can add more roots later —
            e.g. a personal skills repo plus a shared company repo.
          </p>
          <button class="add-root-btn" @click=${() => this.#showAddRoot.set(true)}>+ Add your first root</button>
        </div>
        ${this.#showAddRoot.value
          ? html`<add-root-modal
              .defaultKind=${'skill'}
              .lockKind=${false}
              .onAdded=${() => this.#onRootAdded()}
              .onCancel=${() => this.#showAddRoot.set(false)}
            ></add-root-modal>`
          : ''}
      `;
    }

    return html`
      <div class="roots-bar">
        <span class="filter-label">Roots:</span>
        ${allRoots.map(
          (root) => html`
            <button class="root-chip ${this.#activeRoots.value.includes(root.name) ? 'active' : ''}" @click=${() =>
              this.#toggleRoot(root.name)}>
              ${root.name}
              <span
                class="remove"
                title="Remove root"
                @click=${(e: Event) => this.#removeRoot(root, e)}
              >${this.#removingRoot.value === root.name ? '…' : '✕'}</span
              >
            </button>
          `
        )}
        <button class="add-root-btn" @click=${() => this.#showAddRoot.set(true)}>+ Add root</button>
      </div>
      <div class="filters">
        <input
          type="search"
          placeholder="Search descriptions, bodies, tags..."
          .value=${this.#query.value}
          @input=${(e: Event) => this.#onSearchInput(e)}
        />
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
        <div class="row">
          ${facets.tags.length === 0
            ? html`<span class="filter-label">Tags:</span> <label class="small">no tags yet</label>`
            : html`
                <tag-multiselect
                  .tags=${facets.tags}
                  .active=${this.#activeTags.value}
                  .onToggle=${(tag: string) => this.#toggleTag(tag)}
                ></tag-multiselect>
              `}
        </div>
      </div>
      <div class="body-region">
        <result-list
          style=${`width: ${this.#splitPct.value}%; border-right: 1px solid #8883;`}
          .results=${this.#results.value}
          .showRoot=${allRoots.length > 1}
          .onSelect=${(e: Entry) => this.#onSelect(e)}
        ></result-list>
        <div
          class="splitter ${this.#dragging.value ? 'dragging' : ''}"
          @pointerdown=${(e: PointerEvent) => this.#onDragStart(e)}
        ></div>
        <detail-panel .selected=${this.#selected.value}></detail-panel>
      </div>
      ${this.#showAddRoot.value
        ? html`<add-root-modal
            .defaultKind=${'skill'}
            .lockKind=${false}
            .onAdded=${() => this.#onRootAdded()}
            .onCancel=${() => this.#showAddRoot.set(false)}
          ></add-root-modal>`
        : ''}
    `;
  }
}

customElements.define('mem-bucket-app', MemBucketApp);
