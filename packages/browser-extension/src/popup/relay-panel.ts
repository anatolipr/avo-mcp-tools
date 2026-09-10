// Chat-relay recipe management and session start/stop - a separate
// component from popup-app.ts (rather than growing that already ~320-line
// file further) since recipe upload/list/delete plus session start/stop is
// a large, logically separate concern from the connect/rename/disconnect
// flow popup-app.ts already owns. Same avosignals Signal/SignalWatcher
// pattern as popup-app.ts, not Lit's own reactive properties, for
// consistency across this package's popup code.
import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import { validateRecipe } from '../shared/recipe-validator.js';
import type {
  Recipe,
  RelaySession,
} from '../shared/recipe-types.js';
import type {
  ListRecipesResult,
  SaveRecipeResult,
  StartRelaySessionResult,
  ListRelaySessionsResult,
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
  #sessions = new Signal<RelaySession[]>([]);
  #tabs = new Signal<TabOption[]>([]);
  #uploadErrors = new Signal<string[]>([]);
  #chatTabId = new Signal<string>('');
  #appTabId = new Signal<string>('');
  #selectedRecipeId = new Signal<string>('');
  #statusText = new Signal<string>('');
  #statusIsError = new Signal<boolean>(false);

  constructor() {
    super();
    new SignalWatcher(this);
  }

  connectedCallback() {
    super.connectedCallback();
    void this.#refresh();
  }

  async #refresh(): Promise<void> {
    await Promise.all([this.#loadRecipes(), this.#loadSessions(), this.#loadTabs()]);
  }

  async #loadRecipes(): Promise<void> {
    const res: ListRecipesResult = await chrome.runtime.sendMessage({ type: 'list-recipes' });
    this.#recipes.set(res.recipes ?? []);
  }

  async #loadSessions(): Promise<void> {
    const res: ListRelaySessionsResult = await chrome.runtime.sendMessage({ type: 'list-relay-sessions' });
    this.#sessions.set(res.sessions ?? []);
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

  async #onStartBridging(): Promise<void> {
    const chatTabId = Number(this.#chatTabId.value);
    const appTabId = Number(this.#appTabId.value);
    const recipeId = this.#selectedRecipeId.value;
    if (!chatTabId || !appTabId || !recipeId) {
      this.#setStatus('Pick a chat tab, an app tab, and a recipe first.', true);
      return;
    }
    this.#setStatus('Starting…');
    const res: StartRelaySessionResult = await chrome.runtime.sendMessage({
      type: 'start-relay-session',
      chatTabId,
      appTabId,
      recipeId,
    });
    this.#setStatus(res.ok ? 'Bridging started.' : `Failed: ${res.error}`, !res.ok);
    await this.#loadSessions();
  }

  async #onStopSession(sessionId: string): Promise<void> {
    await chrome.runtime.sendMessage({ type: 'stop-relay-session', sessionId });
    await this.#loadSessions();
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
      <select id="chat-tab-select" .value=${this.#chatTabId.value} @change=${(e: Event) => this.#chatTabId.set((e.target as HTMLSelectElement).value)}>
        <option value="">— pick a tab —</option>
        ${this.#tabs.value.map((t) => html`<option value=${t.id}>${t.title}</option>`)}
      </select>
      <label for="app-tab-select">App tab (running human-mcp-relay)</label>
      <select id="app-tab-select" .value=${this.#appTabId.value} @change=${(e: Event) => this.#appTabId.set((e.target as HTMLSelectElement).value)}>
        <option value="">— pick a tab —</option>
        ${this.#tabs.value.map((t) => html`<option value=${t.id}>${t.title}</option>`)}
      </select>
      <label for="recipe-select">Recipe</label>
      <select id="recipe-select" .value=${this.#selectedRecipeId.value} @change=${(e: Event) => this.#selectedRecipeId.set((e.target as HTMLSelectElement).value)}>
        <option value="">— pick a recipe —</option>
        ${this.#recipes.value.map((r) => html`<option value=${r.id}>${r.displayName ?? r.hostname}</option>`)}
      </select>
      <button @click=${() => this.#onStartBridging()}>Start bridging</button>
      <div class="status ${this.#statusIsError.value ? 'error' : ''}">${this.#statusText.value}</div>

      <h2>Active sessions</h2>
      <ul>
        ${this.#sessions.value.map(
          (s) => html`
            <li>
              <span>${s.recipeId}: ${s.status}${s.lastError ? ` — ${s.lastError}` : ''}</span>
              <button class="danger" @click=${() => this.#onStopSession(s.id)}>Stop</button>
            </li>
          `
        )}
        ${this.#sessions.value.length === 0 ? html`<li><span class="status">No active sessions.</span></li>` : ''}
      </ul>
    `;
  }
}

customElements.define('relay-panel', RelayPanel);
