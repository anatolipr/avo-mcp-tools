// Chat-relay recipe management and bridge start - a separate component
// from popup-app.ts (rather than growing that already ~320-line file
// further) since recipe upload/list plus starting a bridge is a large,
// logically separate concern from the connect/rename/disconnect flow
// popup-app.ts already owns. Same avosignals Signal/SignalWatcher pattern
// as popup-app.ts, not Lit's own reactive properties, for consistency
// across this package's popup code.
//
// This panel has NO persistent session/status tracking - the extension
// background is fully stateless (see relay-chat-loop.ts's header comment).
// "Start bridging" is fire-and-forget beyond its immediate ok/error
// response: once the chat tab's loop is injected, this popup does not poll
// or track what it's doing. "Check status" is a deliberate exception - a
// one-shot, human-initiated read of window.__mcpRelayStats directly off the
// chat tab (not anything the background remembers), for a human to answer
// "is this still alive" without opening that tab's own DevTools console.
// Stopping a bridge means reloading or closing the chat tab - the "Reload
// chat tab" button below is a plain convenience wrapping chrome.tabs.reload,
// nothing more.
import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import { validateRecipe } from '../shared/recipe-validator.js';
import type { Recipe } from '../shared/recipe-types.js';
import type {
  ListRecipesResult,
  SaveRecipeResult,
  StartRelayBridgeResult,
  RelayCheckStatusResult,
  RelayPingTabResult,
  RelayListAppTabsResult,
  AddAppTabResult,
} from '../shared/types.js';

interface TabOption {
  id: number;
  title: string;
  hostname: string;
}

