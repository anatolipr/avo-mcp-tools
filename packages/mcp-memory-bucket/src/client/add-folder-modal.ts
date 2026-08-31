import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import { TENANT_ID, getFolderfooConfig } from './server-config.js';

interface FsListResponse {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

interface FolderfooFolder {
  path: string;
  createdAt: string;
}

interface SharedFolder {
  owner: string;
  path: string;
  role: 'member' | 'editor' | null;
}

export class AddFolderModal extends LitElement {
  static properties = {
    defaultKind: { attribute: false },
    lockKind: { attribute: false },
    onAdded: { attribute: false },
    onCancel: { attribute: false },
  };

  declare defaultKind: 'skill' | 'memory';
  declare lockKind: boolean;
  declare onAdded: (warning?: string) => void;
  declare onCancel: () => void;

  #kind = new Signal<'skill' | 'memory'>('skill');
  #source = new Signal<'local' | 'folderfoo'>('local');
  #currentPath = new Signal<string>('');
  #entries = new Signal<Array<{ name: string; path: string }>>([]);
  #parent = new Signal<string | null>(null);
  #selectedPath = new Signal<string>('');
  #name = new Signal<string>('');
  #error = new Signal<string>('');
  #submitting = new Signal<boolean>(false);
  #showHidden = new Signal<boolean>(false);
  #creatingFolder = new Signal<boolean>(false);
  #newFolderName = new Signal<string>('');

  // --- folderfoo (remote) connect state ---
  // Login itself happens through folderfoo's own <folderfoo-profile-circle>
  // widget (dynamically imported from `server`, exactly like bulletino and
  // every other folderfoo-consuming app embed it) rather than a hand-rolled
  // username/password form here - one familiar login UI, reused everywhere.
  // That widget's JWT lands in THIS page's localStorage (folderfoo_token,
  // same key folderfoo's own api-client.js uses) once logged in; #ffConnect
  // reads it back out and hands it to the server to persist for the Node
  // process, rather than prompting for credentials a second time.
  #ffServer = new Signal<string>('');
  #ffWidgetLoaded = new Signal<boolean>(false);
  #ffWidgetLoadError = new Signal<string>('');
  // True only for the auto-detected "page's circle is already logged in"
  // shortcut (#ffTryAutoConnect) - distinct from #ffWidgetLoaded so the
  // render logic can show "already signed in" instead of a login widget
  // that was never actually mounted for this path.
  #ffAutoConnecting = new Signal<boolean>(false);
  #ffTenantId = new Signal<string>('');
  #ffConnected = new Signal<boolean>(false);
  #ffConnecting = new Signal<boolean>(false);
  #ffFolders = new Signal<FolderfooFolder[]>([]);
  #ffSelectedFolderPath = new Signal<string>('');
  #ffSelectedOwner = new Signal<string>(''); // '' for one of the caller's own folders, else the sharer's username
  #ffLoadingFolders = new Signal<boolean>(false);
  #ffPollTimer?: ReturnType<typeof setInterval>;

  // --- "browse a folder shared with me" sub-mode of the connected folderfoo view ---
  #ffFolderSource = new Signal<'mine' | 'shared'>('mine');
  #ffSharedFolders = new Signal<SharedFolder[]>([]);
  #ffLoadingSharedFolders = new Signal<boolean>(false);
  // Once a shared root is picked from #ffSharedFolders, browsing INTO its subfolders reuses
  // #ffFolders (via listFolders' owner+rootFolder params) rather than a parallel list — the same
  // flat single-level picker as "mine" mode, just rooted at someone else's shared folder instead of
  // the caller's own root. null means "still choosing which shared root to browse."
  #ffSharedRoot = new Signal<SharedFolder | null>(null);

