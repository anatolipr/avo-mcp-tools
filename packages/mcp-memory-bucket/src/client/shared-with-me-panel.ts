import { LitElement, html, css } from 'lit';

const LAST_FORK_FOLDER_KEY = 'mem-bucket-last-fork-folder';

export interface SharedItemRow {
  origin_id: string;
  owner: string;
  server: string;
  tenant_id: string;
  kind: 'memory' | 'skill';
  role: 'member' | 'editor';
  remote_path: string;
  mirror_path: string;
  last_seen_modified_at: string | null;
  status: 'active' | 'revoked';
  added_at: string;
  entryId: string | null;
}

/**
 * "Shared with me" — memory docs/skills someone shared directly with this
 * user, item by item (not a whole connected folder — see folder-view.ts's
 * "Remote" section for that separate mechanism). Deliberately has NO
 * auto-refresh of its own: this component only ever renders whatever
 * `.items` it's given. The recycle-icon button is the ONLY way its data
 * changes, per the settled "refresh is a UI-only action" design — no poll
 * timer, no refetch on mount/focus. mem-bucket-app.ts owns the actual fetch
 * (via onRefresh) and passes the result back down as `.items`.
 */
export class SharedWithMePanel extends LitElement {
  static properties = {
    items: { attribute: false },
    refreshing: { attribute: false },
    lastRefreshSummary: { attribute: false },
    memoryFolderNames: { attribute: false },
    skillFolderNames: { attribute: false },
    onRefresh: { attribute: false },
    onDismiss: { attribute: false },
    onOpen: { attribute: false },
    onFork: { attribute: false },
    _forkOpenFor: { state: true },
    _forkFolder: { state: true },
    _forkBusy: { state: true },
    _forkStatus: { state: true },
  };

  declare items: SharedItemRow[];
  declare refreshing: boolean;
  declare lastRefreshSummary: { added: number; updated: number; revoked: number; unchanged: number } | null;
  // The fork destination picker's option list, split by kind — a shared memory doc forks into one
  // of the caller's own memory folders, a shared skill into one of their skill folders. Doesn't
  // distinguish local vs. remote: any configured folder the user already owns is a valid target.
  declare memoryFolderNames: string[];
  declare skillFolderNames: string[];
  declare onRefresh: () => void;
  declare onDismiss: (originId: string) => void;
  declare onOpen: (item: SharedItemRow) => void;
  declare onFork: (item: SharedItemRow, folder: string) => Promise<{ ok: boolean; message: string }>;

  private _forkOpenFor: string | null = null;
  private _forkFolder = localStorage.getItem(LAST_FORK_FOLDER_KEY) ?? '';
  private _forkBusy = false;
  private _forkStatus: string | null = null;

  static styles = css`
    :host { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
    .header {
      display: flex; align-items: center; gap: 10px; padding: 10px 16px;
      border-bottom: 1px solid var(--border); background: var(--bg-subtle);
    }
    .header h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; opacity: 0.6; margin: 0; flex: 1 1 auto; }
    .refresh-btn {
      width: 28px; height: 28px; border: 1px solid var(--border-strong); border-radius: 50%;
      background: var(--bg); color: inherit; cursor: pointer; font-size: 14px; line-height: 1;
      display: flex; align-items: center; justify-content: center; opacity: 0.75;
    }
    .refresh-btn:hover { opacity: 1; background: var(--hover); }
    .refresh-btn:disabled { cursor: default; opacity: 0.4; }
    .refresh-btn.spinning { animation: shared-refresh-spin 0.8s linear infinite; }
    @keyframes shared-refresh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .summary { font-size: 12px; opacity: 0.6; }
    .body { flex: 1 1 auto; overflow-y: auto; }
    .owner-group { border-bottom: 1px solid var(--border); }
    .owner-header { padding: 8px 16px 4px; font-size: 12px; font-weight: 600; opacity: 0.7; }
    .row {
      display: flex; align-items: center; gap: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer;
    }
    .row:hover { background: var(--hover); }
    .row.revoked { opacity: 0.55; cursor: default; }
    .row .icon { flex: 0 0 auto; }
    .row .name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .role-badge {
      flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--border-strong);
      opacity: 0.7; text-transform: uppercase;
    }
    .revoked-badge {
      flex: 0 0 auto; font-size: 11px; opacity: 0.8; font-style: italic;
    }
    .dismiss-btn {
      flex: 0 0 auto; border: none; background: none; color: inherit; cursor: pointer; opacity: 0.5; font-size: 13px;
    }
    .dismiss-btn:hover { opacity: 1; }
    .fork-btn {
      flex: 0 0 auto; font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border-strong);
      background: var(--bg); color: inherit; cursor: pointer; opacity: 0.75;
    }
    .fork-btn:hover { opacity: 1; background: var(--hover); }
    .fork-row {
      display: flex; align-items: center; gap: 6px; padding: 6px 16px 10px 40px; font-size: 12px;
    }
    .fork-row select {
      font-size: 12px; padding: 3px 6px; border: 1px solid var(--border-strong); border-radius: 4px;
      background: var(--bg); color: inherit;
    }
    .fork-status { font-size: 11px; opacity: 0.75; padding: 0 16px 8px 40px; }
    .empty { padding: 24px; opacity: 0.6; font-size: 13px; text-align: center; }
  `;