export class RelayPanel extends LitElement {
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
    select,
    input,
    button {
      width: 100%;
      box-sizing: border-box;
      padding: 6px;
      font-size: 13px;
      margin-top: 2px;
      background: light-dark(#ffffff, #27272a);
      color: light-dark(#111111, #f0f0f0);
      border: 1px solid light-dark(#d1d5db, #52525b);
      font-family: inherit;
    }
    button {
      margin-top: 8px;
      cursor: pointer;
    }
    button.secondary {
      background: light-dark(#f3f4f6, #27272a);
    }
    button.danger {
      background: light-dark(#fee2e2, #450a0a);
      color: light-dark(#991b1b, #fecaca);
      border: 1px solid light-dark(#fecaca, #7f1d1d);
    }
    ul {
      list-style: none;
      margin: 4px 0;
      padding: 0;
      font-size: 12px;
    }
    li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 4px 0;
      border-bottom: 1px solid light-dark(#e5e7eb, #3f3f46);
    }
    li button {
      width: auto;
      margin: 0;
      padding: 2px 6px;
    }
    .errors {
      font-size: 11px;
      color: light-dark(#991b1b, #fecaca);
      margin-top: 4px;
    }
    .errors li {
      border: none;
      padding: 1px 0;
      display: list-item;
      list-style: disc inside;
    }
    .status {
      font-size: 11px;
      color: light-dark(#666666, #a3a3a3);
    }
    .status.error {
      color: light-dark(#991b1b, #fecaca);
    }
    hr {
      margin: 12px 0;
      border: none;
      border-top: 1px solid light-dark(#e5e7eb, #3f3f46);
    }
  `;

  #recipes = new Signal<Recipe[]>([]);
  #tabs = new Signal<TabOption[]>([]);
  #uploadErrors = new Signal<string[]>([]);
  #chatTabId = new Signal<string>('');
  #appTabId = new Signal<string>('');
  #selectedRecipeId = new Signal<string>('');
  #statusText = new Signal<string>('');
  #statusIsError = new Signal<boolean>(false);
  #checkStatusResult = new Signal<RelayCheckStatusResult | undefined>(undefined);
  // Tags -> app tab id already bridged on the currently-selected chat tab
  // (read from that tab's own win.__mcpRelayAppTabs - see
  // relay-chat-loop.ts). undefined until #refreshAppTabs has run at least
  // once; empty-but-defined means "checked, no bridge active yet."
  #bridgedAppTabs = new Signal<Record<string, number> | undefined>(undefined);
  // Vetted candidates for "Add app tab": open tabs (minus the chat tab and
  // any already-bridged app tab) that responded ok to a ping. Populated by
  // #refreshAddCandidates, which the human triggers explicitly (pinging
  // every open tab on every popup render would be wasteful) via a "Find app
  // tabs" button.
  #addCandidates = new Signal<TabOption[]>([]);
  #addCandidatesChecked = new Signal<boolean>(false);
  #selectedAddTabId = new Signal<string>('');

  constructor() {
    super();
    new SignalWatcher(this);
  }

  connectedCallback() {
    super.connectedCallback();
    void Promise.all([this.#loadRecipes(), this.#loadTabs()]);
  }

  async #loadRecipes(): Promise<void> {
    const res: ListRecipesResult = await chrome.runtime.sendMessage({ type: 'list-recipes' });
    this.#recipes.set(res.recipes ?? []);
  }

  async #loadTabs(): Promise<void> {
    const tabs = await chrome.tabs.query({});
    const options: TabOption[] = [];
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      try {
        const url = new URL(tab.url);
        if (!/^https?:$/.test(url.protocol)) continue;
        options.push({ id: tab.id, title: tab.title || url.hostname, hostname: url.hostname });
      } catch {
        // not a parseable URL - skip
      }
    }
    this.#tabs.set(options);
  }

  #setStatus(text: string, isError = false): void {
    this.#statusText.set(text);
    this.#statusIsError.set(isError);
  }

  async #onUploadRecipe(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-uploading the same filename later
    if (!file) return;

    this.#uploadErrors.set([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      this.#uploadErrors.set([`"${file.name}" is not valid JSON: ${(err as Error).message}`]);
      return;
    }

    // Client-side validation first (selector-syntax checking needs
    // `document`, only available here in the popup, not in the background -
    // see recipe-validator.ts's header comment) - the background re-runs
    // validateRecipe too (minus the selector-syntax check) as defense in
    // depth before actually persisting.
    const localCheck = validateRecipe(parsed, new Set(this.#recipes.value.map((r) => r.id)));
    if (!localCheck.ok) {
      this.#uploadErrors.set(localCheck.errors);
      return;
    }

    const res: SaveRecipeResult = await chrome.runtime.sendMessage({ type: 'save-recipe', recipe: localCheck.recipe });
    if (!res.ok) {
      this.#uploadErrors.set(res.errors ?? ['Upload failed for an unknown reason.']);
      return;
    }
    await this.#loadRecipes();
  }

  async #onDeleteRecipe(id: string): Promise<void> {
    await chrome.runtime.sendMessage({ type: 'delete-recipe', id });
    await this.#loadRecipes();
  }

  async #onChatTabChange(value: string): Promise<void> {
    this.#chatTabId.set(value);
    // Excludes the chat tab from its own "app tab" pickers - a chat tab
    // bridging to itself is never meaningful, and it can't be pinged as a
    // human-mcp-relay app tab anyway (there is no popup UI to prevent it
    // otherwise, since #loadTabs's candidate list doesn't know which tab
    // the human is about to designate as "chat" until this fires).
    this.#addCandidates.set(this.#addCandidates.value.filter((t) => String(t.id) !== value));
    this.#addCandidatesChecked.set(false);
    await this.#refreshBridgedAppTabs();
  }

  // Reads the selected chat tab's own win.__mcpRelayAppTabs (see
  // relay-chat-loop.ts) so the "Add app tab" section can show what's
  // already bridged and exclude those tabs from candidates. Called after
  // picking a chat tab and after every successful Start/Add, never polled.
  async #refreshBridgedAppTabs(): Promise<void> {
    const chatTabId = Number(this.#chatTabId.value);
    if (!chatTabId) {
      this.#bridgedAppTabs.set(undefined);
      return;
    }
    const res: RelayListAppTabsResult = await chrome.runtime.sendMessage({ type: 'relay-list-app-tabs', chatTabId });
    this.#bridgedAppTabs.set(res.active ? res.appTabs : {});
  }

  async #onStartBridging(): Promise<void> {
    const chatTabId = Number(this.#chatTabId.value);
    const appTabId = Number(this.#appTabId.value);
    const recipeId = this.#selectedRecipeId.value;
    if (!chatTabId || !appTabId || !recipeId) {
      this.#setStatus('Pick a chat tab, an app tab, and a recipe first.', true);
      return;
    }
    this.#setStatus('Starting…');
    const res: StartRelayBridgeResult = await chrome.runtime.sendMessage({
      type: 'start-relay-bridge',
      chatTabId,
      appTabId,
      recipeId,
    });
    // Fire-and-forget beyond this point: the background holds no session
    // state to poll, and the chat tab's own injected loop runs
    // independently from here on. "Bridging started" only confirms the
    // injection itself succeeded, not that the loop is doing anything
    // useful yet.
    this.#setStatus(res.ok ? 'Bridging started.' : `Failed: ${res.error}`, !res.ok);
    if (res.ok) await this.#refreshBridgedAppTabs();
  }

  // Pings every open tab (minus the chat tab and any already-bridged app
  // tab) via handleRelayPingTab - an explicit, human-initiated action
  // rather than something run on every popup open, since pinging N tabs on
  // every render would be wasteful. Only tabs that actually respond
  // (window.__humanMcpRelay present and reachable) end up offered as "Add
  // app tab" candidates - an unpingable tab is never shown, per this
  // feature's whole point of only offering tabs that CAN be bridged.
  async #onFindAddCandidates(): Promise<void> {
    const chatTabId = Number(this.#chatTabId.value);
    if (!chatTabId) {
      this.#setStatus('Pick a chat tab first.', true);
      return;
    }
    this.#setStatus('Checking open tabs for human-mcp-relay…');
    const bridgedIds = new Set(Object.values(this.#bridgedAppTabs.value ?? {}));
    const candidates = this.#tabs.value.filter((t) => t.id !== chatTabId && !bridgedIds.has(t.id));
    const results = await Promise.all(
      candidates.map(async (tab) => {
        const res: RelayPingTabResult = await chrome.runtime.sendMessage({ type: 'relay-ping-tab', tabId: tab.id });
        return res.ok ? tab : undefined;
      })
    );
    this.#addCandidates.set(results.filter((t): t is TabOption => t !== undefined));
    this.#addCandidatesChecked.set(true);
    this.#setStatus(`Found ${this.#addCandidates.value.length} bridgeable tab(s).`);
  }

  async #onAddAppTab(): Promise<void> {
    const chatTabId = Number(this.#chatTabId.value);
    const appTabId = Number(this.#selectedAddTabId.value);
    if (!chatTabId || !appTabId) {
      this.#setStatus('Pick a tab to add first.', true);
      return;
    }
    this.#setStatus('Adding…');
    const res: AddAppTabResult = await chrome.runtime.sendMessage({ type: 'add-app-tab', chatTabId, appTabId });
    this.#setStatus(res.ok ? 'App tab added.' : `Failed: ${res.error}`, !res.ok);
    if (res.ok) {
      this.#selectedAddTabId.set('');
      this.#addCandidates.set(this.#addCandidates.value.filter((t) => t.id !== appTabId));
      await this.#refreshBridgedAppTabs();
    }
  }

  async #onReloadChatTab(): Promise<void> {
    const chatTabId = Number(this.#chatTabId.value);
    if (!chatTabId) {
      this.#setStatus('Pick a chat tab first.', true);
      return;
    }
    await chrome.tabs.reload(chatTabId);
    this.#checkStatusResult.set(undefined);
    this.#setStatus('Chat tab reloaded - any running bridge on it has stopped.');
  }

  async #onCheckStatus(): Promise<void> {
    const chatTabId = Number(this.#chatTabId.value);
    if (!chatTabId) {
      this.#setStatus('Pick a chat tab first.', true);
      return;
    }
    const res: RelayCheckStatusResult = await chrome.runtime.sendMessage({ type: 'relay-check-status', chatTabId });
    this.#checkStatusResult.set(res);
  }

  #formatStatus(s: RelayCheckStatusResult): string {
    if (s.error) return `Check failed: ${s.error}`;
    if (!s.active) return 'No bridge is running on this tab.';
    const ago = (ms?: number) => (ms === undefined ? 'never' : `${Math.round((Date.now() - ms) / 1000)}s ago`);
    let text = `Active. Started ${ago(s.startedAt)}. Polls: ${s.pollCount ?? 0} (last ${ago(s.lastPollAt)}). Rounds completed: ${s.roundsCompleted ?? 0}.`;
    if (s.lastError) text += ` Last error: ${s.lastError}`;
    return text;
  }

  render() {
    return html`
      <hr />
      <h2>Chat-relay recipes</h2>
      <ul>
        ${this.#recipes.value.map(
          (r) => html`
            <li>
              <span>${r.displayName ?? r.hostname} (${r.id})</span>
              <button class="danger" @click=${() => this.#onDeleteRecipe(r.id)}>Delete</button>
            </li>
          `
        )}
        ${this.#recipes.value.length === 0 ? html`<li><span class="status">No recipes uploaded yet.</span></li>` : ''}
      </ul>
      <label for="recipe-upload">Upload a recipe (.json)</label>
      <input id="recipe-upload" type="file" accept="application/json,.json" @change=${(e: Event) => this.#onUploadRecipe(e)} />
      ${this.#uploadErrors.value.length > 0
        ? html`<ul class="errors">
            ${this.#uploadErrors.value.map((err) => html`<li>${err}</li>`)}
          </ul>`
        : ''}

      <h2>Start bridging</h2>
      <label for="chat-tab-select">Chat tab</label>
      <select id="chat-tab-select" .value=${this.#chatTabId.value} @change=${(e: Event) => this.#onChatTabChange((e.target as HTMLSelectElement).value)}>
        <option value="">— pick a tab —</option>
        ${this.#tabs.value.map((t) => html`<option value=${t.id}>${t.title}</option>`)}
      </select>
      <label for="app-tab-select">App tab (running human-mcp-relay)</label>
      <select id="app-tab-select" .value=${this.#appTabId.value} @change=${(e: Event) => this.#appTabId.set((e.target as HTMLSelectElement).value)}>
        <option value="">— pick a tab —</option>
        ${this.#tabs.value
          .filter((t) => String(t.id) !== this.#chatTabId.value)
          .map((t) => html`<option value=${t.id}>${t.title}</option>`)}
      </select>
      <label for="recipe-select">Recipe</label>
      <select id="recipe-select" .value=${this.#selectedRecipeId.value} @change=${(e: Event) => this.#selectedRecipeId.set((e.target as HTMLSelectElement).value)}>
        <option value="">— pick a recipe —</option>
        ${this.#recipes.value.map((r) => html`<option value=${r.id}>${r.displayName ?? r.hostname}</option>`)}
      </select>
      <button @click=${() => this.#onStartBridging()}>Start bridging</button>
      <button class="secondary" @click=${() => this.#onCheckStatus()}>Check status</button>
      <button class="secondary" @click=${() => this.#onReloadChatTab()}>Reload chat tab (stops any running bridge)</button>
      <div class="status ${this.#statusIsError.value ? 'error' : ''}">${this.#statusText.value}</div>
      ${this.#checkStatusResult.value
        ? html`<div class="status">${this.#formatStatus(this.#checkStatusResult.value)}</div>`
        : ''}
      ${this.#renderAddAppTab()}
    `;
  }

  // Shown once the selected chat tab is known to already have a bridge
  // running (#bridgedAppTabs populated and non-empty active - see
  // #refreshBridgedAppTabs) - "Start bridging" above handles the very first
  // app tab, this handles every one after that. Reuses the same chat tab
  // selection above rather than asking again, per the "every next - just
  // the additional app tab" design.
  #renderAddAppTab() {
    const bridged = this.#bridgedAppTabs.value;
    if (!bridged || Object.keys(bridged).length === 0) return '';

    return html`
      <hr />
      <h2>Add app tab</h2>
      <ul>
        ${Object.entries(bridged).map(
          ([tag, tabId]) => html`<li><span>${tag || '(untagged)'} → tab ${tabId}</span></li>`
        )}
      </ul>
      <button class="secondary" @click=${() => this.#onFindAddCandidates()}>Find app tabs</button>
      ${this.#addCandidatesChecked.value
        ? html`
            <label for="add-tab-select">Tab to add</label>
            <select
              id="add-tab-select"
              .value=${this.#selectedAddTabId.value}
              @change=${(e: Event) => this.#selectedAddTabId.set((e.target as HTMLSelectElement).value)}
            >
              <option value="">— pick a tab —</option>
              ${this.#addCandidates.value.map((t) => html`<option value=${t.id}>${t.title}</option>`)}
            </select>
            ${this.#addCandidates.value.length === 0
              ? html`<div class="status">No open tabs responded as human-mcp-relay-ready.</div>`
              : ''}
            <button @click=${() => this.#onAddAppTab()}>Add app tab</button>
          `
        : ''}
    `;
  }
}

customElements.define('relay-panel', RelayPanel);
