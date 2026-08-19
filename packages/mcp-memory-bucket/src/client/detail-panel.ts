import { LitElement, html, css, nothing } from 'lit';
import { marked } from 'marked';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { EntryDetail, Selection } from './types.js';

const VIEW_MODE_KEY = 'mem-bucket-detail-view-mode';

export class DetailPanel extends LitElement {
  static properties = {
    selected: { attribute: false },
    onChanged: { attribute: false },
    _doc: { state: true },
    _viewMode: { state: true },
  };

  declare selected: Selection | null;
  declare onChanged: (() => void) | undefined;
  private _doc?: EntryDetail | null;
  private _viewMode: 'markdown' | 'raw' =
    (localStorage.getItem(VIEW_MODE_KEY) as 'markdown' | 'raw' | null) ?? 'markdown';

  static styles = css`
    :host { display: block; padding: 16px; }
    h2 { margin: 0 0 4px; font-size: 16px; }
    .meta { font-size: 12px; opacity: 0.7; margin-bottom: 12px; }
    .source-path {
      font-family: monospace;
      font-size: 11px;
      opacity: 0.6;
      cursor: pointer;
      word-break: break-all;
    }
    pre {
      white-space: pre-wrap;
      font-size: 12px;
      background: var(--bg-subtle);
      padding: 12px;
      border-radius: 6px;
      max-height: 60vh;
      overflow-y: auto;
    }
    .empty { opacity: 0.5; font-size: 13px; }
    .view-toggle {
      display: flex;
      gap: 4px;
      margin-bottom: 8px;
    }
    .view-toggle button {
      font-size: 11px;
      padding: 3px 8px;
      border: 1px solid var(--border);
      background: transparent;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.6;
    }
    .view-toggle button.active {
      opacity: 1;
      background: var(--hover);
      font-weight: 600;
    }
    .markdown-body {
      font-size: 13px;
      line-height: 1.5;
      max-height: 60vh;
      overflow-y: auto;
      padding: 12px;
      background: var(--bg-subtle);
      border-radius: 6px;
    }
    .markdown-body :first-child { margin-top: 0; }
    .markdown-body :last-child { margin-bottom: 0; }
    .markdown-body pre {
      background: var(--hover);
      max-height: none;
    }
    .markdown-body code {
      font-family: monospace;
      font-size: 12px;
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .actions button {
      font-size: 11px;
      padding: 4px 10px;
      border: 1px solid var(--border);
      background: transparent;
      color: inherit;
      border-radius: 4px;
      cursor: pointer;
    }
    .actions button.danger {
      border-color: var(--danger);
      color: var(--danger);
    }
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has('selected') && this.selected) {
      this.#load();
      this.scrollTop = 0;
    }
  }

  async #load() {
    const { table, id } = this.selected!;
    const res = await fetch(`/api/entries/${table}/${encodeURIComponent(id)}`);
    this._doc = res.ok ? ((await res.json()) as EntryDetail) : null;
    await this.updateComplete;
    this.shadowRoot?.querySelector('.markdown-body')?.scrollTo(0, 0);
    this.shadowRoot?.querySelector('pre')?.scrollTo(0, 0);
  }

  #copyPath() {
    if (this._doc?.source_path) navigator.clipboard?.writeText(this._doc.source_path);
  }

  #setViewMode(mode: 'markdown' | 'raw') {
    this._viewMode = mode;
    localStorage.setItem(VIEW_MODE_KEY, mode);
  }

  async #toggleDeprecated() {
    const { table, id } = this.selected!;
    const deprecated = !this._doc?.deprecated;
    await fetch(`/api/entries/${table}/${encodeURIComponent(id)}/deprecated`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deprecated }),
    });
    await this.#load();
    this.onChanged?.();
  }

  async #togglePaused() {
    const { table, id } = this.selected!;
    const paused = !this._doc?.paused;
    await fetch(`/api/entries/${table}/${encodeURIComponent(id)}/paused`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused }),
    });
    await this.#load();
    this.onChanged?.();
  }

  async #deleteDoc() {
    if (!window.confirm("Delete this doc? This can't be undone.")) return;
    const { table, id } = this.selected!;
    await fetch(`/api/entries/${table}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    this._doc = null;
    this.onChanged?.();
  }

  render() {
    if (!this.selected) return html`<div class="empty">Select an entry to view its details.</div>`;
    if (!this._doc) return nothing;
    const d = this._doc;
    const isBuiltin = this.selected.table === 'skills' && d.root === 'builtin';
    return html`
      <h2>${d.name ?? d.key ?? d.id}</h2>
      <div class="meta">
        ${d.tags?.join(', ') || 'no tags'} · ${d.status}${d.owner ? ` · owner: ${d.owner}` : ''}
        ${d.deprecated ? ' · deprecated' : ''}${d.paused ? ' · paused' : ''} · created
        ${d.created_at ? d.created_at.slice(0, 10) : 'unknown'}
      </div>
      <div class="meta">${d.description}</div>
      ${isBuiltin
        ? nothing
        : html`
            <div class="actions">
              <button @click=${() => this.#toggleDeprecated()}>${d.deprecated ? 'Un-deprecate' : 'Mark deprecated'}</button>
              <button @click=${() => this.#togglePaused()}>${d.paused ? 'Resume' : 'Pause'}</button>
              <button class="danger" @click=${() => this.#deleteDoc()}>Delete</button>
            </div>
          `}
      <div class="view-toggle">
        <button
          class=${this._viewMode === 'markdown' ? 'active' : ''}
          @click=${() => this.#setViewMode('markdown')}
        >
          Preview
        </button>
        <button
          class=${this._viewMode === 'raw' ? 'active' : ''}
          @click=${() => this.#setViewMode('raw')}
        >
          Raw
        </button>
      </div>
      ${this._viewMode === 'markdown'
        ? html`<div class="markdown-body">${unsafeHTML(marked.parse(d.body ?? '', { async: false }) as string)}</div>`
        : html`<pre>${d.body}</pre>`}
      <div class="source-path" title="click to copy" @click=${() => this.#copyPath()}>${d.source_path}</div>
    `;
  }
}

customElements.define('detail-panel', DetailPanel);
