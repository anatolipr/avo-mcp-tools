// Portable, host-agnostic popup for the human-relay MCP protocol prototype.
// Published standalone as the "human-mcp-relay" npm package - nothing here
// is specific to any one host app. Drop this one script tag into ANY page
// that exposes window.__mcpTools (the same array js-bridge-mcp's socket
// client reads, and the same contract e.g. mindfoo's mcpbridge.ts
// implements) and it self-registers a <human-mcp-relay> element plus a
// global keyboard shortcut to open it. Does not import or modify that host
// app's own mcpbridge file - it only reads window.__mcpTools/__mcpSummary at
// popup-open time, and reads document.title for display, so it needs zero
// per-app configuration to be pluggable elsewhere.
//
// Usage (identical in every host app), via jsDelivr - no install needed:
//   <script type="module"
//     src="https://cdn.jsdelivr.net/npm/human-mcp-relay@0/src/relay.js"></script>

import {LitElement, html, css} from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';
import {buildPrimer} from './primer.js';
import {parseCall, formatResult} from './protocol.js';

const OPEN_SHORTCUT = {key: 'a', metaOrCtrl: true, shift: true};

// Persisted per-origin so a given app's tab remembers its session name
// across reloads/reopens of the popup - set once when bridging multiple apps
// into one agent conversation, not re-typed every time.
const SESSION_NAME_STORAGE_KEY = 'human-mcp-relay:session-name';

class HumanMcpRelay extends LitElement {
  static properties = {
    open: {type: Boolean},
    primerText: {type: String},
    pasteText: {type: String},
    resultText: {type: String},
    statusText: {type: String},
    statusOk: {type: Boolean},
    sessionName: {type: String},
  };

  static styles = css`
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .panel {
      background: #1e1e1e;
      color: #e8e8e8;
      width: min(720px, 92vw);
      max-height: 88vh;
      overflow: auto;
      border-radius: 10px;
      padding: 20px 24px 24px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    }
    h2 {
      margin: 0 0 4px;
      font-size: 16px;
    }
    .sub {
      color: #999;
      font-size: 12px;
      margin: 0 0 16px;
    }
    section {
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: #bbb;
      margin-bottom: 6px;
    }
    textarea, input[type="text"] {
      width: 100%;
      box-sizing: border-box;
      background: #111;
      color: #d8d8d8;
      border: 1px solid #3a3a3a;
      border-radius: 6px;
      padding: 8px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    textarea {
      resize: vertical;
    }
    .row {
      display: flex;
      gap: 8px;
      margin-top: 6px;
    }
    button {
      background: #3a6ee0;
      color: white;
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    button.secondary {
      background: #333;
    }
    button:hover {
      filter: brightness(1.1);
    }
    .close {
      position: absolute;
      top: 14px;
      right: 16px;
      background: transparent;
      color: #999;
      font-size: 16px;
      padding: 2px 8px;
    }
    .status {
      font-size: 12px;
      margin-top: 6px;
    }
    .status.ok { color: #6bcf6b; }
    .status.err { color: #ff6b6b; }
    .missing {
      color: #ff6b6b;
      font-size: 13px;
    }
    .wrap {
      position: relative;
    }
  `;

  // Every event type worth isolating while the popup is open, so the host
  // page's own global listeners (keyboard shortcuts, drag/marquee-select,
  // etc.) never see interactions meant for this modal. Bound in the BUBBLE
  // phase directly on this element (not capture-phase on document) so the
  // event reaches our own descendant listeners (Lit's @click/@input/@focus
  // on buttons/textareas inside the shadow root) first, and is only stopped
  // once it's about to climb past this component into the host page. A
  // capture-phase document listener was tried first and broke every button
  // in the popup - it stopped the event during capture, before it ever
  // reached the target, so Lit's own @click handlers never ran.
  static _ISOLATED_EVENTS = [
    'keydown', 'keyup', 'keypress', 'copy', 'cut', 'paste',
    'click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'wheel',
    'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointercancel',
  ];

