import { LitElement, html, css } from 'lit';
import { Signal, Computed, SignalWatcher } from 'avosignals';

import './result-list.js';
import './detail-panel.js';
import type { Entry, Facets, Selection, TypeFilter } from './types.js';

const TYPE_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'skill', label: 'Skills' },
  { value: 'memory', label: 'Memories' },
];

const EMPTY_FACETS: Facets = { tags: [], statuses: [], owners: [], doc_types: [], key_types: [] };

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
    .chip {
      border: 1px solid #8886;
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 12px;
      cursor: pointer;
      background: none;
      color: inherit;
    }
    .chip.active { background: #2563eb; border-color: #2563eb; color: white; }
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
    result-list { flex: 1 1 40%; overflow-y: auto; border-right: 1px solid #8883; }
    detail-panel { flex: 1 1 60%; overflow-y: auto; }
    label.small { font-size: 12px; opacity: 0.7; }
  `;

  #query = new Signal('');
  #typeFilter = new Signal<TypeFilter>('all');
  #activeTags = new Signal<string[]>([]);
  #results = new Signal<Entry[]>([]);
  #facets = new Signal<Facets>(EMPTY_FACETS);
  #selected = new Signal<Selection | null>(null);

  constructor() {
    super();
    new SignalWatcher(this);
  }

  #requestQuery = new Computed(() => {
    const params = new URLSearchParams();
    if (this.#typeFilter.value !== 'all') params.set('type', this.#typeFilter.value);
    if (this.#query.value.trim()) params.set('q', this.#query.value.trim());
    for (const tag of this.#activeTags.value) params.append('tag', tag);
    return params.toString();
  });

  connectedCallback() {
    super.connectedCallback();
    this.#refetch();
    this.#refetchFacets();
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
    return html`
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
            ? html`<label class="small">no tags yet</label>`
            : facets.tags.map(
                (tag) => html`
                  <button
                    class="chip ${this.#activeTags.value.includes(tag) ? 'active' : ''}"
                    @click=${() => this.#toggleTag(tag)}
                  >
                    ${tag}
                  </button>
                `
              )}
        </div>
      </div>
      <div class="body-region">
        <result-list .results=${this.#results.value} .onSelect=${(e: Entry) => this.#onSelect(e)}></result-list>
        <detail-panel .selected=${this.#selected.value}></detail-panel>
      </div>
    `;
  }
}

customElements.define('mem-bucket-app', MemBucketApp);
