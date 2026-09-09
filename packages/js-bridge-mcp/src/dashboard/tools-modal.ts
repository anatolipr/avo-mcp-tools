import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import { toast } from './toast.js';
import { downloadTool, readToolFile } from './tool-file.js';
import type { DashboardToolEntry } from './types.js';

type FormMode = 'path' | 'code';

/**
 * Per-connection tools-visualizer modal: browse a bridged tab's registered
 * tools (name + description, tagged host vs. dynamic), view the JS source
 * (or window.* path) a dynamic tool was defined from via a "</>" button
 * that opens a small code-view sub-dialog (see #renderCodeView — no button
 * when `origin` is absent, e.g. tools registered via a raw
 * window.__mcpToolBus.registerTool() DevTools paste), register a new one
 * (pointing at an existing window.* function, or supplying fresh code), and
 * unregister a previously dynamically-added tool. Dynamic tools with an
 * `origin` can also be saved to a `.tool.json` file (per-row save button,
 * or select several via checkbox and "Export selected" for one file each)
 * and later restored via the "Import tool(s)" file picker, which replays
 * them through the same register-by-path/register-by-code REST routes as
 * the add-form below (see #registerTool). `channel`/`connectionId` are set
 * as plain properties by whoever opens it (dashboard-app.ts).
 *
 * Data is fetched on open only (no SSE) — see the GET .../tools REST route
 * in mcp-tenant-lib's dashboard.ts. Registration/unregistration go through
 * the SAME REST routes (and therefore the SAME Tenant.call(...) mechanism)
 * the register_page_tool_by_path/_by_code/unregister_page_tool MCP tools
 * use — one implementation, two front doors. Registration (by either front
 * door) takes effect immediately, with no human approval step of any kind —
 * it's only logged as a sticky toast on this dashboard afterward, for
 * awareness, not as a gate. Nothing in this modal blocks on that toast.
 */
