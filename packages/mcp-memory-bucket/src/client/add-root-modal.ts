import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';

interface FsListResponse {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

export class AddRootModal extends LitElement {
  static properties = {
    defaultKind: { attribute: false },
    lockKind: { attribute: false },
    onAdded: { attribute: false },
    onCancel: { attribute: false },
  };

  declare defaultKind: 'skill' | 'memory';
  declare lockKind: boolean;
  declare onAdded: () => void;
  declare onCancel: () => void;

  #kind = new Signal<'skill' | 'memory'>('skill');
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

  #selectCurrentAsRoot() {
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
      const res = await fetch('/api/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: this.#kind.value, name: this.#name.value || undefined, path: dirPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.#error.set(data.error ?? 'failed to add root');
        return;
      }
      this.onAdded();
    } finally {
      this.#submitting.set(false);
    }
  }

  render() {
    const entries = this.#entries.value;
    return html`
      <div class="backdrop" @click=${(e: Event) => e.target === e.currentTarget && this.onCancel()}>
        <div class="modal">
          <div class="header"><h2>Add a root</h2></div>
          ${this.lockKind
            ? html``
            : html`
                <div class="kind-toggle">
                  <button
                    class=${this.#kind.value === 'skill' ? 'active' : ''}
                    @click=${() => this.#kind.set('skill')}
                  >
                    Skill root
                  </button>
                  <button
                    class=${this.#kind.value === 'memory' ? 'active' : ''}
                    @click=${() => this.#kind.set('memory')}
                  >
                    Memory root
                  </button>
                </div>
              `}
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
            <button class="secondary" @click=${() => this.#selectCurrentAsRoot()}>
              Select this folder
            </button>
            ${this.#selectedPath.value
              ? html`<div class="selected-row">Selected: <span class="path">${this.#selectedPath.value}</span></div>`
              : ''}
            <div>
              <label>Root name</label>
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
                ${this.#submitting.value ? 'Adding…' : 'Add root'}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('add-root-modal', AddRootModal);
