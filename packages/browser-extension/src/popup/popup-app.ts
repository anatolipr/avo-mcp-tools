import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import { JSBRIDGE_HOST, VALID_CHANNEL_NAME } from '../shared/constants.js';
import type { ConnectActiveTabResult, ActiveTabStatus, ActionResult } from '../shared/types.js';

// Structural subset of mcp-tenant-lib's DashboardChannel (dashboard.ts) -
// not imported directly, since that package's main entry pulls in
// server-only Node code (ws, etc.) that doesn't belong in a popup bundle;
// this is the same JSON shape GET /api/dashboard already returns.
interface DashboardChannel {
  channel: string;
  connections: { id: string; label: string | null }[];
}

export class PopupApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 280px;
      padding: 12px;
      box-sizing: border-box;
      font-family: system-ui, sans-serif;
      color-scheme: light dark;
      --bg: light-dark(#ffffff, #1a1a1a);
      --fg: light-dark(#111111, #f0f0f0);
      --fg-muted: light-dark(#666666, #a3a3a3);
      --border: light-dark(#e5e7eb, #3f3f46);
      --input-bg: light-dark(#ffffff, #27272a);
      --input-border: light-dark(#d1d5db, #52525b);
      --link: light-dark(#2563eb, #60a5fa);
      --status-connected-bg: light-dark(#dcfce7, #14532d);
      --status-connected-fg: light-dark(#166534, #bbf7d0);
      --status-disconnected-bg: light-dark(#fef9c3, #422006);
      --status-disconnected-fg: light-dark(#854d0e, #fde68a);
      --status-unconnectable-bg: light-dark(#f3f4f6, #27272a);
      --status-unconnectable-fg: light-dark(#666666, #a3a3a3);
      --danger-bg: light-dark(#fee2e2, #450a0a);
      --danger-fg: light-dark(#991b1b, #fecaca);
      --danger-border: light-dark(#fecaca, #7f1d1d);
      background: var(--bg);
      color: var(--fg);
    }
    h1 {
      font-size: 14px;
      margin: 0 0 8px;
    }
    label {
      display: block;
      font-size: 11px;
      color: var(--fg-muted);
      margin-top: 8px;
    }
    select,
    input,
    button {
      width: 100%;
      box-sizing: border-box;
      padding: 6px;
      font-size: 13px;
      margin-top: 2px;
      background: var(--input-bg);
      color: var(--fg);
      border: 1px solid var(--input-border);
      font-family: inherit;
    }
    button {
      margin-top: 12px;
      cursor: pointer;
    }
    #status,
    #result {
      font-size: 12px;
      margin-top: 6px;
    }
    #tab-status {
      font-size: 12px;
      padding: 6px 8px;
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .tool-count {
      font-weight: 600;
    }
    #dashboard-link {
      display: block;
      font-size: 12px;
      margin-bottom: 8px;
      color: var(--link);
      text-decoration: none;
    }
    #dashboard-link:hover {
      text-decoration: underline;
    }
    #tab-status.connected {
      background: var(--status-connected-bg);
      color: var(--status-connected-fg);
    }
    #tab-status.disconnected {
      background: var(--status-disconnected-bg);
      color: var(--status-disconnected-fg);
    }
    #tab-status.unconnectable {
      background: var(--status-unconnectable-bg);
      color: var(--status-unconnectable-fg);
    }
    .row {
      display: flex;
      gap: 4px;
    }
    .row input {
      flex: 1;
    }
    .row button {
      width: auto;
      margin-top: 2px;
      white-space: nowrap;
    }
    button.danger {
      background: var(--danger-bg);
      color: var(--danger-fg);
      border: 1px solid var(--danger-border);
    }
    hr {
      margin: 12px 0;
      border: none;
      border-top: 1px solid var(--border);
    }
  `;

  #tabStatus = new Signal<ActiveTabStatus | undefined>(undefined);
  #channels = new Signal<DashboardChannel[]>([]);
  #channelsError = new Signal<string | undefined>(undefined);
  #renameInput = new Signal('');
  #selectedChannel = new Signal('');
  #newChannel = new Signal('');
  #appLabel = new Signal('');
  #result = new Signal('');
  // When true, render() shows ONLY relay-mode-panel (plus a Close button) -
  // a deliberately uncluttered view for a human to copy a primer/paste a
  // CALL block, hiding the connect/rename/disconnect UI and <relay-panel>
  // entirely rather than showing both at once. See relay-mode-panel.ts's
  // header comment for how this differs from relay-panel.ts's own automated
  // "extension as app tab" bridging.
  #relayModeActive = new Signal(false);

  constructor() {
    super();
    new SignalWatcher(this);
  }

  connectedCallback() {
    super.connectedCallback();
    void this.#loadTabStatus();
    void this.#loadChannels();
  }

  async #loadTabStatus(): Promise<void> {
    const tabStatus: ActiveTabStatus = await chrome.runtime.sendMessage({ type: 'get-active-tab-status' });
    this.#tabStatus.set(tabStatus);
    this.#renameInput.set(tabStatus.knownAppLabel ?? '');
    if (!tabStatus.connected) this.#newChannel.set('');
  }

  async #loadChannels(): Promise<void> {
    try {
      const res = await fetch(`${JSBRIDGE_HOST}/api/dashboard`);
      if (!res.ok) throw new Error(`server responded ${res.status}`);
      this.#channels.set(await res.json());
      this.#channelsError.set(undefined);
    } catch (err) {
      this.#channelsError.set((err as Error).message);
    }
  }

  async #connect(): Promise<void> {
    const chosen = this.#newChannel.value.trim() || this.#selectedChannel.value;
    if (!chosen) {
      this.#result.set('Pick an existing channel or type a new one.');
      return;
    }
    if (!VALID_CHANNEL_NAME.test(chosen)) {
      this.#result.set('Channel names may only contain letters, digits, underscore, and hyphen.');
      return;
    }
    this.#result.set('Connecting…');
    const appLabel = this.#appLabel.value.trim() || undefined;
    const response: ConnectActiveTabResult = await chrome.runtime.sendMessage({
      type: 'connect-active-tab',
      channel: chosen,
      appLabel,
    });
    this.#result.set(response.ok ? `Connected to "${chosen}".` : `Failed: ${response.error}`);
    if (response.ok) await this.#loadTabStatus();
  }

  async #rename(): Promise<void> {
    const newLabel = this.#renameInput.value.trim();
    if (!newLabel) {
      this.#result.set('Enter a name to rename to.');
      return;
    }
    this.#result.set('Renaming…');
    const response: ActionResult = await chrome.runtime.sendMessage({ type: 'rename-active-tab', appLabel: newLabel });
    this.#result.set(response.ok ? `Renamed to "${newLabel}".` : `Failed: ${response.error}`);
    if (response.ok) await this.#loadTabStatus();
  }

  async #disconnect(): Promise<void> {
    this.#result.set('Disconnecting…');
    const response: ActionResult = await chrome.runtime.sendMessage({ type: 'disconnect-active-tab' });
    this.#result.set(response.ok ? 'Disconnected.' : `Failed: ${response.error}`);
    if (response.ok) await this.#loadTabStatus();
  }

  render() {
    if (this.#relayModeActive.value) {
      return html`
        <button id="relay-close-btn" @click=${() => this.#relayModeActive.set(false)}>← Close relay mode</button>
        <relay-mode-panel></relay-mode-panel>
      `;
    }

    const tabStatus = this.#tabStatus.value;
    const channelsError = this.#channelsError.value;

    return html`
      <h1>This tab</h1>
      ${this.#renderTabStatus(tabStatus)}
      <a id="dashboard-link" href=${JSBRIDGE_HOST} target="_blank" rel="noopener">Open js-bridge-mcp dashboard →</a>

      ${tabStatus?.connected
        ? html`
            <div id="connected-panel">
              <label for="rename-input">Connection name</label>
              <div class="row">
                <input
                  id="rename-input"
                  type="text"
                  placeholder="connection name"
                  .value=${this.#renameInput.value}
                  @input=${(e: InputEvent) => this.#renameInput.set((e.target as HTMLInputElement).value)}
                />
                <button id="rename-btn" @click=${() => this.#rename()}>Rename</button>
              </div>
              <button id="disconnect-btn" class="danger" @click=${() => this.#disconnect()}>Disconnect</button>
              <hr />
            </div>
          `
        : ''}

      <div id="status">
        ${channelsError
          ? `Can't reach js-bridge-mcp at ${JSBRIDGE_HOST} — is the server running? (${channelsError})`
          : `js-bridge-mcp is running at ${JSBRIDGE_HOST}.`}
      </div>
      <label for="channel-select" id="channel-label">
        ${tabStatus?.connected ? 'Switch to a different channel' : 'Existing channel'}
      </label>
      <select
        id="channel-select"
        .value=${this.#selectedChannel.value}
        @change=${(e: Event) => this.#selectedChannel.set((e.target as HTMLSelectElement).value)}
      >
        <option value="">${this.#channels.value.length ? '— pick a channel —' : '(no channels yet)'}</option>
        ${this.#channels.value.map(
          (ch) => html`
            <option value=${ch.channel}>
              ${ch.channel} (${ch.connections.length} connection${ch.connections.length === 1 ? '' : 's'})
            </option>
          `
        )}
      </select>
      <label for="new-channel">Or create a new channel</label>
      <input
        id="new-channel"
        type="text"
        placeholder="channel-name"
        .value=${this.#newChannel.value}
        @input=${(e: InputEvent) => this.#newChannel.set((e.target as HTMLInputElement).value)}
      />
      <label for="app-label" id="app-label-label">
        ${tabStatus?.connected ? 'Connection name for the new channel (optional)' : 'Connection name (optional)'}
      </label>
      <input
        id="app-label"
        type="text"
        placeholder="defaults to this site's hostname"
        .value=${this.#appLabel.value}
        @input=${(e: InputEvent) => this.#appLabel.set((e.target as HTMLInputElement).value)}
      />
      <button id="connect-btn" ?disabled=${!tabStatus?.connectable} @click=${() => this.#connect()}>Connect</button>
      <div id="result">${this.#result.value}</div>

      <hr />
      <button id="relay-mode-btn" @click=${() => this.#relayModeActive.set(true)}>Relay — manual copy/paste bridging</button>

      <relay-panel></relay-panel>
    `;
  }

  #renderTabStatus(tabStatus: ActiveTabStatus | undefined) {
    if (!tabStatus) return html`<div id="tab-status"></div>`;

    if (!tabStatus.connectable) {
      return html`<div id="tab-status" class="unconnectable">This tab can't be connected (not a regular http(s) page).</div>`;
    }

    // A page can be connected WITHOUT going through this extension's popup at
    // all - e.g. a page with its own hand-authored connect.js/snippet
    // (htmlpaint, bulletino, etc. all auto-connect themselves independently).
    // tabAlreadyConnected() correctly detects the live connection either way,
    // but knownChannel/knownAppLabel/toolCount only exist for connections
    // THIS extension itself made - show that distinction plainly instead of
    // a bare "?" placeholder.
    if (tabStatus.connected) {
      if (tabStatus.knownChannel) {
        const nameSuffix = tabStatus.knownAppLabel ? ` as "${tabStatus.knownAppLabel}"` : '';
        const toolSuffix =
          tabStatus.toolCount !== undefined
            ? html` — <span class="tool-count">${tabStatus.toolCount} tool${tabStatus.toolCount === 1 ? '' : 's'}</span>`
            : '';
        return html`<div id="tab-status" class="connected">✓ Connected to "${tabStatus.knownChannel}"${nameSuffix}${toolSuffix}.</div>`;
      }
      return html`<div id="tab-status" class="connected">
        ✓ Connected (by this page itself, not via this extension — channel/name unknown).
      </div>`;
    }

    if (tabStatus.knownChannel) {
      return html`<div id="tab-status" class="disconnected">Not currently connected (was on "${tabStatus.knownChannel}").</div>`;
    }
    return html`<div id="tab-status" class="disconnected">Not connected yet.</div>`;
  }
}

customElements.define('popup-app', PopupApp);