export class ToolsModal extends LitElement {
  static styles = css`
    :host { display: block; }
    .backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 1000;
      display: flex; align-items: center; justify-content: center;
    }
    .modal {
      background: var(--bg); border: 1px solid var(--border-strong); border-radius: 10px;
      width: min(560px, 92vw); max-height: 85vh; display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 60px var(--shadow);
    }
    .modal-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 18px; border-bottom: 1px solid var(--border);
    }
    .modal-header strong { font-family: ui-monospace, monospace; font-size: 13px; }
    .close-btn {
      border: none; background: none; color: inherit; opacity: 0.6; cursor: pointer; font-size: 14px;
    }
    .close-btn:hover { opacity: 1; }
    .modal-body { overflow-y: auto; padding: 14px 18px; flex: 1; }
    .empty { font-size: 12px; opacity: 0.6; font-style: italic; }
    .tool-row {
      display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border);
    }
    .tool-row:last-child { border-bottom: none; }
    .tool-name { font-family: ui-monospace, monospace; font-size: 12px; font-weight: 600; flex: 0 0 auto; }
    .tool-desc {
      font-size: 12px; opacity: 0.75; flex: 1 1 auto; min-width: 0; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .tool-desc:hover { opacity: 1; text-decoration: underline dotted; }
    .badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; flex: 0 0 auto; }
    .badge.host { background: var(--hover); opacity: 0.7; }
    .badge.dynamic { background: var(--accent-tint); color: var(--accent); }
    .unregister-btn {
      font-size: 12px; border: none; background: none; color: var(--danger); cursor: pointer;
      opacity: 0.7; flex: 0 0 auto; padding: 0 2px;
    }
    .unregister-btn:hover { opacity: 1; }
    .view-code-btn, .save-btn {
      font-size: 12px; border: none; background: none; color: inherit; cursor: pointer;
      opacity: 0.6; flex: 0 0 auto; padding: 0 2px;
    }
    .view-code-btn:hover, .save-btn:hover { opacity: 1; }
    .select-checkbox { flex: 0 0 auto; margin: 0; }
    .export-toolbar {
      display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 12px;
    }
    .export-toolbar button {
      font-size: 12px; padding: 3px 10px; border-radius: 6px;
      border: 1px solid var(--border-strong); background: var(--bg); color: inherit; cursor: pointer;
    }
    .export-toolbar button:hover:not(:disabled) { background: var(--hover); border-color: var(--accent); }
    .export-toolbar button:disabled { opacity: 0.5; cursor: default; }
    .import-label {
      font-size: 12px; padding: 3px 10px; border-radius: 6px;
      border: 1px solid var(--border-strong); background: var(--bg); cursor: pointer;
    }
    .import-label:hover { background: var(--hover); border-color: var(--accent); }
    .import-label input[type='file'] { display: none; }
    .code-backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 1001;
      display: flex; align-items: center; justify-content: center;
    }
    .code-modal {
      background: var(--bg); border: 1px solid var(--border-strong); border-radius: 10px;
      width: min(640px, 92vw); max-height: 80vh; display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 60px var(--shadow);
    }
    .code-modal pre {
      margin: 0; padding: 14px 18px; overflow: auto; font-family: ui-monospace, monospace;
      font-size: 12px; white-space: pre-wrap; word-break: break-word; flex: 1 1 auto; min-height: 0;
    }
    .code-modal .path-view { padding: 14px 18px; font-family: ui-monospace, monospace; font-size: 12px; }
    .code-modal .desc-view {
      padding: 14px 18px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
      overflow-y: auto; flex: 1 1 auto; min-height: 0;
    }
    .add-form { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
    .add-form h3 { font-size: 13px; margin: 0 0 10px; }
    .mode-toggle { display: flex; gap: 12px; margin-bottom: 10px; font-size: 12px; }
    .mode-toggle label { display: flex; align-items: center; gap: 4px; cursor: pointer; flex: 1; white-space: nowrap; }
    .add-form input, .add-form textarea {
      width: 100%; box-sizing: border-box; font-size: 12px; padding: 6px 8px; margin-bottom: 8px;
      border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); color: inherit;
      font-family: inherit;
    }
    .add-form textarea { font-family: ui-monospace, monospace; min-height: 80px; resize: vertical; }
    .submit-btn {
      font-size: 12px; padding: 6px 14px; border-radius: 6px;
      border: 1px solid var(--border-strong); background: var(--bg); color: inherit; cursor: pointer;
    }
    .submit-btn:hover:not(:disabled) { background: var(--hover); border-color: var(--accent); }
    .submit-btn:disabled { opacity: 0.5; cursor: default; }
  `;

  channel = '';
  connectionId = '';

  #tools = new Signal<DashboardToolEntry[] | undefined>(undefined);
  #mode = new Signal<FormMode>('path');
  #submitting = new Signal(false);
  #viewingCode = new Signal<DashboardToolEntry | undefined>(undefined);
  #viewingDescription = new Signal<DashboardToolEntry | undefined>(undefined);
  #selected = new Signal<Set<string>>(new Set());
  #importing = new Signal(false);

  constructor() {
    super();
    new SignalWatcher(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this.#load();
  }

  #base(): string {
    return `/api/dashboard/channels/${encodeURIComponent(this.channel)}/connections/${encodeURIComponent(this.connectionId)}`;
  }

