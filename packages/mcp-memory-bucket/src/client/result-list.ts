import { LitElement, html, css } from 'lit';
import type { Entry } from './types.js';

export class ResultList extends LitElement {
  static properties = {
    results: { attribute: false },
    showRoot: { attribute: false },
    onSelect: { attribute: false },
  };

  declare results: Entry[];
  declare showRoot: boolean;
  declare onSelect: (entry: Entry) => void;

  static styles = css`
    :host { display: block; }
    .row { padding: 10px 14px; border-bottom: 1px solid #8882; cursor: pointer; }
    .row:hover { background: #8881; }
    .top { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
    .name { font-weight: 600; }
    .meta { opacity: 0.65; font-size: 11px; white-space: nowrap; }
    .desc { font-size: 12px; opacity: 0.8; margin-top: 3px; }
    .tags { margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
    .tag { font-size: 10px; border: 1px solid #8886; border-radius: 999px; padding: 1px 6px; }
    .type-badge { font-size: 10px; text-transform: uppercase; opacity: 0.6; }
    .root-badge {
      font-size: 10px; text-transform: uppercase; opacity: 0.9; border: 1px solid #a78bfa88;
      color: #6d28d9; background: #a78bfa22; border-radius: 4px; padding: 0 4px;
    }
    @media (prefers-color-scheme: dark) {
      .root-badge { color: #d8caff; }
    }
    .empty { padding: 24px; opacity: 0.6; font-size: 13px; }
  `;

  render() {
    if (!this.results || this.results.length === 0) {
      return html`<div class="empty">No results.</div>`;
    }
    return html`
      ${this.results.map(
        (r) => html`
          <div class="row" @click=${() => this.onSelect(r)}>
            <div class="top">
              <span class="name">${r.name}</span>
              <span class="meta">${r.owner ?? '—'} · ${r.status}</span>
            </div>
            <div class="desc">${r.description}</div>
            <div class="tags">
              <span class="type-badge">${r._table === 'skills' ? 'skill' : 'memory'}</span>
              ${this.showRoot && r.root ? html`<span class="root-badge">${r.root}</span>` : ''}
              ${r.tags.map((t) => html`<span class="tag">${t}</span>`)}
            </div>
          </div>
        `
      )}
    `;
  }
}

customElements.define('result-list', ResultList);
