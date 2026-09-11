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
      transition: background-color 0.15s ease, border-color 0.15s ease;
    }
    button.flash {
      background: light-dark(#dcfce7, #14532d);
      border-color: light-dark(#86efac, #16a34a);
      color: light-dark(#166534, #bbf7d0);
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
      min-height: 14px;
    }
    .status.ok {
      color: light-dark(#166534, #bbf7d0);
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
  // 'ok' | 'error' | undefined (undefined only before the first status is
  // ever shown - #setStatus always passes one explicitly after that).
  #statusKind = new Signal<'ok' | 'error' | undefined>(undefined);
  // Which button (by a short id, e.g. 'copy-primer') most recently flashed -
  // see #flashButton. Compared against in render() to apply the .flash class
  // to just that one button, so a click on "Copy primer" doesn't also light
  // up "Copy result".
  #flashedButton = new Signal<string | undefined>(undefined);
  #statusTimer: ReturnType<typeof setTimeout> | undefined;
  #flashTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    new SignalWatcher(this);
  }

  connectedCallback() {
    super.connectedCallback();
    void this.#refreshPrimer();
  }

  disconnectedCallback() {
    clearTimeout(this.#statusTimer);
    clearTimeout(this.#flashTimer);
    super.disconnectedCallback();
  }

  // Same "toast that fades on its own" pattern as human-mcp-relay's own
  // relay.js (_showToast) - a status line that never clears left a stale
  // "Copied to clipboard." sitting there indefinitely, which reads as "did
  // my last click actually do anything?" on a second click. Always resets
  // the timer so a fresh status re-starts the same 3s window rather than
  // being cut short by an earlier click's timer.
  #setStatus(text: string, kind: 'ok' | 'error' = 'ok'): void {
    this.#statusText.set(text);
    this.#statusKind.set(kind);
    clearTimeout(this.#statusTimer);
    this.#statusTimer = setTimeout(() => {
      this.#statusText.set('');
      this.#statusKind.set(undefined);
    }, 3000);
  }

  // Briefly highlights the clicked button itself (not just the status line
  // below it, which can be easy to miss in a small popup) - the user asked
  // specifically for a visible color change on click, since it wasn't
  // obvious an action (e.g. copying the primer) had actually happened.
  #flashButton(id: string): void {
    this.#flashedButton.set(id);
    clearTimeout(this.#flashTimer);
    this.#flashTimer = setTimeout(() => this.#flashedButton.set(undefined), 400);
  }

  async #refreshPrimer(buttonId?: string): Promise<void> {
    const sessionName = this.#sessionName.value.trim() || undefined;
    const res: GetRelayPrimerResult = await chrome.runtime.sendMessage({ type: 'get-relay-primer', sessionName });
    if (res.ok) {
      this.#primer.set(res.primer ?? '');
      if (buttonId) {
        this.#flashButton(buttonId);
        this.#setStatus('Primer refreshed.');
      }
    } else {
      this.#setStatus(`Failed to build primer: ${res.error}`, 'error');
    }
  }

  async #onSessionNameChange(): Promise<void> {
    const tag = this.#sessionName.value.trim();
    const res: SetExtensionSessionNameResult = await chrome.runtime.sendMessage({ type: 'set-extension-session-name', tag });
    if (res.ok) await this.#refreshPrimer();
  }

  async #copy(text: string, label: string, buttonId: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.#flashButton(buttonId);
      this.#setStatus(`${label} copied to clipboard.`);
    } catch (err) {
      this.#setStatus(`Clipboard copy failed: ${(err as Error).message}. Select the text and copy manually.`, 'error');
    }
  }

  async #run(buttonId: string): Promise<void> {
    const sessionName = this.#sessionName.value.trim() || undefined;
    this.#setStatus('Running…');
    const res: RunHostToolCallResult = await chrome.runtime.sendMessage({
      type: 'run-host-tool-call',
      callText: this.#callInput.value,
      sessionName,
    });
    if (res.ok) {
      this.#resultText.set(res.resultText ?? '');
      this.#flashButton(buttonId);
      await this.#copy(res.resultText ?? '', 'Result', 'copy-result');
    } else {
      this.#setStatus(`Failed: ${res.error}`, 'error');
    }
  }

  async #pasteAndRun(): Promise<void> {
    try {
      this.#callInput.set(await navigator.clipboard.readText());
    } catch (err) {
      this.#setStatus(`Clipboard read failed: ${(err as Error).name}. Click into the box and use Cmd/Ctrl+V instead.`, 'error');
      return;
    }
    await this.#run('paste-and-run');
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
        <button class=${this.#flashedButton.value === 'copy-primer' ? 'flash' : ''} @click=${() => this.#copy(this.#primer.value, 'Primer', 'copy-primer')}>
          Copy primer
        </button>
        <button class=${this.#flashedButton.value === 'refresh-primer' ? 'flash' : ''} @click=${() => this.#refreshPrimer('refresh-primer')}>
          Refresh
        </button>
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
        <button class=${this.#flashedButton.value === 'run' ? 'flash' : ''} @click=${() => this.#run('run')}>Run</button>
      </div>

      <h2>3. Result — copy this back to the agent</h2>
      <textarea readonly rows="8" .value=${this.#resultText.value}></textarea>
      <button
        class=${this.#flashedButton.value === 'copy-result' ? 'flash' : ''}
        ?disabled=${!this.#resultText.value}
        @click=${() => this.#copy(this.#resultText.value, 'Result', 'copy-result')}
      >
        Copy result
      </button>

      <div class="status ${this.#statusKind.value ?? ''}">${this.#statusText.value}</div>
    `;
  }
}

customElements.define('relay-mode-panel', RelayModePanel);
