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
import { EXTENSION_APP_TAB_SENTINEL } from '../shared/constants.js';
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

// A TabOption that has also been pinged (see #onFindAddCandidates) and
// carries what that ping reported for the app's own human-mcp-relay session
// name - '' means the human never set one, which #onAddAppTab uses to
// decide whether to require a fresh one before allowing the add (see its
// own comment for why untagged can't just be silently allowed once a first
// app tab is already bridged).
interface AddCandidate extends TabOption {
  sessionName: string;
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
    li em {
      font-style: normal;
      color: light-dark(#666666, #a3a3a3);
      font-size: 11px;
      white-space: nowrap;
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
  // any already-bridged app tab) that responded ok to a ping - see
  // #onFindAddCandidates, which runs automatically once a bridge is
  // detected/started (#refreshBridgedAppTabs) and again on demand via
  // "Rescan open tabs".
  #addCandidates = new Signal<AddCandidate[]>([]);
  #addCandidatesChecked = new Signal<boolean>(false);
  #selectedAddTabId = new Signal<string>('');
  // Human-entered/edited session name for the selected "Add app tab"
  // candidate - always shown and always required (see #onAddAppTab),
  // pre-filled from that candidate's existing sessionName by
  // #onSelectAddCandidate so the human can just keep it if it's already
  // right, or change it.
  #newTagInput = new Signal<string>('');
  // Same idea as #newTagInput, for the FIRST app tab in "Start bridging" -
  // pre-filled by #onSelectAppTab, always required (see #onStartBridging).
  #firstAppTagInput = new Signal<string>('');

  constructor() {
    super();
    new SignalWatcher(this);
  }

  connectedCallback() {
    super.connectedCallback();
    void (async () => {
      await Promise.all([this.#loadRecipes(), this.#loadTabs()]);
      await this.#detectRunningBridge();
    })();
  }

  // Auto-detects an already-running bridge on popup open, so "Add app tab"
  // is available immediately without the human having to re-pick the same
  // chat tab from the dropdown every time they reopen the popup (which
  // wouldn't even work as a fix on its own - re-selecting the same value
  // doesn't fire a native <select> change event, and there was previously no
  // read of the chat tab's own state on open at all). Consistent with this
  // package's stateless design: nothing is remembered by the popup itself:
  // every open tab is probed fresh via relay-check-status (a one-shot read
  // of that tab's own win.__mcpRelayLoopActive - see relay-chat-loop.ts), and
  // whichever tab (if any) reports itself active is what gets pre-selected.
  // If more than one tab happens to have an active loop (a human bridged
  // more than one chat tab separately), none is auto-picked - that's
  // ambiguous, so the human still chooses manually in that case.
  async #detectRunningBridge(): Promise<void> {
    const results = await Promise.all(
      this.#tabs.value.map(async (tab) => {
        const res: RelayCheckStatusResult = await chrome.runtime.sendMessage({ type: 'relay-check-status', chatTabId: tab.id });
        return res.active ? tab : undefined;
      })
    );
    const active = results.filter((t): t is TabOption => t !== undefined);
    const [onlyActiveTab] = active;
    if (active.length !== 1 || !onlyActiveTab) return;
    this.#chatTabId.set(String(onlyActiveTab.id));
    await this.#refreshBridgedAppTabs();
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

  // Whether the currently-selected chat tab already has a bridge running -
  // used to hide the "Start bridging" fields (app tab / recipe / button)
  // once they're no longer relevant, replaced by the "Add app tab" section
  // below. Same underlying signal #renderAddAppTab already gates on.
  get #bridgeIsActive(): boolean {
    const bridged = this.#bridgedAppTabs.value;
    return !!bridged && Object.keys(bridged).length > 0;
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
  // picking a chat tab, after every successful Start/Add, and once on popup
  // open if a running bridge was auto-detected (#detectRunningBridge).
  // Immediately kicks off candidate discovery too (see
  // #onFindAddCandidates) so the "Add app tab" picker is ready the moment
  // its section appears, rather than needing a separate manual scan click
  // first - a human reopening the popup on an active bridge should see
  // everything they need in one screen.
  async #refreshBridgedAppTabs(): Promise<void> {
    const chatTabId = Number(this.#chatTabId.value);
    if (!chatTabId) {
      this.#bridgedAppTabs.set(undefined);
      return;
    }
    const res: RelayListAppTabsResult = await chrome.runtime.sendMessage({ type: 'relay-list-app-tabs', chatTabId });
    const appTabs = res.active ? res.appTabs : {};
    this.#bridgedAppTabs.set(appTabs);
    if (Object.keys(appTabs).length > 0) await this.#onFindAddCandidates();
  }

  // Resolves a bridged app tab's id to its current title via the already-
  // loaded #tabs list (from #loadTabs) - falls back to the raw id only if
  // that tab isn't in the list anymore (e.g. closed since bridging it,
  // which the loop itself has no way to detect since it only holds ids).
  #titleForTabId(tabId: number): string {
    if (tabId === EXTENSION_APP_TAB_SENTINEL) return 'This browser extension';
    return this.#tabs.value.find((t) => t.id === tabId)?.title ?? `tab ${tabId}`;
  }

  // Pings the picked app tab so its EXISTING session name (if any) shows up
  // pre-filled, ready to keep as-is or change - same pattern
  // #onSelectAddCandidate uses for "Add app tab", now applied to the first
  // app too for consistency (and because the name is required either way,
  // see #onStartBridging).
  async #onSelectAppTab(value: string): Promise<void> {
    this.#appTabId.set(value);
    this.#firstAppTagInput.set('');
    if (!value) return;
    const res: RelayPingTabResult = await chrome.runtime.sendMessage({ type: 'relay-ping-tab', tabId: Number(value) });
    if (res.ok) this.#firstAppTagInput.set(res.sessionName ?? '');
  }