  constructor() {
    super();
    this.open = false;
    this.primerText = '';
    this.pasteText = '';
    this.resultText = '';
    this.statusText = '';
    this.statusOk = true;
    this.sessionName = '';
    try {
      this.sessionName = localStorage.getItem(SESSION_NAME_STORAGE_KEY) || '';
    } catch {
      // localStorage can throw (private mode, disabled storage) - just start blank.
    }
    this._toastTimer = undefined;
    this._onOpenShortcut = this._onOpenShortcut.bind(this);
    this._onIsolatedEvent = this._onIsolatedEvent.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    // Must stay on document/capture so the shortcut opens the popup no
    // matter where focus currently is on the host page, including while
    // closed - this is the one listener that legitimately needs to run
    // before anything else and outlive the popup being closed.
    document.addEventListener('keydown', this._onOpenShortcut, true);
    for (let type of HumanMcpRelay._ISOLATED_EVENTS) {
      this.addEventListener(type, this._onIsolatedEvent);
    }
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._onOpenShortcut, true);
    for (let type of HumanMcpRelay._ISOLATED_EVENTS) {
      this.removeEventListener(type, this._onIsolatedEvent);
    }
    super.disconnectedCallback();
  }

  // Bubble-phase listener on this element itself: by the time an event
  // reaches here it has already passed through and triggered every
  // descendant listener inside our shadow DOM (buttons, textareas), so
  // stopping it here only prevents it from continuing on to the host page's
  // own document-level listeners - it never blocks our own UI.
  _onIsolatedEvent(e) {
    if (!this.open) return;
    if (e.type === 'keydown' && e.key === 'Escape') {
      this.open = false;
    }
    e.stopPropagation();
  }

  // Global open/close shortcut - the only listener that must work even
  // while the popup is closed, so it stays on document/capture separately
  // from the isolation listeners above.
  _onOpenShortcut(e) {
    let metaOk = OPEN_SHORTCUT.metaOrCtrl ? (e.metaKey || e.ctrlKey) : true;
    if (metaOk && e.shiftKey === OPEN_SHORTCUT.shift && e.key.toLowerCase() === OPEN_SHORTCUT.key) {
      e.preventDefault();
      this._toggle();
    }
  }

  _toggle() {
    this.open = !this.open;
    if (this.open) {
      this._refreshPrimer();
      this.statusText = '';
    }
  }

  get _tools() {
    return window.__mcpTools || [];
  }

  _onSessionNameInput(e) {
    this.sessionName = e.target.value;
    try {
      if (this.sessionName) {
        localStorage.setItem(SESSION_NAME_STORAGE_KEY, this.sessionName);
      } else {
        localStorage.removeItem(SESSION_NAME_STORAGE_KEY);
      }
    } catch {
      // Non-fatal - the name just won't survive a reload in this tab.
    }
    this._refreshPrimer();
  }

  _refreshPrimer() {
    if (this._tools.length === 0) {
      this.primerText = '';
      return;
    }
    // window.__mcpSummary is intentionally NOT passed here - it's the full
    // joined text of every app_description topic (~35KB for htmlpaint),
    // meant to be fetched lazily one topic at a time via the app_description
    // tool (if the connected app exposes one), not pasted into every primer
    // up front. Pasting it here would defeat that design for the one MCP
    // client (this human-relay popup) that pays the primer's size cost on
    // every refresh, not just once.
    this.primerText = buildPrimer(this._tools, {
      appName: document.title,
      sessionName: this.sessionName,
    });
  }

  async _copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.statusOk = true;
      this.statusText = 'Copied to clipboard.';
    } catch (e) {
      this.statusOk = false;
      this.statusText = `Clipboard copy failed: ${e.message}. Select the text and copy manually.`;
    }
  }

  // Combined paste+run rather than two separate clicks - the paste is almost
  // never useful on its own without immediately running it, so this saves
  // the redundant second click for the common case.
  async _pasteAndRun() {
    try {
      this.pasteText = await navigator.clipboard.readText();
    } catch (e) {
      this.statusOk = false;
      // e.message is sometimes empty for a clipboard NotAllowedError in
      // Chrome, which made this look like a silent no-op - always include
      // e.name so there's something visible either way.
      this.statusText = `Clipboard read failed: ${e.name}${e.message ? ': ' + e.message : ''} ` +
        '(this can happen if the click that triggered it doesn\'t count as a fresh user gesture - try ' +
        'again, or click into the box and use Cmd/Ctrl+V instead).';
      console.error('[human-mcp] clipboard.readText() failed:', e);
      return;
    }
    await this._runPasted();
  }

  // Sets resultText and immediately copies it to the clipboard, so every
  // path through _runPasted (success, tool error, unknown tool, parse
  // failure) puts a ready-to-paste block on the clipboard without the human
  // needing a separate "Copy result" click - and shows a toast that fades
  // on its own rather than a persistent status line, since this replaces
  // the deliberate "click to copy" action with an automatic one.
  async _setResult(result) {
    this.resultText = formatResult(result, this.sessionName);
    try {
      await navigator.clipboard.writeText(this.resultText);
      this._showToast('Copied to clipboard.');
    } catch (e) {
      this._showToast(`Clipboard copy failed: ${e.message}. Use "Copy result" below instead.`, false);
    }
  }

  _showToast(text, ok = true) {
    this.statusOk = ok;
    this.statusText = text;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      if (this.statusText === text) this.statusText = '';
    }, 3000);
  }

  async _runPasted() {
    this.statusText = '';
    let call;
    try {
      call = parseCall(this.pasteText, this.sessionName);
    } catch (e) {
      // Even a malformed paste (bad JSON, missing sentinel, wrong shape)
      // gets a proper result block, not just a status line - the human
      // needs something copyable to hand back so the agent can see exactly
      // what parsing rejected and self-correct, instead of the human having
      // to paraphrase the error by hand.
      await this._setResult({tool: 'unknown', ok: false, error: e.message});
      return;
    }

    let tool = this._tools.find(t => t.name === call.tool);
    if (!tool) {
      let names = this._tools.map(t => t.name).join(', ');
      await this._setResult({
        tool: call.tool,
        ok: false,
        error: `Unknown tool "${call.tool}". Available tools: ${names}`,
      });
      return;
    }

    try {
      let data = await tool.fn(call.args);
      await this._setResult({tool: call.tool, ok: true, data});
    } catch (e) {
      await this._setResult({tool: call.tool, ok: false, error: e.message || String(e)});
    }
  }

  render() {
    if (!this.open) return html``;

    let toolsMissing = this._tools.length === 0;

    return html`
      <div class="backdrop" @click=${(e) => { if (e.target === e.currentTarget) this.open = false; }}>
        <div class="panel wrap">
          <button class="close" @click=${() => (this.open = false)}>&times;</button>
          <h2>human-relay MCP (prototype)</h2>
          <p class="sub">Cmd/Ctrl+Shift+A to toggle. Round-trip tool calls through a chat session with no direct MCP access.</p>

          ${toolsMissing
            ? html`<p class="missing">window.__mcpTools not found on this page - this popup needs this page's own mcpbridge-style tool array loaded first.</p>`
            : html`
              <section>
                <label>Session name (optional - set this when bridging more than one app in the same agent conversation)</label>
                <input type="text" placeholder="e.g. htmlpaint, mindfoo..."
                  .value=${this.sessionName}
                  @input=${(e) => this._onSessionNameInput(e)}
                  @focus=${(e) => e.target.select()} />
              </section>

              <section>
                <label>1. Primer - paste this into your agent/chat session first</label>
                <textarea readonly rows="8" .value=${this.primerText}></textarea>
                <div class="row">
                  <button @click=${() => this._copy(this.primerText)}>Copy primer</button>
                  <button class="secondary" @click=${() => this._refreshPrimer()}>Refresh</button>
                </div>
              </section>

              <section>
                <label>2. Paste the agent's HUMAN-MCP CALL block here</label>
                <textarea rows="6" placeholder='HUMAN-MCP CALL&#10;{"tool": "get_nodes", "args": {}}&#10;HUMAN-MCP END'
                  .value=${this.pasteText}
                  @input=${(e) => (this.pasteText = e.target.value)}
                  @focus=${(e) => e.target.select()}></textarea>
                <div class="row">
                  <button @click=${() => this._pasteAndRun()}>Paste &amp; Run</button>
                  <button class="secondary" @click=${() => this._runPasted()}>Run</button>
                </div>
              </section>

              <section>
                <label>3. Result - copy this back to the agent</label>
                <textarea readonly rows="8" .value=${this.resultText}></textarea>
                <div class="row">
                  <button @click=${() => this._copy(this.resultText)} ?disabled=${!this.resultText}>Copy result</button>
                </div>
              </section>

              ${this.statusText
                ? html`<div class="status ${this.statusOk ? 'ok' : 'err'}">${this.statusText}</div>`
                : ''}
            `}
        </div>
      </div>
    `;
  }
}

customElements.define('human-mcp-relay', HumanMcpRelay);

if (!document.querySelector('human-mcp-relay')) {
  let el = document.createElement('human-mcp-relay');
  document.body.appendChild(el);
}