  async #load() {
    try {
      const res = await fetch(`${this.#base()}/tools`);
      if (!res.ok) throw new Error('failed to load tools');
      const data = await res.json();
      this.#tools.set(data.tools);
    } catch {
      toast.danger('Could not load tools for this connection');
      this.#tools.set([]);
    }
  }

  #close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  async #unregister(toolName: string) {
    try {
      const res = await fetch(`${this.#base()}/tools/${encodeURIComponent(toolName)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'unregister failed');
      toast.success(`Unregistered "${toolName}"`);
      await this.#load();
    } catch (err) {
      toast.danger((err as Error).message);
    }
  }

  /** Shared by the add-form below and #importFiles — same two REST routes either way. Throws on failure; caller decides how to report it. */
  async #registerTool(name: string, description: string, origin: { kind: 'path'; path: string } | { kind: 'code'; code: string }) {
    const endpoint = origin.kind === 'path' ? 'register-by-path' : 'register-by-code';
    const body = origin.kind === 'path' ? { name, description, path: origin.path } : { name, description, code: origin.code };
    const res = await fetch(`${this.#base()}/tools/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? 'registration failed');
  }

  async #submitAdd(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    const name = String(fd.get('name') ?? '').trim();
    const description = String(fd.get('description') ?? '').trim();
    const mode = this.#mode.value;
    const pathOrCode = String(fd.get(mode === 'path' ? 'path' : 'code') ?? '').trim();
    if (!name || !description || !pathOrCode) {
      toast.danger('Fill in all fields');
      return;
    }
    this.#submitting.set(true);
    try {
      await this.#registerTool(name, description, mode === 'path' ? { kind: 'path', path: pathOrCode } : { kind: 'code', code: pathOrCode });
      toast.success(`Registered "${name}"`);
      form.reset();
      await this.#load();
    } catch (err) {
      toast.danger((err as Error).message);
    } finally {
      this.#submitting.set(false);
    }
  }

  #toggleSelected(name: string, checked: boolean) {
    const next = new Set(this.#selected.value);
    if (checked) next.add(name);
    else next.delete(name);
    this.#selected.set(next);
  }

  /** Downloads each selected tool as its own `<name>.tool.json` file (per user request: separate files, not one bundle). */
  #exportSelected() {
    const tools = this.#tools.value ?? [];
    for (const name of this.#selected.value) {
      const t = tools.find((x) => x.name === name);
      if (t?.origin) downloadTool(t.name, t.description, t.origin);
    }
    this.#selected.set(new Set());
  }

  #exportOne(t: DashboardToolEntry) {
    if (t.origin) downloadTool(t.name, t.description, t.origin);
  }

  async #importFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    if (files.length === 0) return;
    this.#importing.set(true);
    let ok = 0;
    const errors: string[] = [];
    try {
      for (const file of files) {
        try {
          const parsed = await readToolFile(file);
          await this.#registerTool(parsed.name, parsed.description, parsed.origin);
          ok++;
        } catch (err) {
          errors.push(`${file.name}: ${(err as Error).message}`);
        }
      }
      if (ok > 0) toast.success(ok === 1 ? 'Registered 1 tool from file' : `Registered ${ok} tools from files`);
      for (const msg of errors) toast.danger(msg);
      if (ok > 0) await this.#load();
    } finally {
      this.#importing.set(false);
      input.value = '';
    }
  }

  render() {
    const tools = this.#tools.value;
    const mode = this.#mode.value;
    const selected = this.#selected.value;
    const savableCount = (tools ?? []).filter((t) => t.source === 'dynamic' && t.origin).length;
    return html`
      <div class="backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this.#close(); }}>
        <div class="modal">
          <div class="modal-header">
            <strong>Tools — ${this.connectionId}</strong>
            <button class="close-btn" @click=${() => this.#close()}>✕</button>
          </div>
          <div class="modal-body">
            ${tools !== undefined
              ? html`
                  <div class="export-toolbar">
                    ${savableCount > 0
                      ? html`<button ?disabled=${selected.size === 0} @click=${() => this.#exportSelected()}>
                          Export selected${selected.size > 0 ? ` (${selected.size})` : ''}
                        </button>`
                      : ''}
                    <label class="import-label">
                      ${this.#importing.value ? 'Importing…' : 'Import tool(s)'}
                      <input type="file" accept=".json" multiple ?disabled=${this.#importing.value} @change=${(e: Event) => this.#importFiles(e)} />
                    </label>
                  </div>
                `
              : ''}
            ${tools === undefined
              ? html`<p class="empty">Loading…</p>`
              : tools.length === 0
              ? html`<p class="empty">No tools registered.</p>`
              : tools.map(
                  (t) => html`
                    <div class="tool-row">
                      ${t.source === 'dynamic' && t.origin
                        ? html`<input
                            class="select-checkbox"
                            type="checkbox"
                            title="Select for export"
                            .checked=${selected.has(t.name)}
                            @change=${(e: Event) => this.#toggleSelected(t.name, (e.target as HTMLInputElement).checked)}
                          />`
                        : ''}
                      <span class="badge ${t.source}">${t.source}</span>
                      <span class="tool-name">${t.name}</span>
                      <span class="tool-desc" title="Click to read the full description" @click=${() => this.#viewingDescription.set(t)}>${t.description}</span>
                      ${t.source === 'dynamic' && t.origin
                        ? html`<button class="view-code-btn" title="View code" @click=${() => this.#viewingCode.set(t)}>&lt;/&gt;</button>`
                        : ''}
                      ${t.source === 'dynamic' && t.origin
                        ? html`<button class="save-btn" title="Save to file" @click=${() => this.#exportOne(t)}>⇩</button>`
                        : ''}
                      ${t.source === 'dynamic'
                        ? html`<button class="unregister-btn" title="Unregister" @click=${() => this.#unregister(t.name)}>✕</button>`
                        : ''}
                    </div>
                  `
                )}
            <form class="add-form" @submit=${(e: Event) => this.#submitAdd(e)}>
              <h3>Register a new tool</h3>
              <div class="mode-toggle">
                <label>
                  <input type="radio" name="mode" .checked=${mode === 'path'} @change=${() => this.#mode.set('path')} />
                  Existing function (path)
                </label>
                <label>
                  <input type="radio" name="mode" .checked=${mode === 'code'} @change=${() => this.#mode.set('code')} />
                  New code
                </label>
              </div>
              <input name="name" placeholder="tool name" />
              <input name="description" placeholder="description (shown to agents)" />
              ${mode === 'path'
                ? html`<input name="path" placeholder="myApp.save (resolves window.myApp.save)" />`
                : html`<textarea name="code" placeholder="return window.myApp.save(args);"></textarea>`}
              <button type="submit" class="submit-btn" ?disabled=${this.#submitting.value}>
                ${this.#submitting.value ? 'Registering…' : 'Register tool'}
              </button>
            </form>
          </div>
        </div>
      </div>
      ${this.#renderCodeView()}
      ${this.#renderDescriptionView()}
    `;
  }

  #renderCodeView() {
    const t = this.#viewingCode.value;
    if (!t || !t.origin) return '';
    return html`
      <div class="code-backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this.#viewingCode.set(undefined); }}>
        <div class="code-modal">
          <div class="modal-header">
            <strong>${t.name}</strong>
            <button class="close-btn" @click=${() => this.#viewingCode.set(undefined)}>✕</button>
          </div>
          ${t.origin.kind === 'code'
            ? html`<pre>${t.origin.code}</pre>`
            : html`<div class="path-view">window.${t.origin.path}</div>`}
        </div>
      </div>
    `;
  }

  #renderDescriptionView() {
    const t = this.#viewingDescription.value;
    if (!t) return '';
    return html`
      <div class="code-backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this.#viewingDescription.set(undefined); }}>
        <div class="code-modal">
          <div class="modal-header">
            <strong>${t.name}</strong>
            <button class="close-btn" @click=${() => this.#viewingDescription.set(undefined)}>✕</button>
          </div>
          <div class="desc-view">${t.description}</div>
        </div>
      </div>
    `;
  }
}

customElements.define('tools-modal', ToolsModal);
