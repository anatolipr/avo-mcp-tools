import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import { toast } from './toast.js';
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
 * unregister a previously dynamically-added tool. `channel`/`connectionId`
 * are set as plain properties by whoever opens it (dashboard-app.ts).
 *
 * Data is fetched on open only (no SSE) — see the GET .../tools REST route
 * in mcp-tenant-lib's dashboard.ts. Registration/unregistration go through
 * the SAME REST routes (and therefore the SAME Tenant.call(...) mechanism)
 * the register_page_tool_by_path/_by_code/unregister_page_tool MCP tools
 * use — one implementation, two front doors. Registering by code shows a
 * browser confirm() dialog on the BRIDGED page (not this dashboard tab)
 * before it actually registers — this form submission goes through the
 * exact same gate an agent-driven registration would.
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
      font-size: 12px; opacity: 0.75; flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; flex: 0 0 auto; }
    .badge.host { background: var(--hover); opacity: 0.7; }
    .badge.dynamic { background: var(--accent-tint); color: var(--accent); }
    .unregister-btn {
      font-size: 12px; border: none; background: none; color: var(--danger); cursor: pointer;
      opacity: 0.7; flex: 0 0 auto; padding: 0 2px;
    }
    .unregister-btn:hover { opacity: 1; }
    .view-code-btn {
      font-size: 12px; border: none; background: none; color: inherit; cursor: pointer;
      opacity: 0.6; flex: 0 0 auto; padding: 0 2px;
    }
    .view-code-btn:hover { opacity: 1; }
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
      font-size: 12px; white-space: pre-wrap; word-break: break-word;
    }
    .code-modal .path-view { padding: 14px 18px; font-family: ui-monospace, monospace; font-size: 12px; }
    .add-form { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
    .add-form h3 { font-size: 13px; margin: 0 0 10px; }
    .mode-toggle { display: flex; gap: 12px; margin-bottom: 10px; font-size: 12px; }
    .mode-toggle label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
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
      const endpoint = mode === 'path' ? 'register-by-path' : 'register-by-code';
      const body = mode === 'path' ? { name, description, path: pathOrCode } : { name, description, code: pathOrCode };
      const res = await fetch(`${this.#base()}/tools/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'registration failed');
      toast.success(`Registered "${name}"`);
      form.reset();
      await this.#load();
    } catch (err) {
      toast.danger((err as Error).message);
    } finally {
      this.#submitting.set(false);
    }
  }

  render() {
    const tools = this.#tools.value;
    const mode = this.#mode.value;
    return html`
      <div class="backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this.#close(); }}>
        <div class="modal">
          <div class="modal-header">
            <strong>Tools — ${this.connectionId}</strong>
            <button class="close-btn" @click=${() => this.#close()}>✕</button>
          </div>
          <div class="modal-body">
            ${tools === undefined
              ? html`<p class="empty">Loading…</p>`
              : tools.length === 0
              ? html`<p class="empty">No tools registered.</p>`
              : tools.map(
                  (t) => html`
                    <div class="tool-row">
                      <span class="badge ${t.source}">${t.source}</span>
                      <span class="tool-name">${t.name}</span>
                      <span class="tool-desc">${t.description}</span>
                      ${t.source === 'dynamic' && t.origin
                        ? html`<button class="view-code-btn" title="View code" @click=${() => this.#viewingCode.set(t)}>&lt;/&gt;</button>`
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
              <input name="description" placeholder="description (shown to agents${mode === 'code' ? ' and shown to you before it runs' : ''})" />
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
}

customElements.define('tools-modal', ToolsModal);