  static styles = css`
    :host { display: block; }
    .backdrop {
      position: fixed; inset: 0; background: var(--overlay);
      display: flex; align-items: center; justify-content: center; z-index: 100;
    }
    .modal {
      background: var(--bg);
      color: inherit;
      border-radius: 10px;
      width: min(560px, 92vw);
      max-height: 82vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 40px var(--shadow);
      border: 1px solid var(--border);
    }
    .header { padding: 16px 20px 8px; }
    h2 { margin: 0; font-size: 16px; }
    .kind-toggle { display: flex; gap: 8px; padding: 0 20px 12px; }
    .kind-toggle button {
      flex: 1; padding: 8px; border: 1px solid var(--border-strong); background: none; color: inherit;
      border-radius: 6px; cursor: pointer; font-size: 13px;
    }
    .kind-toggle button.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
    .breadcrumb-row {
      padding: 8px 20px; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .breadcrumb {
      font-size: 12px; opacity: 0.7; font-family: monospace;
      word-break: break-all;
    }
    .hidden-toggle {
      font-size: 11px; opacity: 0.7; display: flex; align-items: center; gap: 4px;
      cursor: pointer; white-space: nowrap; user-select: none;
    }
    .new-folder-btn {
      font-size: 11px; opacity: 0.7; background: none; border: none; color: inherit;
      cursor: pointer; white-space: nowrap; padding: 0;
    }
    .new-folder-btn:hover { opacity: 1; }
    .new-folder-row {
      padding: 8px 20px; display: flex; align-items: center; gap: 8px;
      border-top: 1px solid var(--border);
    }
    .new-folder-row input[type='text'] {
      flex: 1; padding: 5px 8px; font-size: 12px;
      border: 1px solid var(--border-strong); border-radius: 6px; background: none; color: inherit;
    }
    .new-folder-row button {
      font-size: 11px; padding: 5px 10px; border: 1px solid var(--border-strong); background: none;
      color: inherit; border-radius: 6px; cursor: pointer;
    }
    .browser {
      flex: 1; overflow-y: auto; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
      min-height: 200px;
    }
    .entry {
      padding: 8px 20px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 8px;
    }
    .entry:hover { background: var(--hover); }
    .entry .icon { opacity: 0.6; }
    .up { opacity: 0.7; }
    .empty { padding: 16px 20px; opacity: 0.6; font-size: 13px; }
    .footer { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
    .selected-row { font-size: 12px; }
    .selected-row .path { font-family: monospace; opacity: 0.85; word-break: break-all; }
    label { font-size: 12px; opacity: 0.7; display: block; margin-bottom: 4px; }
    input[type='text'] {
      width: 100%; box-sizing: border-box; padding: 7px 9px; font-size: 13px;
      border: 1px solid var(--border-strong); border-radius: 6px; background: none; color: inherit;
    }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
    button.primary {
      background: var(--accent); border: 1px solid var(--accent); color: var(--accent-fg); padding: 7px 16px;
      border-radius: 6px; cursor: pointer; font-size: 13px;
    }
    button.primary:disabled { opacity: 0.5; cursor: default; }
    button.secondary {
      background: none; border: 1px solid var(--border-strong); color: inherit; padding: 7px 16px;
      border-radius: 6px; cursor: pointer; font-size: 13px;
    }
    .error { color: var(--danger); font-size: 12px; }
    .source-toggle { display: flex; gap: 8px; padding: 0 20px 12px; }
    .source-toggle button {
      flex: 1; padding: 8px; border: 1px solid var(--border-strong); background: none; color: inherit;
      border-radius: 6px; cursor: pointer; font-size: 13px;
    }
    .source-toggle button.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
    .ff-body { padding: 4px 20px 14px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
    .ff-hint { font-size: 12px; opacity: 0.7; }
    .ff-connected-row {
      font-size: 12px; display: flex; align-items: center; gap: 6px; padding: 6px 0;
    }
    .ff-connected-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); display: inline-block; }
    .ff-folder-list { border: 1px solid var(--border); border-radius: 6px; max-height: 220px; overflow-y: auto; }
    .ff-folder-entry {
      padding: 8px 12px; cursor: pointer; font-size: 13px; font-family: monospace;
    }
    .ff-folder-entry:hover { background: var(--hover); }
    .ff-folder-entry.selected { background: var(--accent); color: var(--accent-fg); }
    .ff-empty { padding: 12px; opacity: 0.6; font-size: 13px; }
    .ff-widget-slot { display: flex; }
  `;

