import { LitElement, html, css } from 'lit';
import type { Entry } from './types.js';

// Local timezone, not raw UTC — mirrors the server's toLocalDate (src/store/date-extract.ts),
// which is what actually populates doc_dates and therefore what the date-range filter keys off
// of. A raw `.toISOString().slice(0, 10)` can show a date one day off from what's filterable.
const dateFormatter = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });

function formatAge(createdAt: string | null): string {
  if (!createdAt) return 'unknown age';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'unknown age';
  return dateFormatter.format(date);
}

interface EntryGroup {
  key: string | null; // null groups all `skills` rows together, unlabeled (skills have no key)
  items: Entry[];
}

/** Groups memory_docs rows by key (their shared lookup handle), preserving each row's relative
 * order and using each group's first-seen position (i.e. the current sort order) as the group's
 * position. Skills have no key concept, so they're collected into one trailing unlabeled group. */
function groupByKey(results: Entry[]): EntryGroup[] {
  const order: string[] = [];
  const groups = new Map<string, Entry[]>();
  const ungrouped: Entry[] = [];
  for (const r of results) {
    if (r._table !== 'memory_docs') {
      ungrouped.push(r);
      continue;
    }
    if (!groups.has(r.name)) {
      groups.set(r.name, []);
      order.push(r.name);
    }
    groups.get(r.name)!.push(r);
  }
  const grouped: EntryGroup[] = order.map((key) => ({ key, items: groups.get(key)! }));
  if (ungrouped.length > 0) grouped.push({ key: null, items: ungrouped });
  return grouped;
}

export class ResultList extends LitElement {
  static properties = {
    results: { attribute: false },
    showFolder: { attribute: false },
    onSelect: { attribute: false },
    selectedIds: { attribute: false },
    onToggleSelect: { attribute: false },
    onKeyClick: { attribute: false },
  };

  declare results: Entry[];
  declare showFolder: boolean;
  declare onSelect: (entry: Entry) => void;
  declare selectedIds: Set<string>;
  declare onToggleSelect: (entry: Entry) => void;
  declare onKeyClick: ((key: string) => void) | undefined;

  static styles = css`
    :host { display: block; }
    .count-header {
      padding: 8px 14px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      opacity: 0.6;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
    }
    .key-group-header {
      padding: 6px 14px;
      font-size: 11px;
      font-weight: 700;
      opacity: 0.7;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .key-group-count { opacity: 0.6; font-weight: 400; }
    .key-group-link {
      background: none; border: none; padding: 0; margin: 0; font: inherit; font-weight: 700;
      color: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
    }
    .key-group-link:hover { opacity: 0.8; }
    .row { padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; display: flex; gap: 8px; }
    .row:hover { background: var(--hover); }
    .row.deprecated { opacity: 0.55; }
    .row.paused { opacity: 0.6; }
    .row-checkbox { flex: 0 0 auto; margin-top: 2px; cursor: pointer; }
    .row-body { flex: 1 1 auto; min-width: 0; }
    .top { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
    .name { font-weight: 600; }
    .deprecated .name { text-decoration: line-through; }
    .meta { opacity: 0.65; font-size: 11px; white-space: nowrap; }
    .desc { font-size: 12px; opacity: 0.8; margin-top: 3px; }
    .tags { margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
    .tag { font-size: 10px; border: 1px solid var(--border-strong); border-radius: 999px; padding: 1px 6px; }
    .type-badge { font-size: 10px; text-transform: uppercase; opacity: 0.6; }
    .folder-badge {
      font-size: 10px; text-transform: uppercase; opacity: 0.9; border: 1px solid var(--purple);
      color: var(--purple-fg); background: var(--purple-tint); border-radius: 4px; padding: 0 4px;
    }
    .deprecated-badge {
      font-size: 10px; text-transform: uppercase; border: 1px solid var(--danger);
      color: var(--danger); background: color-mix(in srgb, var(--danger) 13%, transparent); border-radius: 4px; padding: 0 4px;
    }
    .paused-badge {
      font-size: 10px; text-transform: uppercase; border: 1px solid var(--accent);
      color: var(--accent); background: var(--accent-tint); border-radius: 4px; padding: 0 4px;
    }
    .empty { padding: 24px; opacity: 0.6; font-size: 13px; }
  `;

  render() {
    if (!this.results || this.results.length === 0) {
      return html`<div class="empty">No results.</div>`;
    }
    return html`
      <div class="count-header">${this.results.length} result${this.results.length === 1 ? '' : 's'}</div>
      ${groupByKey(this.results).map(
        (group) => html`
          ${group.key
            ? html`<div class="key-group-header">
                🔑
                <button
                  class="key-group-link"
                  title="Search for this key"
                  @click=${() => this.onKeyClick?.(group.key!)}
                >
                  ${group.key}
                </button>
                <span class="key-group-count">(${group.items.length})</span>
              </div>`
            : ''}
          ${group.items.map((r) => this.#renderRow(r))}
        `
      )}
    `;
  }

  #renderRow(r: Entry) {
    const isBuiltin = r._table === 'skills' && r.folder === 'builtin';
    return html`
      <div class="row ${r.deprecated ? 'deprecated' : ''} ${r.paused ? 'paused' : ''}" @click=${() => this.onSelect(r)}>
        <input
          type="checkbox"
          class="row-checkbox"
          .checked=${this.selectedIds?.has(r.id) ?? false}
          .disabled=${isBuiltin}
          title=${isBuiltin ? "Builtin skills can't be bulk-deprecated, paused, or deleted" : ''}
          @click=${(e: Event) => {
            e.stopPropagation();
            if (!isBuiltin) this.onToggleSelect(r);
          }}
        />
        <div class="row-body">
          <div class="top">
            <span class="name">${r.name}</span>
            <span class="meta">${formatAge(r.created_at)} · ${r.owner ?? '—'} · ${r.status}</span>
          </div>
          <div class="desc">${r.description}</div>
          <div class="tags">
            <span class="type-badge">${r._table === 'skills' ? 'skill' : 'memory'}</span>
            ${this.showFolder && r.folder ? html`<span class="folder-badge">📁 ${r.folder}</span>` : ''}
            ${r.deprecated ? html`<span class="deprecated-badge">deprecated</span>` : ''}
            ${r.paused ? html`<span class="paused-badge">paused</span>` : ''}
            ${r.tags.map((t) => html`<span class="tag">${t}</span>`)}
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('result-list', ResultList);