  #groupByOwner(items: SharedItemRow[]): Map<string, SharedItemRow[]> {
    const groups = new Map<string, SharedItemRow[]>();
    for (const item of items) {
      const list = groups.get(item.owner) ?? [];
      list.push(item);
      groups.set(item.owner, list);
    }
    return groups;
  }

  #foldersFor(kind: 'memory' | 'skill'): string[] {
    return kind === 'skill' ? this.skillFolderNames ?? [] : this.memoryFolderNames ?? [];
  }

  #toggleForkPicker(item: SharedItemRow) {
    this._forkOpenFor = this._forkOpenFor === item.origin_id ? null : item.origin_id;
    this._forkStatus = null;
    const folders = this.#foldersFor(item.kind);
    if (!folders.includes(this._forkFolder) && folders.length) this._forkFolder = folders[0]!;
  }

  async #confirmFork(item: SharedItemRow) {
    if (!this._forkFolder) return;
    this._forkBusy = true;
    this._forkStatus = null;
    try {
      const result = await this.onFork(item, this._forkFolder);
      this._forkStatus = result.message;
      if (result.ok) {
        localStorage.setItem(LAST_FORK_FOLDER_KEY, this._forkFolder);
        this._forkOpenFor = null;
      }
    } finally {
      this._forkBusy = false;
    }
  }

  #renderRow(item: SharedItemRow) {
    const revoked = item.status === 'revoked';
    const openable = !revoked && item.entryId !== null;
    const forkOpen = this._forkOpenFor === item.origin_id;
    return html`
      <div class="row ${revoked ? 'revoked' : ''}" @click=${() => openable && this.onOpen(item)}>
        <span class="icon">${item.kind === 'skill' ? '⚡' : '📝'}</span>
        <span class="name">${item.remote_path}</span>
        ${revoked
          ? html`<span class="revoked-badge">no longer shared with you</span>`
          : html`<span class="role-badge">${item.role}</span>`}
        ${!revoked
          ? html`<button class="fork-btn" @click=${(e: Event) => { e.stopPropagation(); this.#toggleForkPicker(item); }}>Fork to mine</button>`
          : ''}
        ${revoked
          ? html`<button class="dismiss-btn" title="Dismiss" @click=${(e: Event) => { e.stopPropagation(); this.onDismiss(item.origin_id); }}>✕</button>`
          : ''}
      </div>
      ${forkOpen
        ? html`
            <div class="fork-row" @click=${(e: Event) => e.stopPropagation()}>
              <select .value=${this._forkFolder} @change=${(e: Event) => (this._forkFolder = (e.target as HTMLSelectElement).value)}>
                ${this.#foldersFor(item.kind).map((name) => html`<option value=${name}>${name}</option>`)}
              </select>
              <button ?disabled=${this._forkBusy || !this._forkFolder} @click=${() => this.#confirmFork(item)}>Copy here</button>
              <button @click=${() => (this._forkOpenFor = null)}>Cancel</button>
            </div>
          `
        : ''}
      ${forkOpen && this._forkStatus ? html`<div class="fork-status">${this._forkStatus}</div>` : ''}
    `;
  }

  render() {
    const items = this.items ?? [];
    const groups = this.#groupByOwner(items);
    const summary = this.lastRefreshSummary;
    return html`
      <div class="header">
        <h2>Shared with me</h2>
        ${summary
          ? html`<span class="summary">${summary.added} added · ${summary.updated} updated · ${summary.revoked} revoked · ${summary.unchanged} unchanged</span>`
          : ''}
        <button
          class="refresh-btn ${this.refreshing ? 'spinning' : ''}"
          title="Refresh — check for updates or revoked shares"
          aria-label="Refresh shared items"
          ?disabled=${this.refreshing}
          @click=${() => this.onRefresh()}
        >
          ♻
        </button>
      </div>
      <div class="body">
        ${items.length === 0
          ? html`<div class="empty">Nothing shared with you yet. Items shared directly with you, or via a share link, appear here.</div>`
          : [...groups.entries()].map(
              ([owner, ownerItems]) => html`
                <div class="owner-group">
                  <div class="owner-header">From ${owner}</div>
                  ${ownerItems.map((item) => this.#renderRow(item))}
                </div>
              `
            )}
      </div>
    `;
  }
}

customElements.define('shared-with-me-panel', SharedWithMePanel);
