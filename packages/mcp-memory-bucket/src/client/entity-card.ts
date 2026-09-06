import { LitElement, html, css, nothing } from 'lit';

/** A stats row item — icon+count pair, e.g. a tag count or a size. Purely cosmetic; the icon is
 * any short string (emoji or 1-2 chars), not a full icon system. */
export interface EntityCardStat {
  icon: string;
  label: string;
}

/**
 * Generic rich entity card, ported from a reference "MCP server card" design (logo/name/owner/
 * verified/description/tags/stats/heart/action-button) so folder-view.ts's folder cards and a
 * future skill-card view can share one visual language instead of each hand-rolling their own.
 * Every prop is independently optional and renders nothing when unset — this component has no
 * required shape beyond that, by design (see the Quick Prompts spec this was built for).
 */
export class EntityCard extends LitElement {
  static properties = {
    entityTitle: { attribute: false },
    description: { attribute: false },
    tags: { attribute: false },
    iconOrEmoji: { attribute: false },
    iconImageUrl: { attribute: false },
    owner: { attribute: false },
    verified: { attribute: false },
    stats: { attribute: false },
    pinned: { attribute: false },
    onPin: { attribute: false },
    onCopy: { attribute: false },
    copyIcon: { attribute: false },
    onEdit: { attribute: false },
    onDelete: { attribute: false },
    selected: { attribute: false },
    onClick: { attribute: false },
    onActivate: { attribute: false },
    actionLabel: { attribute: false },
    onAction: { attribute: false },
  };

  declare entityTitle?: string;
  declare description?: string;
  declare tags?: string[];
  /** Single character/emoji shown in the logo slot (e.g. 📁/☁/📝) — ignored if iconImageUrl is set. */
  declare iconOrEmoji?: string;
  /** Small image URL for the logo slot, takes priority over iconOrEmoji when both are set. */
  declare iconImageUrl?: string;
  declare owner?: string;
  declare verified?: boolean;
  declare stats?: EntityCardStat[];
  /** Drives the heart icon's filled/outline state. Only rendered at all when onPin is set. */
  declare pinned?: boolean;
  declare onPin?: () => void;
  /** Only rendered when set — a visible copy-icon action button distinct from the primary onAction button. */
  declare onCopy?: () => void;
  declare copyIcon?: string;
  /** Only rendered when set — a pencil-icon action button. */
  declare onEdit?: () => void;
  /** Only rendered when set — a trash icon action button. */
  declare onDelete?: () => void;
  /** Keyboard-nav highlight, e.g. arrow-key selection in a grid. */
  declare selected?: boolean;
  declare onClick?: () => void;
  declare onActivate?: () => void;
  /** Primary action button (was "Install" in the reference design) — only rendered when both are set. */
  declare actionLabel?: string;
  declare onAction?: () => void;

  static styles = css`
    :host { display: block; height: 100%; box-sizing: border-box; }
    .card {
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--bg);
      padding: 14px;
      color: inherit;
      transition: border-color 0.15s, background 0.15s;
      cursor: default;
    }
    .card.clickable { cursor: pointer; }
    .card:hover { background: var(--hover); }
    .card.selected { border-color: var(--accent); background: var(--accent-tint); }
    .top-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .logo-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .logo {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      object-fit: cover;
      flex-shrink: 0;
    }
    .logo-emoji {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 17px;
      background: var(--bg-subtle);
    }
    .name-group { min-width: 0; }
    .name {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.3;
      margin: 0;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .owner-row { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
    .owner {
      font-size: 12px;
      opacity: 0.65;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .check { width: 12px; height: 12px; color: var(--accent); flex-shrink: 0; }
    .description {
      font-size: 12.5px;
      line-height: 1.45;
      opacity: 0.8;
      margin: 0 0 10px 0;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      white-space: pre-wrap;
    }
    .tags { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
    .badge {
      display: inline-flex;
      align-items: center;
      height: 18px;
      padding: 0 7px;
      border-radius: 9999px;
      font-size: 10px;
      font-weight: 500;
      white-space: nowrap;
      border: 1px solid var(--border-strong);
      background: var(--bg-subtle);
    }
    .spacer { flex: 1; }
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-top: 10px;
      margin-top: auto;
      border-top: 1px solid var(--border);
      font-size: 12px;
      opacity: 0.75;
    }
    .footer.no-stats { justify-content: flex-end; }
    .stats-left { display: flex; align-items: center; gap: 10px; }
    .stats-left span { display: flex; align-items: center; gap: 3px; }
    .actions-right { display: flex; align-items: center; gap: 4px; }
    .icon-btn {
      background: none;
      border: none;
      color: inherit;
      opacity: 0.6;
      cursor: pointer;
      padding: 3px;
      display: flex;
      align-items: center;
      border-radius: 4px;
      font-size: 13px;
      line-height: 1;
    }
    .icon-btn:hover { opacity: 1; background: var(--bg-subtle); }
    .icon-btn.heart.pinned { opacity: 1; color: var(--danger); }
    .icon-btn.delete:hover { color: var(--danger); }
    .action-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: none;
      font-size: 11.5px;
      font-weight: 500;
      color: inherit;
      cursor: pointer;
    }
    .action-btn:hover { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  `;

