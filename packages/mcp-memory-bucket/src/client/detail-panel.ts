import { LitElement, html, css, nothing } from 'lit';
import { marked } from 'marked';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { EntryDetail, Selection } from './types.js';

const VIEW_MODE_KEY = 'mem-bucket-detail-view-mode';

export class DetailPanel extends LitElement {
  static properties = {
    selected: { attribute: false },
    _doc: { state: true },
    _viewMode: { state: true },
  };

  declare selected: Selection | null;
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
      background: #8881;
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
      border: 1px solid #8884;
      background: transparent;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.6;
    }
    .view-toggle button.active {
      opacity: 1;
      background: #8882;
      font-weight: 600;
    }
    .markdown-body {
      font-size: 13px;
      line-height: 1.5;
      max-height: 60vh;
      overflow-y: auto;
      padding: 12px;
      background: #8881;
      border-radius: 6px;
    }
    .markdown-body :first-child { margin-top: 0; }
    .markdown-body :last-child { margin-bottom: 0; }
    .markdown-body pre {
      background: #8882;
      max-height: none;
    }
    .markdown-body code {
      font-family: monospace;
      font-size: 12px;
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

  render() {
    if (!this.selected) return html`<div class="empty">Select an entry to view its details.</div>`;
    if (!this._doc) return nothing;
    const d = this._doc;
    return html`
      <h2>${d.name ?? d.key ?? d.id}</h2>
      <div class="meta">
        ${d.tags?.join(', ') || 'no tags'} · ${d.status}${d.owner ? ` · owner: ${d.owner}` : ''}
      </div>
      <div class="meta">${d.description}</div>
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