  constructor() {
    super();
    new SignalWatcher(this);
    this.defaultKind = 'skill';
    this.lockKind = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#kind.set(this.defaultKind);
    this.#browse();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.#ffPollTimer);
  }

  async #browse(path?: string) {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (this.#showHidden.value) params.set('hidden', '1');
    const res = await fetch(`/api/fs/list?${params.toString()}`);
    if (!res.ok) {
      this.#error.set((await res.json()).error ?? 'failed to list directory');
      return;
    }
    const data = (await res.json()) as FsListResponse;
    this.#currentPath.set(data.path);
    this.#parent.set(data.parent);
    this.#entries.set(data.entries);
    this.#error.set('');
    this.renderRoot.querySelector('.browser')?.scrollTo(0, 0);
  }

  #toggleHidden() {
    this.#showHidden.set(!this.#showHidden.value);
    this.#browse(this.#currentPath.value);
  }

  #startCreateFolder() {
    this.#newFolderName.set('');
    this.#creatingFolder.set(true);
  }

  #cancelCreateFolder() {
    this.#creatingFolder.set(false);
    this.#newFolderName.set('');
  }

  async #submitCreateFolder() {
    const name = this.#newFolderName.value.trim();
    if (!name) return;
    this.#error.set('');
    try {
      const res = await fetch('/api/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.#currentPath.value, name }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.#error.set(data.error ?? 'failed to create folder');
        return;
      }
      this.#creatingFolder.set(false);
      this.#newFolderName.set('');
      await this.#browse(this.#currentPath.value);
    } catch (err) {
      this.#error.set((err as Error).message);
    }
  }

  #selectCurrentAsFolder() {
    this.#selectedPath.set(this.#currentPath.value);
    if (!this.#name.value) {
      this.#name.set(this.#currentPath.value.split('/').filter(Boolean).pop() ?? '');
    }
  }

  async #submit() {
    const dirPath = this.#selectedPath.value || this.#currentPath.value;
    if (!dirPath) return;
    this.#submitting.set(true);
    this.#error.set('');
    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: this.#kind.value, name: this.#name.value || undefined, path: dirPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.#error.set(data.error ?? 'failed to add folder');
        return;
      }
      this.onAdded();
    } finally {
      this.#submitting.set(false);
    }
  }

  // Skips the manual "type a server URL, then log in" flow when the page's
  // own <folderfoo-profile-circle> (mem-bucket-app.ts's, scoped to the
  // server-resolved folderfooHost) already has a live session — the
  // overwhelmingly common case, since that widget is mounted (when
  // folderfooMode isn't "off") and likely already logged into by the time
  // this modal opens. Only short-circuits for THAT host specifically: a
  // DIFFERENT folderfoo deployment's session (a server the user types
  // manually) can't be detected this way, since that widget was never
  // mounted on this page to begin with - the manual flow still exists for
  // that case (or to add a second source on the same server under a
  // different login).
  async #ffTryAutoConnect() {
    if (this.#ffConnected.value) return;
    const { folderfooMode, folderfooHost } = await getFolderfooConfig();
    if (folderfooMode === 'off' || !folderfooHost) return; // no page-level widget was ever mounted - nothing to detect
    let token: string | null = null;
    try {
      token = localStorage.getItem('folderfoo_token');
    } catch {
      // localStorage unavailable - fall through to the manual flow
    }
    if (!token) return;
    this.#ffServer.set(folderfooHost);
    this.#ffTenantId.set(TENANT_ID);
    this.#ffAutoConnecting.set(true);
    this.#ffPersistToken(token);
  }

  // Dynamically imports folderfoo's own login widget from the user-entered
  // `server` (per the adding-folderfoo-integration skill's Step 4 pattern —
  // never a hand-rolled username/password form) and mounts it right in this
  // modal, scoped to that server. This is a DIFFERENT login target than the
  // page-level circle in mem-bucket-app.ts (which is always scoped to
  // memory-bucket's own tenant/server) — a remote source can point at any
  // folderfoo deployment the user has an account on, not just this app's own.
  async #ffLoadWidget() {
    if (!this.#ffServer.value) {
      this.#error.set('enter a server URL first');
      return;
    }
    this.#error.set('');
    try {
      await import(/* @vite-ignore */ `${this.#ffServer.value}/elements/folderfoo-profile-circle.js`);
      this.#ffWidgetLoaded.set(true);
      this.#ffWidgetLoadError.set('');
      await this.updateComplete;
      const container = this.renderRoot.querySelector('.ff-widget-slot');
      if (container && !container.querySelector('folderfoo-profile-circle')) {
        const el = document.createElement('folderfoo-profile-circle');
        el.setAttribute('app-name', 'Memory Bucket');
        container.appendChild(el);
      }
      // Poll localStorage for the token this widget's login flow writes,
      // rather than wiring a bespoke event - folderfoo-auth-change (see the
      // skill) is the documented signal, but polling here keeps this modal
      // decoupled from needing to import auth-guard.js just to listen for it.
      this.#ffPollTimer = setInterval(() => this.#ffCheckLoggedIn(), 800);
      this.#ffCheckLoggedIn();
    } catch (err) {
      this.#ffWidgetLoadError.set((err as Error).message);
    }
  }

  #ffCheckLoggedIn() {
    let token: string | null = null;
    try {
      token = localStorage.getItem('folderfoo_token');
    } catch {
      // localStorage unavailable - same posture as folderfoo's own widget, just no login detected
    }
    if (!token || this.#ffConnected.value) return;
    clearInterval(this.#ffPollTimer);
    this.#ffPersistToken(token);
  }

  async #ffPersistToken(token: string) {
    this.#ffConnecting.set(true);
    this.#error.set('');
    try {
      const res = await fetch('/api/folderfoo/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: this.#ffServer.value, token }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.#error.set(data.error ?? 'failed to persist folderfoo session');
        return;
      }
      this.#ffConnected.set(true);
      // tenantId is never user-entered — this app has exactly one fixed
      // tenant (TENANT_ID, "membkt") on whichever folderfoo deployment it
      // talks to, same as every other folderfoo-consuming app's own single
      // TENANT_ID constant (see server-config.ts).
      this.#ffTenantId.set(TENANT_ID);
      await this.#ffListFolders();
    } finally {
      this.#ffConnecting.set(false);
    }
  }

  // `owner`/`rootFolder`, when passed, browse INTO a folder someone else shared (see
  // #ffBrowseSharedRoot below) instead of the caller's own root — same list shape either way (see
  // folderfoo-client.ts's listFolders doc comment).
  async #ffListFolders(owner?: string, rootFolder?: string) {
    this.#ffLoadingFolders.set(true);
    this.#error.set('');
    try {
      const params = new URLSearchParams({ server: this.#ffServer.value, tenantId: this.#ffTenantId.value });
      if (owner) params.set('owner', owner);
      if (rootFolder) params.set('rootFolder', rootFolder);
      const res = await fetch(`/api/folderfoo/folders?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        this.#error.set(data.error ?? 'failed to list folderfoo folders');
        return;
      }
      this.#ffFolders.set(data as FolderfooFolder[]);
    } finally {
      this.#ffLoadingFolders.set(false);
    }
  }

  async #ffListSharedFolders() {
    this.#ffLoadingSharedFolders.set(true);
    this.#error.set('');
    try {
      const params = new URLSearchParams({ server: this.#ffServer.value, tenantId: this.#ffTenantId.value });
      const res = await fetch(`/api/folderfoo/shared-folders?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        this.#error.set(data.error ?? 'failed to list folders shared with you');
        return;
      }
      this.#ffSharedFolders.set(data as SharedFolder[]);
    } finally {
      this.#ffLoadingSharedFolders.set(false);
    }
  }

  #ffSwitchFolderSource(source: 'mine' | 'shared') {
    this.#ffFolderSource.set(source);
    this.#ffSharedRoot.set(null);
    this.#ffSelectedFolderPath.set('');
    this.#ffSelectedOwner.set('');
    if (source === 'shared' && this.#ffSharedFolders.value.length === 0) this.#ffListSharedFolders();
    else if (source === 'mine') this.#ffListFolders();
  }

  // Picks which shared root to browse subfolders of — a "member"-role (read-only) share is still
  // pickable here (browsing/connecting is read access), the role only gates WRITES later, via
  // folderfoo's own resolveUserDir(..., 'editor') check on every save/rename/trash call.
  #ffBrowseSharedRoot(root: SharedFolder) {
    this.#ffSharedRoot.set(root);
    this.#ffListFolders(root.owner, root.path);
  }

  #ffSelectFolder(folderPath: string, owner?: string) {
    this.#ffSelectedFolderPath.set(folderPath);
    this.#ffSelectedOwner.set(owner ?? '');
    if (!this.#name.value) {
      this.#name.set(folderPath.split('/').filter(Boolean).pop() ?? this.#ffTenantId.value);
    }
  }

  // Selects the shared root itself (not a subfolder browsed into it) — e.g. connecting "bbbmemz"
  // directly rather than something nested inside it.
  #ffSelectSharedRoot(root: SharedFolder) {
    this.#ffSelectFolder(root.path, root.owner);
  }

  async #ffSubmit() {
    if (!this.#ffSelectedFolderPath.value) return;
    this.#submitting.set(true);
    this.#error.set('');
    try {
      const res = await fetch('/api/remote-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: this.#kind.value,
          name: this.#name.value || undefined,
          server: this.#ffServer.value,
          tenantId: this.#ffTenantId.value,
          folderPath: this.#ffSelectedFolderPath.value,
          owner: this.#ffSelectedOwner.value || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.#error.set(data.error ?? 'failed to connect folder');
        return;
      }
      this.onAdded(data.kindMismatchWarning as string | undefined);
    } finally {
      this.#submitting.set(false);
    }
  }

  #renderLocal() {
    const entries = this.#entries.value;
    return html`
      <div class="breadcrumb-row">
        <div class="breadcrumb">${this.#currentPath.value}</div>
        <button class="new-folder-btn" @click=${() => this.#startCreateFolder()}>+ New folder</button>
        <label class="hidden-toggle">
          <input type="checkbox" .checked=${this.#showHidden.value} @change=${() => this.#toggleHidden()} />
          Show hidden
        </label>
      </div>
      ${this.#creatingFolder.value
        ? html`
            <div class="new-folder-row">
              <input
                type="text"
                placeholder="Folder name"
                .value=${this.#newFolderName.value}
                @input=${(e: Event) => this.#newFolderName.set((e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') this.#submitCreateFolder();
                  if (e.key === 'Escape') this.#cancelCreateFolder();
                }}
              />
              <button @click=${() => this.#submitCreateFolder()}>Create</button>
              <button @click=${() => this.#cancelCreateFolder()}>Cancel</button>
            </div>
          `
        : ''}
      <div class="browser">
        ${this.#parent.value
          ? html`<div class="entry up" @click=${() => this.#browse(this.#parent.value!)}>
              <span class="icon">📁</span> ..
            </div>`
          : ''}
        ${entries.length === 0 && !this.#parent.value
          ? html`<div class="empty">No subdirectories here.</div>`
          : entries.map(
              (e) => html`<div class="entry" @click=${() => this.#browse(e.path)}>
                <span class="icon">📁</span> ${e.name}
              </div>`
            )}
      </div>
      <div class="footer">
        <button class="secondary" @click=${() => this.#selectCurrentAsFolder()}>
          Select this folder
        </button>
        ${this.#selectedPath.value
          ? html`<div class="selected-row">Selected: <span class="path">${this.#selectedPath.value}</span></div>`
          : ''}
        <div>
          <label>Folder name</label>
          <input
            type="text"
            .value=${this.#name.value}
            placeholder="e.g. personal, company"
            @input=${(e: Event) => this.#name.set((e.target as HTMLInputElement).value)}
          />
        </div>
        ${this.#error.value ? html`<div class="error">${this.#error.value}</div>` : ''}
        <div class="actions">
          <button class="secondary" @click=${() => this.onCancel()}>Cancel</button>
          <button
            class="primary"
            ?disabled=${!this.#selectedPath.value || this.#submitting.value}
            @click=${() => this.#submit()}
          >
            ${this.#submitting.value ? 'Adding…' : 'Add folder'}
          </button>
        </div>
      </div>
    `;
  }

  #renderFolderfoo() {
    const folders = this.#ffFolders.value;
    if (this.#ffAutoConnecting.value && !this.#ffConnected.value) {
      return html`
        <div class="ff-body">
          <div class="ff-connected-row"><span class="ff-connected-dot"></span> Already signed in to ${this.#ffServer.value} — connecting…</div>
          ${this.#error.value ? html`<div class="error">${this.#error.value}</div>` : ''}
          <div class="actions">
            <button class="secondary" @click=${() => this.onCancel()}>Cancel</button>
          </div>
        </div>
      `;
    }
    if (!this.#ffConnected.value) {
      return html`
        <div class="ff-body">
          <div class="ff-hint">
            Sign in to a folderfoo server to mount one of your folders (or a folder shared with you) as a
            ${this.#kind.value === 'skill' ? 'skill' : 'memory'} source. Content stays live-synced from folderfoo —
            reads and writes go straight through, with a local cache for fast search.
          </div>
          <div>
            <label>Server URL</label>
            <input
              type="text"
              .value=${this.#ffServer.value}
              placeholder="https://folderfoo.example.com"
              ?disabled=${this.#ffWidgetLoaded.value}
              @input=${(e: Event) => this.#ffServer.set((e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.#ffLoadWidget()}
            />
          </div>
          ${!this.#ffWidgetLoaded.value
            ? html`
                <div class="actions" style="justify-content: flex-start; margin-top: 0;">
                  <button class="secondary" @click=${() => this.#ffLoadWidget()}>Continue</button>
                </div>
              `
            : html`
                <div class="ff-hint">Sign in below (this is folderfoo's own login widget, same one every folderfoo app uses):</div>
                <div class="ff-widget-slot"></div>
                ${this.#ffConnecting.value ? html`<div class="ff-hint">Finishing connection…</div>` : ''}
              `}
          ${this.#ffWidgetLoadError.value ? html`<div class="error">${this.#ffWidgetLoadError.value}</div>` : ''}
          ${this.#error.value ? html`<div class="error">${this.#error.value}</div>` : ''}
          <div class="actions">
            <button class="secondary" @click=${() => this.onCancel()}>Cancel</button>
          </div>
        </div>
      `;
    }

    const sharedFolders = this.#ffSharedFolders.value;
    const sharedRoot = this.#ffSharedRoot.value;
    return html`
      <div class="ff-body">
        <div class="ff-connected-row"><span class="ff-connected-dot"></span> Connected to ${this.#ffServer.value}</div>
        <div class="kind-toggle">
          <button
            class=${this.#ffFolderSource.value === 'mine' ? 'active' : ''}
            @click=${() => this.#ffSwitchFolderSource('mine')}
          >
            My folders
          </button>
          <button
            class=${this.#ffFolderSource.value === 'shared' ? 'active' : ''}
            @click=${() => this.#ffSwitchFolderSource('shared')}
          >
            Shared with me
          </button>
        </div>
        ${this.#ffFolderSource.value === 'mine'
          ? html`
              ${folders.length > 0
                ? html`
                    <div class="ff-folder-list">
                      ${folders.map(
                        (f) => html`<div
                          class="ff-folder-entry ${this.#ffSelectedFolderPath.value === f.path && !this.#ffSelectedOwner.value ? 'selected' : ''}"
                          @click=${() => this.#ffSelectFolder(f.path)}
                        >
                          ${f.path}
                        </div>`
                      )}
                    </div>
                  `
                : !this.#ffLoadingFolders.value
                  ? html`<div class="ff-empty">No folders found.</div>`
                  : html`<div class="ff-hint">Loading folders…</div>`}
            `
          : sharedRoot
            ? html`
                <div class="breadcrumb-row">
                  <div class="breadcrumb">${sharedRoot.owner}:${sharedRoot.path}</div>
                  <button class="new-folder-btn" @click=${() => this.#ffSwitchFolderSource('shared')}>← Back</button>
                </div>
                <div
                  class="ff-folder-entry ${this.#ffSelectedFolderPath.value === sharedRoot.path && this.#ffSelectedOwner.value === sharedRoot.owner ? 'selected' : ''}"
                  @click=${() => this.#ffSelectSharedRoot(sharedRoot)}
                >
                  (connect this folder itself)
                </div>
                ${folders.length > 0
                  ? html`
                      <div class="ff-folder-list">
                        ${folders.map(
                          (f) => html`<div
                            class="ff-folder-entry ${this.#ffSelectedFolderPath.value === f.path && this.#ffSelectedOwner.value === sharedRoot.owner ? 'selected' : ''}"
                            @click=${() => this.#ffSelectFolder(f.path, sharedRoot.owner)}
                          >
                            ${f.path}
                          </div>`
                        )}
                      </div>
                    `
                  : !this.#ffLoadingFolders.value
                    ? html`<div class="ff-empty">No subfolders.</div>`
                    : html`<div class="ff-hint">Loading folders…</div>`}
              `
            : html`
                ${sharedFolders.length > 0
                  ? html`
                      <div class="ff-folder-list">
                        ${sharedFolders.map(
                          (f) => html`<div class="ff-folder-entry" @click=${() => this.#ffBrowseSharedRoot(f)}>
                            ${f.path} <span style="opacity:0.6">— shared by ${f.owner}${f.role === 'member' ? ' (read-only)' : ''}</span>
                          </div>`
                        )}
                      </div>
                    `
                  : !this.#ffLoadingSharedFolders.value
                    ? html`<div class="ff-empty">No one has shared a folder with you yet.</div>`
                    : html`<div class="ff-hint">Loading shared folders…</div>`}
              `}
        ${this.#ffSelectedFolderPath.value
          ? html`<div class="selected-row">
              Selected: <span class="path">${this.#ffSelectedOwner.value ? `${this.#ffSelectedOwner.value}:` : ''}${this.#ffSelectedFolderPath.value}</span>
            </div>`
          : ''}
        <div>
          <label>Folder name</label>
          <input
            type="text"
            .value=${this.#name.value}
            placeholder="e.g. team-qa"
            @input=${(e: Event) => this.#name.set((e.target as HTMLInputElement).value)}
          />
        </div>
        ${this.#error.value ? html`<div class="error">${this.#error.value}</div>` : ''}
        <div class="actions">
          <button class="secondary" @click=${() => this.onCancel()}>Cancel</button>
          <button
            class="primary"
            ?disabled=${!this.#ffSelectedFolderPath.value || this.#submitting.value}
            @click=${() => this.#ffSubmit()}
          >
            ${this.#submitting.value ? 'Connecting…' : 'Connect folder'}
          </button>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="backdrop" @click=${(e: Event) => e.target === e.currentTarget && this.onCancel()}>
        <div class="modal">
          <div class="header"><h2>Add a folder</h2></div>
          ${this.lockKind
            ? html``
            : html`
                <div class="kind-toggle">
                  <button
                    class=${this.#kind.value === 'skill' ? 'active' : ''}
                    @click=${() => this.#kind.set('skill')}
                  >
                    Skill folder
                  </button>
                  <button
                    class=${this.#kind.value === 'memory' ? 'active' : ''}
                    @click=${() => this.#kind.set('memory')}
                  >
                    Memory folder
                  </button>
                </div>
              `}
          <div class="source-toggle">
            <button class=${this.#source.value === 'local' ? 'active' : ''} @click=${() => this.#source.set('local')}>
              Local folder
            </button>
            <button
              class=${this.#source.value === 'folderfoo' ? 'active' : ''}
              @click=${() => {
                this.#source.set('folderfoo');
                this.#ffTryAutoConnect();
              }}
            >
              Connect folderfoo
            </button>
          </div>
          ${this.#source.value === 'local' ? this.#renderLocal() : this.#renderFolderfoo()}
        </div>
      </div>
    `;
  }
}

customElements.define('add-folder-modal', AddFolderModal);