  #stop(e: Event) {
    e.stopPropagation();
  }

  render() {
    const hasHeader = this.entityTitle !== undefined || this.iconOrEmoji || this.iconImageUrl || this.owner;
    const hasFooter = (this.stats && this.stats.length > 0) || this.onPin || this.onCopy || this.onEdit || this.onDelete || (this.actionLabel && this.onAction);
    return html`
      <div
        class="card ${this.onClick || this.onActivate ? 'clickable' : ''} ${this.selected ? 'selected' : ''}"
        @click=${() => this.onClick?.()}
        @dblclick=${() => this.onActivate?.()}
      >
        ${hasHeader
          ? html`
              <div class="top-row">
                <div class="logo-name">
                  ${this.iconImageUrl
                    ? html`<img class="logo" src=${this.iconImageUrl} alt="" loading="lazy" />`
                    : this.iconOrEmoji
                      ? html`<div class="logo-emoji">${this.iconOrEmoji}</div>`
                      : nothing}
                  <div class="name-group">
                    ${this.entityTitle !== undefined ? html`<h3 class="name">${this.entityTitle || html`<em style="opacity:0.5">(untitled)</em>`}</h3>` : nothing}
                    ${this.owner
                      ? html`
                          <div class="owner-row">
                            <span class="owner">${this.owner}</span>
                            ${this.verified
                              ? html`<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                  <circle cx="12" cy="12" r="10" />
                                  <path d="m9 12 2 2 4-4" />
                                </svg>`
                              : nothing}
                          </div>
                        `
                      : nothing}
                  </div>
                </div>
              </div>
            `
          : nothing}
        ${this.description ? html`<p class="description">${this.description}</p>` : nothing}
        ${this.tags && this.tags.length > 0
          ? html`<div class="tags">${this.tags.map((t) => html`<span class="badge">${t}</span>`)}</div>`
          : nothing}
        ${hasFooter
          ? html`
              <div class="footer ${this.stats && this.stats.length > 0 ? '' : 'no-stats'}">
                ${this.stats && this.stats.length > 0
                  ? html`
                      <div class="stats-left">
                        ${this.stats.map((s) => html`<span>${s.icon} ${s.label}</span>`)}
                      </div>
                    `
                  : nothing}
                <div class="actions-right">
                  ${this.onCopy
                    ? html`<button class="icon-btn copy" title="Copy" @click=${(e: Event) => { this.#stop(e); this.onCopy?.(); }}>${this.copyIcon || '📋'}</button>`
                    : nothing}
                  ${this.onPin
                    ? html`<button
                        class="icon-btn heart ${this.pinned ? 'pinned' : ''}"
                        title=${this.pinned ? 'Unpin' : 'Pin'}
                        @click=${(e: Event) => { this.#stop(e); this.onPin?.(); }}
                      >${this.pinned ? '♥' : '♡'}</button>`
                    : nothing}
                  ${this.onEdit
                    ? html`<button class="icon-btn edit" title="Edit" @click=${(e: Event) => { this.#stop(e); this.onEdit?.(); }}>✏️</button>`
                    : nothing}
                  ${this.onDelete
                    ? html`<button class="icon-btn delete" title="Delete" @click=${(e: Event) => { this.#stop(e); this.onDelete?.(); }}>🗑</button>`
                    : nothing}
                  ${this.actionLabel && this.onAction
                    ? html`<button class="action-btn" @click=${(e: Event) => { this.#stop(e); this.onAction?.(); }}>${this.actionLabel}</button>`
                    : nothing}
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

customElements.define('entity-card', EntityCard);