  async #onStartBridging(): Promise<void> {
    const chatTabId = Number(this.#chatTabId.value);
    const appTabId = Number(this.#appTabId.value);
    const recipeId = this.#selectedRecipeId.value;
    if (!chatTabId || !appTabId || !recipeId) {
      this.#setStatus('Pick a chat tab, an app tab, and a recipe first.', true);
      return;
    }
    const assignTag = this.#firstAppTagInput.value.trim();
    if (!assignTag) {
      this.#setStatus('Type a session name for this app so the agent can address it distinctly.', true);
      return;
    }
    this.#setStatus('Starting…');
    const res: StartRelayBridgeResult = await chrome.runtime.sendMessage({
      type: 'start-relay-bridge',
      chatTabId,
      appTabId,
      recipeId,
      assignTag,
    });
    // Fire-and-forget beyond this point: the background holds no session
    // state to poll, and the chat tab's own injected loop runs
    // independently from here on. "Bridging started" only confirms the
    // injection itself succeeded, not that the loop is doing anything
    // useful yet.
    this.#setStatus(res.ok ? 'Bridging started.' : `Failed: ${res.error}`, !res.ok);
    if (res.ok) {
      this.#firstAppTagInput.set('');
      await this.#refreshBridgedAppTabs();
    }
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
        return res.ok ? { ...tab, sessionName: res.sessionName ?? '' } : undefined;
      })
    );
    this.#addCandidates.set(results.filter((t): t is AddCandidate => t !== undefined));
    this.#addCandidatesChecked.set(true);
    this.#setStatus(`Found ${this.#addCandidates.value.length} bridgeable tab(s).`);
  }

  // Always shown for the selected candidate (pre-filled with whatever
  // session name it already has, if any) rather than only appearing when
  // empty - keeps "Add app tab" and "Start bridging"'s own tag field
  // consistent, and lets the human rename an already-tagged app right here
  // instead of it being invisible. Always REQUIRED regardless: two untagged
  // app tabs can never be told apart, neither by this loop's own tag -> tab
  // map nor by the LLM reading HUMAN-MCP CALL/RESULT sentinels (see
  // human-mcp-relay/protocol.js's [sessionName] tagging), and since some
  // other app tab is always already bridged by the time "Add app tab" is
  // even shown, leaving this blank always risks that exact collision.
  async #onSelectAddCandidate(value: string): Promise<void> {
    this.#selectedAddTabId.set(value);
    const candidate = this.#addCandidates.value.find((t) => String(t.id) === value);
    this.#newTagInput.set(candidate?.sessionName ?? '');
  }

  async #onAddAppTab(): Promise<void> {
    const chatTabId = Number(this.#chatTabId.value);
    const appTabId = Number(this.#selectedAddTabId.value);
    if (!chatTabId || !appTabId) {
      this.#setStatus('Pick a tab to add first.', true);
      return;
    }
    const assignTag = this.#newTagInput.value.trim();
    if (!assignTag) {
      this.#setStatus('Type a session name for this app so the agent can address it distinctly.', true);
      return;
    }
    this.#setStatus('Adding…');
    const res: AddAppTabResult = await chrome.runtime.sendMessage({
      type: 'add-app-tab',
      chatTabId,
      appTabId,
      assignTag,
    });
    this.#setStatus(res.ok ? 'App tab added.' : `Failed: ${res.error}`, !res.ok);
    if (res.ok) {
      this.#selectedAddTabId.set('');
      this.#newTagInput.set('');
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
      ${this.#bridgeIsActive
        ? ''
        : html`
            <label for="app-tab-select">App tab (running human-mcp-relay)</label>
            <select id="app-tab-select" .value=${this.#appTabId.value} @change=${(e: Event) => this.#onSelectAppTab((e.target as HTMLSelectElement).value)}>
              <option value="">— pick a tab —</option>
              <option value=${EXTENSION_APP_TAB_SENTINEL}>— This browser extension —</option>
              ${this.#tabs.value
                .filter((t) => String(t.id) !== this.#chatTabId.value)
                .map((t) => html`<option value=${t.id}>${t.title}</option>`)}
            </select>
            <label for="recipe-select">Recipe</label>
            <select id="recipe-select" .value=${this.#selectedRecipeId.value} @change=${(e: Event) => this.#selectedRecipeId.set((e.target as HTMLSelectElement).value)}>
              <option value="">— pick a recipe —</option>
              ${this.#recipes.value.map((r) => html`<option value=${r.id}>${r.displayName ?? r.hostname}</option>`)}
            </select>
            <label for="first-app-tag-input">Session name (required - lets the agent address this app distinctly)</label>
            <input
              id="first-app-tag-input"
              type="text"
              placeholder="e.g. htmlpaint"
              .value=${this.#firstAppTagInput.value}
              @input=${(e: Event) => this.#firstAppTagInput.set((e.target as HTMLInputElement).value)}
            />
            <button @click=${() => this.#onStartBridging()}>Start bridging</button>
          `}
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
      <p class="status">Bridged app tabs:</p>
      <ul>
        ${Object.entries(bridged).map(
          ([tag, tabId]) => html`<li><span>${this.#titleForTabId(tabId)} ${tag ? html`<em>[${tag}]</em>` : html`<em>[untagged]</em>`}</span></li>`
        )}
      </ul>
      ${this.#addCandidatesChecked.value
        ? html`
            <label for="add-tab-select">Tab to add</label>
            <select
              id="add-tab-select"
              .value=${this.#selectedAddTabId.value}
              @change=${(e: Event) => this.#onSelectAddCandidate((e.target as HTMLSelectElement).value)}
            >
              <option value="">— pick a tab —</option>
              ${!Object.values(bridged).includes(EXTENSION_APP_TAB_SENTINEL)
                ? html`<option value=${EXTENSION_APP_TAB_SENTINEL}>— This browser extension —</option>`
                : ''}
              ${this.#addCandidates.value.map((t) => html`<option value=${t.id}>${t.title}${t.sessionName ? ` [${t.sessionName}]` : ''}</option>`)}
            </select>
            ${this.#addCandidates.value.length === 0
              ? html`<div class="status">No open tabs responded as human-mcp-relay-ready.</div>`
              : ''}
            <label for="new-tag-input">Session name (required - lets the agent address this app distinctly)</label>
            <input
              id="new-tag-input"
              type="text"
              placeholder="e.g. htmlpaint2"
              .value=${this.#newTagInput.value}
              @input=${(e: Event) => this.#newTagInput.set((e.target as HTMLInputElement).value)}
            />
            <button @click=${() => this.#onAddAppTab()}>Add app tab</button>
            <button class="secondary" @click=${() => this.#onFindAddCandidates()}>Rescan open tabs</button>`
        : html`<div class="status">Scanning open tabs…</div>`}
    `;
  }
}

customElements.define('relay-panel', RelayPanel);
