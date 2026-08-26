import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import type { DashboardChannel } from './types.js';

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

export class DashboardApp extends LitElement {
  static styles = css`
    :host { display: block; min-height: 100vh; padding: 24px; box-sizing: border-box; }
    h1 { font-size: 16px; margin: 0 0 4px; }
    .subtitle { font-size: 12px; opacity: 0.6; margin: 0 0 20px; }
    .empty {
      padding: 40px 20px; text-align: center; opacity: 0.6; font-size: 13px;
      border: 1px dashed var(--border-strong); border-radius: 8px;
    }
    .channel {
      border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; overflow: hidden;
    }
    .channel-header {
      display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
      padding: 10px 14px; background: var(--bg-subtle); border-bottom: 1px solid var(--border);
    }
    .channel-name { font-family: ui-monospace, monospace; font-size: 13px; font-weight: 700; }
    .channel-meta { font-size: 11px; opacity: 0.6; }
    .connections { display: flex; flex-direction: column; }
    .connection-row {
      display: flex; align-items: center; gap: 10px; padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }
    .connection-row:last-child { border-bottom: none; }
    .connection-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex-shrink: 0;
    }
    .connection-label { font-size: 13px; font-weight: 600; flex: 0 0 auto; }
    .connection-summary {
      font-size: 12px; opacity: 0.6; flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .connection-tools { font-size: 11px; opacity: 0.6; flex: 0 0 auto; }
    .no-connections { padding: 10px 14px; font-size: 12px; opacity: 0.5; font-style: italic; }
    .identify-btn {
      flex: 0 0 auto; font-size: 11px; padding: 4px 10px; border-radius: 6px;
      border: 1px solid var(--border-strong); background: var(--bg); color: inherit; cursor: pointer;
    }
    .identify-btn:hover { background: var(--hover); border-color: var(--accent); }
    .identify-btn:active { background: var(--accent-tint); }
    .identify-btn.sent { border-color: var(--accent); color: var(--accent); }
    .conn-count { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--hover); opacity: 0.75; }
  `;

  #channels = new Signal<DashboardChannel[]>([]);
  #source?: EventSource;
  #justSent = new Signal<Set<string>>(new Set());

  constructor() {
    super();
    new SignalWatcher(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this.#source = new EventSource('/api/dashboard/stream');
    this.#source.onmessage = (event) => {
      try {
        this.#channels.set(JSON.parse(event.data) as DashboardChannel[]);
      } catch {
        // malformed event — ignore, next push will self-correct
      }
    };
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#source?.close();
  }

  async #identify(channel: string, connectionId: string) {
    const key = `${channel}::${connectionId}`;
    try {
      await fetch(`/api/dashboard/channels/${encodeURIComponent(channel)}/connections/${encodeURIComponent(connectionId)}/identify`, {
        method: 'POST',
      });
    } catch {
      return; // best-effort — the connection may have just closed
    }
    const next = new Set(this.#justSent.value);
    next.add(key);
    this.#justSent.set(next);
    setTimeout(() => {
      const cleared = new Set(this.#justSent.value);
      cleared.delete(key);
      this.#justSent.set(cleared);
    }, 1200);
  }

  render() {
    const channels = this.#channels.value;
    return html`
      <h1>Connected apps</h1>
      <p class="subtitle">Live channels and bridged browser tabs — updates automatically.</p>
      ${channels.length === 0
        ? html`<div class="empty">No channels yet. A channel appears here once an agent calls join_channel, or a page connects and lands on the default channel.</div>`
        : channels.map((c) => this.#renderChannel(c))}
    `;
  }

  #renderChannel(c: DashboardChannel) {
    return html`
      <div class="channel">
        <div class="channel-header">
          <span class="channel-name">${c.channel}</span>
          <span class="channel-meta">
            <span class="conn-count">${c.connections.length} connection${c.connections.length === 1 ? '' : 's'}</span>
            &nbsp;·&nbsp;active ${formatAge(c.lastActivityAt)}
          </span>
        </div>
        <div class="connections">
          ${c.connections.length === 0
            ? html`<div class="no-connections">No tabs currently bridged into this channel.</div>`
            : c.connections.map((conn) => {
                const key = `${c.channel}::${conn.id}`;
                const sent = this.#justSent.value.has(key);
                return html`
                  <div class="connection-row">
                    <span class="connection-dot"></span>
                    <span class="connection-label">${conn.label ?? '(unlabeled)'}</span>
                    <span class="connection-summary">${conn.summary ?? ''}</span>
                    <span class="connection-tools">${conn.toolCount} tool${conn.toolCount === 1 ? '' : 's'}</span>
                    <button
                      class="identify-btn ${sent ? 'sent' : ''}"
                      @click=${() => this.#identify(c.channel, conn.id)}
                    >
                      ${sent ? 'Sent ✓' : 'Identify'}
                    </button>
                  </div>
                `;
              })}
        </div>
      </div>
    `;
  }
}

customElements.define('dashboard-app', DashboardApp);
