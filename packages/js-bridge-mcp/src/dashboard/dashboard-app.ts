import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import type { DashboardChannel, DashboardRootConnection, DashboardSnapshot } from './types.js';
import { parseChannelInput, VALID_CHANNEL_NAME, sanitizeToValidChannelName } from '../client/connect.js';
import { toast } from './toast.js';
import './docs-section.js';
import './tools-modal.js';

// 3-way (system/light/dark) theme toggle — see the light-dark-theme-toggle
// pattern: CSS light-dark() tokens (already defined in index.html) resolve
// automatically from the OS/browser preference; this JS layer only handles
// the explicit override + persistence via the `data-theme` attribute.
type ThemeMode = 'system' | 'light' | 'dark';
const THEME_STORAGE_KEY = 'js-bridge-mcp-theme';
const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark'];
const THEME_ICON: Record<ThemeMode, string> = { system: '◐', light: '☀', dark: '☾' };
const THEME_LABEL: Record<ThemeMode, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

function loadTheme(): ThemeMode {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

function applyTheme(mode: ThemeMode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}

const KIND_ICON: Record<'browser' | 'proxy' | 'admin', string> = { browser: '🌐', proxy: '🔌', admin: '⚙️' };
const KIND_TITLE: Record<'browser' | 'proxy' | 'admin', string> = { browser: 'Browser tab', proxy: 'MCP server proxy', admin: 'Admin (proxy management)' };

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
    .header-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    h1 { font-size: 16px; margin: 0 0 4px; }
    .subtitle { font-size: 12px; opacity: 0.6; margin: 0 0 20px; }
    .copy-snippet-btn {
      flex: 0 0 auto; font-size: 12px; padding: 6px 12px; border-radius: 6px;
      border: 1px solid var(--border-strong); background: var(--bg); color: inherit; cursor: pointer;
    }
    .copy-snippet-btn:hover { background: var(--hover); border-color: var(--accent); }
    .copy-snippet-btn:active { background: var(--accent-tint); }
    .header-actions { display: flex; gap: 8px; align-items: baseline; }
    .theme-toggle {
      flex: 0 0 auto; font-size: 14px; width: 28px; height: 28px; padding: 0; border-radius: 6px;
      border: 1px solid var(--border-strong); background: var(--bg); color: inherit; cursor: pointer;
    }
    .theme-toggle:hover { background: var(--hover); border-color: var(--accent); }
    .nav-link {
      flex: 0 0 auto; font-size: 12px; padding: 6px 12px; border-radius: 6px;
      border: 1px solid var(--border-strong); background: var(--bg); color: inherit; cursor: pointer;
      text-decoration: none; box-sizing: border-box; display: inline-block;
    }
    .nav-link:hover { background: var(--hover); border-color: var(--accent); }
    .connection-kind { flex: 0 0 auto; font-size: 12px; }
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
      font-size: 12px; opacity: 0.6; flex: 1 1 auto; min-width: 0; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .connection-summary:hover { opacity: 1; text-decoration: underline dotted; }
    .view-tools-btn {
      font-size: 11px; opacity: 0.7; flex: 0 0 auto; border: none; background: none;
      color: inherit; cursor: pointer; padding: 2px 4px; border-radius: 4px;
    }
    .view-tools-btn:hover { opacity: 1; background: var(--hover); }
    .no-connections { padding: 10px 14px; font-size: 12px; opacity: 0.5; font-style: italic; }
    .identify-btn, .move-btn {
      flex: 0 0 auto; font-size: 11px; padding: 4px 10px; border-radius: 6px;
      border: 1px solid var(--border-strong); background: var(--bg); color: inherit; cursor: pointer;
    }
    .identify-btn:hover, .move-btn:hover { background: var(--hover); border-color: var(--accent); }
    .identify-btn:active, .move-btn:active { background: var(--accent-tint); }
    .identify-btn.sent { border-color: var(--accent); color: var(--accent); }
    .conn-count { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--hover); opacity: 0.75; }
    .summary-backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 1001;
      display: flex; align-items: center; justify-content: center;
    }
    .summary-modal {
      background: var(--bg); border: 1px solid var(--border-strong); border-radius: 10px;
      width: min(640px, 92vw); max-height: 80vh; display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 60px var(--shadow);
    }
    .summary-modal .modal-header {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px;
    }
    .summary-modal .close-btn {
      font-size: 13px; border: none; background: none; color: inherit; cursor: pointer; opacity: 0.6;
    }
    .summary-modal .close-btn:hover { opacity: 1; }
    .summary-modal .summary-view {
      padding: 14px 18px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
      overflow-y: auto; flex: 1 1 auto; min-height: 0;
    }
  `;

  #channels = new Signal<DashboardChannel[]>([]);
  #rootConnections = new Signal<DashboardRootConnection[]>([]);
  #source?: EventSource;
  #justSent = new Signal<Set<string>>(new Set());
  #openModal = new Signal<{ channel: string; connectionId: string } | undefined>(undefined);
  #viewingSummary = new Signal<{ label: string; summary: string } | undefined>(undefined);
  // Ids of recentToolRegistrations entries already surfaced as a sticky
  // toast — the SSE snapshot resends the whole rolling log on every push,
  // so without this a page reconnect (or any unrelated change firing
  // another snapshot) would re-toast every entry in the log again.
  #toastedRegistrationIds = new Set<string>();
  // True once the first SSE snapshot has been processed — entries already
  // in the log on that first snapshot are pre-existing history, not new
  // events, so they're recorded as seen without toasting.
  #seenFirstSnapshot = false;
  #theme = new Signal<ThemeMode>(loadTheme());

  constructor() {
    super();
    new SignalWatcher(this);
    // Applied here (before first render), not just on toggle-click, so a
    // reload doesn't flash the default OS theme before the stored override
    // kicks in — see the pattern's own note on why this must happen early.
    applyTheme(this.#theme.value);
  }

  #cycleTheme() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(this.#theme.value) + 1) % THEME_CYCLE.length]!;
    this.#theme.set(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  }

  connectedCallback() {
    super.connectedCallback();
    this.#source = new EventSource('/api/dashboard/stream');
    this.#source.onmessage = (event) => {
      try {
        const snapshot = JSON.parse(event.data) as DashboardSnapshot;
        this.#channels.set(snapshot.channels);
        this.#rootConnections.set(snapshot.root);
        this.#toastNewRegistrations(snapshot.channels);
      } catch {
        // malformed event — ignore, next push will self-correct
      }
    };
  }

  // Fires one sticky toast per not-yet-seen entry across all channels' logs
  // (see Tenant.logToolRegistration) — on first connect this seeds
  // #toastedRegistrationIds from whatever's already in the log without
  // toasting it, so opening the dashboard doesn't replay every past
  // registration as a fresh notification.
  #toastNewRegistrations(channels: DashboardChannel[]) {
    const isFirstSnapshot = !this.#seenFirstSnapshot;
    this.#seenFirstSnapshot = true;
    for (const c of channels) {
      for (const r of c.recentToolRegistrations) {
        if (this.#toastedRegistrationIds.has(r.id)) continue;
        this.#toastedRegistrationIds.add(r.id);
        if (!isFirstSnapshot) toast.sticky(`New tool registered on "${c.channel}": ${r.name} — ${r.description}`);
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#source?.close();
  }

  // Human-triggered counterpart to the get_embed_snippet MCP tool
  // (hello-tools.ts) — same bare `import("<server>/main.js?...")`
  // one-liner shape, same root-vs-"channel:app-name" input convention and
  // validation as connect.js's own handleConnectClick, just invoked from
  // this dashboard button instead of by an agent. Unlike get_embed_snippet
  // (which needs the `port` handler arg since it runs in an arbitrary MCP
  // client process), this reads window.location.origin directly — the
  // dashboard IS served by js-bridge-mcp's own server, so its own origin
  // already IS the right server URL, no port-threading needed. The raw
  // input is passed straight through as `tenant=` — the server (ws.ts)
  // does the root-vs-channel colon interpretation, so this button doesn't
  // need to know that convention beyond validating a "channel:" prefix.
  async #copyEmbedSnippet() {
    let input = prompt('Connection name (root), or "channel:name" to join a shared channel:', '');
    if (!input) return;
    let parsed = parseChannelInput(input);
    while (parsed.channel !== undefined && !VALID_CHANNEL_NAME.test(parsed.channel)) {
      input = prompt(
        `"${parsed.channel}" isn't a valid channel name — only letters, digits, underscore, and hyphen are allowed (no spaces). Try again:`,
        `${sanitizeToValidChannelName(parsed.channel)}${parsed.appLabel ? `:${parsed.appLabel}` : ''}`
      );
      if (!input) return;
      parsed = parseChannelInput(input);
    }
    const serverUrl = window.location.origin;
    const moduleUrl = `${serverUrl}/main.js?server=${encodeURIComponent(serverUrl)}&tenant=${encodeURIComponent(input)}`;
    const snippet = `import(${JSON.stringify(moduleUrl)});`;
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success('Embed snippet copied');
    } catch {
      toast.danger('Could not copy to clipboard');
    }
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

  // Dashboard's "move to channel" action — groups a few connections by
  // moving them into the same channel (existing or brand new; a channel is
  // created on demand the moment a connection lands on it, same as
  // join_channel). Reuses connect.js's own channel-name validation/prompt
  // convention (no ":app" part here — moving only changes which channel a
  // connection is on, not its app label) so a typo gets the same
  // reprompt-with-a-suggested-fix loop as #copyEmbedSnippet/handleConnectClick.
  // The actual move is server-pushed (Tenant.moveConnection) to that
  // connection's own socket; this call just kicks it off and reports
  // success/failure — the SSE stream reflects the connection having moved
  // once its page reconnects to the new channel.
  async #moveConnection(channel: string, connectionId: string) {
    let input = prompt(`Move this connection to channel:`, channel);
    if (!input || input === channel) return;
    let target = input.trim();
    while (target && !VALID_CHANNEL_NAME.test(target)) {
      input = prompt(
        `"${target}" isn't a valid channel name — only letters, digits, underscore, and hyphen are allowed (no spaces). Try again:`,
        sanitizeToValidChannelName(target)
      );
      if (!input) return;
      target = input.trim();
    }
    if (!target || target === channel) return;
    try {
      const res = await fetch(`/api/dashboard/channels/${encodeURIComponent(channel)}/connections/${encodeURIComponent(connectionId)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetChannel: target }),
      });
      const data = await res.json();
      if (data.ok) toast.success(`Moving to "${target}"…`);
      else toast.danger(data.error ?? 'Move failed');
    } catch {
      toast.danger('Move failed — connection may have closed');
    }
  }

  render() {
    const channels = this.#channels.value;
    const root = this.#rootConnections.value;
    const modal = this.#openModal.value;
    return html`
      <div class="header-row">
        <div>
          <h1>Connected apps</h1>
          <p class="subtitle">Live connections and channels — updates automatically.</p>
        </div>
        <div class="header-actions">
          <a class="nav-link" href="/admin">Proxies (admin)</a>
          <a class="nav-link" href="/hub">Hub</a>
          <button class="copy-snippet-btn" @click=${() => this.#copyEmbedSnippet()}>Copy embed snippet…</button>
          <button
            class="theme-toggle"
            title=${`Theme: ${THEME_LABEL[this.#theme.value]} (click to change)`}
            aria-label="Toggle color theme"
            @click=${() => this.#cycleTheme()}
          >${THEME_ICON[this.#theme.value]}</button>
        </div>
      </div>
      ${channels.length === 0 && root.length === 0
        ? html`<div class="empty">Nothing connected yet. A connection appears here the moment a page bridges in or a proxy starts — as a flat root connection unless it explicitly joins a channel via join_channel.</div>`
        : html`
            ${root.map((rc) => this.#renderRootConnection(rc))}
            ${channels.map((c) => this.#renderChannel(c))}
          `}
      <docs-section></docs-section>
      ${modal
        ? html`<tools-modal
            .channel=${modal.channel}
            .connectionId=${modal.connectionId}
            @close=${() => this.#openModal.set(undefined)}
          ></tools-modal>`
        : ''}
      <toast-stack></toast-stack>
      ${this.#renderSummaryView()}
    `;
  }

  // Flat root-connection tile — reuses the same .connection-row styling as
  // a channel's own connection rows, just without the enclosing
  // .channel/.channel-header wrapper (there's nothing to group: a root
  // Tenant always has exactly one connection). Identify/move/view-tools
  // reuse the existing channel-scoped handlers by passing "root:<name>" as
  // the channel argument — the underlying REST routes already accept any
  // tenant id string transparently (see mcp-tenant-lib's dashboard.ts).
  #renderRootConnection(rc: DashboardRootConnection) {
    const rootId = `root:${rc.name}`;
    const key = `${rootId}::${rc.id}`;
    const sent = this.#justSent.value.has(key);
    return html`
      <div class="connection-row" style="border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
        <span class="connection-dot"></span>
        <span class="connection-kind" title=${KIND_TITLE[rc.kind]}>${KIND_ICON[rc.kind]}</span>
        <span class="connection-label">${rc.name}</span>
        <span
          class="connection-summary"
          title="Click to read the full description"
          @click=${() => this.#viewingSummary.set({ label: rc.name, summary: rc.summary ?? '' })}
        >${rc.summary ?? ''}</span>
        <button
          class="view-tools-btn"
          title="View tools"
          @click=${() => this.#openModal.set({ channel: rootId, connectionId: rc.id })}
        >
          ${rc.toolCount} tool${rc.toolCount === 1 ? '' : 's'}
        </button>
        ${rc.internal ? '' : html`
          <button
            class="identify-btn ${sent ? 'sent' : ''}"
            @click=${() => this.#identify(rootId, rc.id)}
          >
            ${sent ? 'Sent ✓' : 'Identify'}
          </button>
          <button
            class="move-btn"
            title="Move into a channel"
            @click=${() => this.#moveConnection(rootId, rc.id)}
          >
            Move…
          </button>
        `}
      </div>
    `;
  }

  #renderSummaryView() {
    const s = this.#viewingSummary.value;
    if (!s) return '';
    return html`
      <div class="summary-backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this.#viewingSummary.set(undefined); }}>
        <div class="summary-modal">
          <div class="modal-header">
            <strong>${s.label}</strong>
            <button class="close-btn" @click=${() => this.#viewingSummary.set(undefined)}>✕</button>
          </div>
          <div class="summary-view">${s.summary}</div>
        </div>
      </div>
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
                    <span class="connection-kind" title=${KIND_TITLE[conn.kind ?? 'browser']}>${KIND_ICON[conn.kind ?? 'browser']}</span>
                    <span class="connection-label">${conn.label ?? '(unlabeled)'}</span>
                    <span
                      class="connection-summary"
                      title="Click to read the full description"
                      @click=${() => this.#viewingSummary.set({ label: conn.label ?? '(unlabeled)', summary: conn.summary ?? '' })}
                    >${conn.summary ?? ''}</span>
                    <button
                      class="view-tools-btn"
                      title="View tools"
                      @click=${() => this.#openModal.set({ channel: c.channel, connectionId: conn.id })}
                    >
                      ${conn.toolCount} tool${conn.toolCount === 1 ? '' : 's'}
                    </button>
                    ${conn.internal ? '' : html`
                      <button
                        class="identify-btn ${sent ? 'sent' : ''}"
                        @click=${() => this.#identify(c.channel, conn.id)}
                      >
                        ${sent ? 'Sent ✓' : 'Identify'}
                      </button>
                      <button
                        class="move-btn"
                        title="Move to a different channel"
                        @click=${() => this.#moveConnection(c.channel, conn.id)}
                      >
                        Move…
                      </button>
                    `}
                  </div>
                `;
              })}
        </div>
      </div>
    `;
  }
}

customElements.define('dashboard-app', DashboardApp);
