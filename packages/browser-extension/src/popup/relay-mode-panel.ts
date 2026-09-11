// Manual human-relay UX for the extension's OWN tools (getHostTools(), see
// host-tools.ts), full parity with human-mcp-relay's own <human-mcp-relay>
// popup (session name field, "1. Primer" / "2. Paste CALL" / "3. Result"
// text areas) - but talking to this extension's background via
// chrome.runtime.sendMessage instead of reading window.__mcpTools directly,
// since the popup and background are separate JS realms and only the
// background can reach getHostTools() (see host-tool-relay.ts). This lets a
// human copy a primer for the extension's tools and paste it into ANY chat
// UI with zero automated bridging - the manual counterpart to relay-panel.ts's
// automated "extension as app tab" flow (see message-handler.ts's
// EXTENSION_APP_TAB_SENTINEL handling), sharing the same runCallAgainstHostTools/
// buildExtensionPrimer background helpers either way.
import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import type { GetRelayPrimerResult, RunHostToolCallResult, SetExtensionSessionNameResult } from '../shared/types.js';

export class RelayModePanel extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
      color-scheme: light dark;
    }
    h2 {
      font-size: 13px;
      margin: 12px 0 6px;
    }
    label {
      display: block;
      font-size: 11px;
      color: light-dark(#666666, #a3a3a3);
      margin-top: 8px;
    }
    input,
    textarea,
    button {
      width: 100%;
      box-sizing: border-box;
      padding: 6px;
      font-size: 12px;
      margin-top: 2px;
      background: light-dark(#ffffff, #27272a);
      color: light-dark(#111111, #f0f0f0);
      border: 1px solid light-dark(#d1d5db, #52525b);
      font-family: inherit;
    }
    textarea {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      resize: vertical;
      min-height: 90px;
    }
    button {
      margin-top: 6px;
      cursor: pointer;
      width: auto;
    }
    .row {
      display: flex;
      gap: 6px;
    }
    .row button {
      flex: 1;
    }
    .status {
      font-size: 11px;
      color: light-dark(#666666, #a3a3a3);
      margin-top: 6px;
    }
    .status.error {
      color: light-dark(#991b1b, #fecaca);
    }
  `;

  #sessionName = new Signal<string>('');
  #primer = new Signal<string>('');
  #callInput = new Signal<string>('');
  #resultText = new Signal<string>('');
  #statusText = new Signal<string>('');
  #statusIsError = new Signal<boolean>(false);

  constructor() {
    super();
    new SignalWatcher(this);
  }

  connectedCallback() {
    super.connectedCallback();
    void this.#refreshPrimer();
  }

  #setStatus(text: string, isError = false): void {
    this.#statusText.set(text);
    this.#statusIsError.set(isError);
  }

  async #refreshPrimer(): Promise<void> {
    const sessionName = this.#sessionName.value.trim() || undefined;
    const res: GetRelayPrimerResult = await chrome.runtime.sendMessage({ type: 'get-relay-primer', sessionName });
    if (res.ok) {
      this.#primer.set(res.primer ?? '');
    } else {
      this.#setStatus(`Failed to build primer: ${res.error}`, true);
    }
  }

  async #onSessionNameChange(): Promise<void> {
    const tag = this.#sessionName.value.trim();
    const res: SetExtensionSessionNameResult = await chrome.runtime.sendMessage({ type: 'set-extension-session-name', tag });
    if (res.ok) await this.#refreshPrimer();
  }

  async #copy(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.#setStatus(`${label} copied to clipboard.`);
    } catch (err) {
      this.#setStatus(`Clipboard copy failed: ${(err as Error).message}. Select the text and copy manually.`, true);
    }
  }

  async #run(): Promise<void> {
    const sessionName = this.#sessionName.value.trim() || undefined;
    this.#setStatus('Running…');
    const res: RunHostToolCallResult = await chrome.runtime.sendMessage({
      type: 'run-host-tool-call',
      callText: this.#callInput.value,
      sessionName,
    });
    if (res.ok) {
      this.#resultText.set(res.resultText ?? '');
      await this.#copy(res.resultText ?? '', 'Result');
    } else {
      this.#setStatus(`Failed: ${res.error}`, true);
    }
  }

  async #pasteAndRun(): Promise<void> {
    try {
      this.#callInput.set(await navigator.clipboard.readText());
    } catch (err) {
      this.#setStatus(`Clipboard read failed: ${(err as Error).name}. Click into the box and use Cmd/Ctrl+V instead.`, true);
      return;
    }
    await this.#run();
  }

  render() {
    return html`
      <label for="relay-session-name">Session name (optional — set this when bridging more than one app in the same agent conversation)</label>
      <input
        id="relay-session-name"
        type="text"
        placeholder="e.g. extension"
        .value=${this.#sessionName.value}
        @input=${(e: Event) => this.#sessionName.set((e.target as HTMLInputElement).value)}
        @change=${() => this.#onSessionNameChange()}
      />

      <h2>1. Primer — paste this into your agent/chat session first</h2>
      <textarea readonly rows="8" .value=${this.#primer.value}></textarea>
      <div class="row">
        <button @click=${() => this.#copy(this.#primer.value, 'Primer')}>Copy primer</button>
        <button @click=${() => this.#refreshPrimer()}>Refresh</button>
      </div>

      <h2>2. Paste the agent's HUMAN-MCP CALL block here</h2>
      <textarea
        rows="6"
        placeholder='HUMAN-MCP CALL&#10;{"tool": "get_console_log", "args": {}}&#10;HUMAN-MCP END'
        .value=${this.#callInput.value}
        @input=${(e: Event) => this.#callInput.set((e.target as HTMLTextAreaElement).value)}
      ></textarea>
      <div class="row">
        <button @click=${() => this.#pasteAndRun()}>Paste &amp; Run</button>
        <button @click=${() => this.#run()}>Run</button>
      </div>

      <h2>3. Result — copy this back to the agent</h2>
      <textarea readonly rows="8" .value=${this.#resultText.value}></textarea>
      <button ?disabled=${!this.#resultText.value} @click=${() => this.#copy(this.#resultText.value, 'Result')}>Copy result</button>

      <div class="status ${this.#statusIsError.value ? 'error' : ''}">${this.#statusText.value}</div>
    `;
  }
}

customElements.define('relay-mode-panel', RelayModePanel);
