import { LitElement, html, css } from 'lit';
import type { ChannelDetail, ChannelSummary } from './types.js';

function formatAge(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export class ChannelView extends LitElement {
  static properties = {
    channels: { attribute: false },
    selected: { attribute: false },
    detail: { attribute: false },
    loading: { attribute: false },
    onSelect: { attribute: false },
    onRefresh: { attribute: false },
  };

  declare channels: ChannelSummary[];
  declare selected: string | null;
  declare detail: ChannelDetail | null;
  declare loading: boolean;
  declare onSelect: (name: string) => void;
  declare onRefresh: () => void;

  static styles = css`
    :host { display: flex; flex: 1 1 auto; min-height: 0; }
    .nav {
      flex: 0 0 260px;
      overflow-y: auto;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
    }
    .nav-header {
      padding: 10px 14px;
      padding-top: 46px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      opacity: 0.6;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .refresh-btn {
      border: none; background: none; color: inherit; cursor: pointer; opacity: 0.6;
      font-size: 12px; padding: 2px 4px; border-radius: 4px;
    }
    .refresh-btn:hover { opacity: 1; background: var(--hover); }
    .channel-row {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .channel-row:hover { background: var(--hover); }
    .channel-row.active { background: var(--accent-tint); border-left: 3px solid var(--accent); padding-left: 11px; }
    .channel-name { font-size: 13px; font-weight: 600; font-family: ui-monospace, monospace; }
    .channel-meta { font-size: 11px; opacity: 0.6; }
    .empty { padding: 24px; opacity: 0.6; font-size: 13px; }
    .content-pane { flex: 1 1 auto; min-width: 0; overflow-y: auto; padding: 16px 20px; padding-top: 46px; }
    .content-header {
      display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
      margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border);
    }
    .content-title { font-size: 15px; font-weight: 700; font-family: ui-monospace, monospace; }
    .content-meta { font-size: 12px; opacity: 0.6; }
    .content-body {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, monospace;
      font-size: 13px;
      line-height: 1.5;
    }
    .no-selection {
      flex: 1 1 auto; display: flex; align-items: center; justify-content: center;
      opacity: 0.5; font-size: 13px; padding-top: 46px;
    }
    .placeholder-empty { opacity: 0.5; font-style: italic; }
  `;

  #renderNav() {
    if (!this.channels || this.channels.length === 0) {
      return html`<div class="empty">No live channels right now. Channels appear here once an agent posts to one with memory_channel_post — they're ephemeral and disappear after a long idle period or server restart.</div>`;
    }
    const sorted = [...this.channels].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return sorted.map(
      (c) => html`
        <div
          class="channel-row ${this.selected === c.name ? 'active' : ''}"
          @click=${() => this.onSelect(c.name)}
        >
          <span class="channel-name">${c.name}</span>
          <span class="channel-meta">${formatAge(c.lastActivityAt)}</span>
        </div>
      `
    );
  }

  #renderContent() {
    if (!this.selected) {
      return html`<div class="no-selection">Select a channel to view its content.</div>`;
    }
    if (this.loading) {
      return html`<div class="content-pane"><div class="content-meta">Loading…</div></div>`;
    }
    if (!this.detail) {
      return html`<div class="content-pane"><div class="content-meta">Channel not found — it may have gone idle and been swept.</div></div>`;
    }
    return html`
      <div class="content-pane">
        <div class="content-header">
          <span class="content-title">${this.detail.name}</span>
          <span class="content-meta">last activity ${formatAge(this.detail.lastActivityAt)}</span>
        </div>
        ${this.detail.content
          ? html`<div class="content-body">${this.detail.content}</div>`
          : html`<div class="placeholder-empty">Channel exists but nothing has been posted yet.</div>`}
      </div>
    `;
  }

  render() {
    return html`
      <div class="nav">
        <div class="nav-header">
          <span>Live channels</span>
          <button class="refresh-btn" title="Refresh" @click=${() => this.onRefresh()}>⟳</button>
        </div>
        ${this.#renderNav()}
      </div>
      ${this.#renderContent()}
    `;
  }
}

customElements.define('channel-view', ChannelView);
