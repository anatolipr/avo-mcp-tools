import { LitElement, html, css, nothing } from 'lit';
import type { EntryDetail, Selection } from './types.js';

export class DetailPanel extends LitElement {
  static properties = {
    selected: { attribute: false },
    _doc: { state: true },
  };

  declare selected: Selection | null;
  private _doc?: EntryDetail | null;

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
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has('selected') && this.selected) {
      this.#load();
    }
  }

  async #load() {
    const { table, id } = this.selected!;
    const res = await fetch(`/api/entries/${table}/${encodeURIComponent(id)}`);
    this._doc = res.ok ? ((await res.json()) as EntryDetail) : null;
  }

  #copyPath() {
    if (this._doc?.source_path) navigator.clipboard?.writeText(this._doc.source_path);
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
      <pre>${d.body}</pre>
      <div class="source-path" title="click to copy" @click=${() => this.#copyPath()}>${d.source_path}</div>
    `;
  }
}

customElements.define('detail-panel', DetailPanel);
