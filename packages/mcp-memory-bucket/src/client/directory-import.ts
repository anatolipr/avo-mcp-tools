import { LitElement, html, css, nothing } from 'lit';
import { getFolderfooConfig } from './server-config.js';

interface DiffLine { type: 'same' | 'added' | 'removed'; text: string }
interface PreviewFile { path: string; kind: 'image' | 'text' | 'binary'; size: number; text?: string; change?: 'new' | 'changed' | 'unchanged'; diff?: DiffLine[] }
interface ListingPreview {
  id: string; owner: string; title: string; description: string; license: string; version: number; content: string;
  contentDiff?: DiffLine[]; files: PreviewFile[]; removedFiles: string[]; updates: string | null;
}
interface ImportStatus { listingId: string; skill: string; updateAvailable: boolean; gone: boolean; latestVersion: number | null }

/**
 * The adopter's side of public skills. Folderfoo's page links here with ?directoryListing=<id>, and
 * this shows every file before anything is added. Also lists imported skills with a newer version,
 * or whose listing went away. Listing text only ever renders as text.
 */
export class DirectoryImport extends LitElement {
  static properties = {
    _preview: { state: true },
    _statuses: { state: true },
    _message: { state: true },
    _busy: { state: true },
  };

  private _preview: ListingPreview | null = null;
  private _statuses: ImportStatus[] = [];
  private _message: string | null = null;
  private _busy = false;

  static styles = css`
    .notices { position: fixed; right: 12px; bottom: 12px; z-index: 900; max-width: 360px; font-size: 12px; }
    .notice { background: var(--bg, #fff); color: inherit; border: 1px solid var(--border-strong, #8888); border-radius: 6px; padding: 8px; margin-top: 6px; }
    .backdrop { position: fixed; inset: 0; z-index: 1000; background: #0008; display: flex; align-items: center; justify-content: center; }
    .modal {
      background: var(--bg, #fff); color: inherit; border-radius: 8px; padding: 16px; box-sizing: border-box;
      width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; font-size: 13px;
    }
    h2 { margin: 0 0 4px; font-size: 16px; }
    h3 { margin: 12px 0 4px; font-size: 13px; }
    .meta { opacity: 0.7; font-size: 12px; }
    .warning { border: 1px solid var(--border-strong, #8888); border-radius: 6px; padding: 8px; margin: 10px 0; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; background: #8881; padding: 8px; border-radius: 6px; margin: 4px 0; font-size: 12px; }
    .added { background: #2e7d3233; display: block; }
    .removed { background: #c6282833; display: block; text-decoration: line-through; }
    button { font: inherit; margin: 8px 6px 0 0; padding: 4px 12px; cursor: pointer; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    void this.#start();
  }

  async #start(): Promise<void> {
    const { folderfooHost } = await getFolderfooConfig();
    if (!folderfooHost) return;
    const url = new URL(window.location.href);
    const id = url.searchParams.get('directoryListing');
    if (id) {
      const server = url.searchParams.get('directoryServer');
      url.searchParams.delete('directoryListing');
      url.searchParams.delete('directoryServer');
      window.history.replaceState(null, '', url.toString());
      // A link could name any server; only the one this bucket trusts is ever read.
      if (server && server !== folderfooHost) this._message = `This link is for a different server (${server}), so nothing was loaded.`;
      else await this.#review(id);
    }
    const res = await fetch('/api/directory/imports').catch(() => null);
    if (res?.ok) this._statuses = (await res.json()).imports;
  }

  async #review(id: string): Promise<void> {
    this._message = null;
    const res = await fetch(`/api/directory/preview/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (res.ok) this._preview = data as ListingPreview;
    else this._message = data.error;
  }

  async #add(): Promise<void> {
    if (!this._preview) return;
    this._busy = true;
    try {
      const res = await fetch(`/api/directory/import/${encodeURIComponent(this._preview.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (res.ok) {
        const skipped = data.skippedFiles.length ? ` Sign in to folderfoo to get these files, which were left out: ${data.skippedFiles.join(', ')}.` : '';
        this._message = `"${data.skill}" is added and paused. Read it, then turn it on when you trust it.${skipped}`;
        this._preview = null;
        this._statuses = this._statuses.filter((s) => s.skill !== data.skill);
      } else {
        this._message = data.error;
      }
    } finally {
      this._busy = false;
    }
  }

  #diff(lines: DiffLine[]) {
    return html`<pre>${lines.map((l) => (l.type === 'same' ? html`<span>${l.text}\n</span>` : html`<span class=${l.type}>${l.text}\n</span>`))}</pre>`;
  }

  #file(file: PreviewFile) {
    const label = `${file.path} (${file.kind}, ${file.size} bytes${file.change ? `, ${file.change}` : ''})`;
    if (file.kind === 'binary') return html`<div>${label}<div class="meta">Nobody can read this file to check it. Treat it as untrusted.</div></div>`;
    if (file.diff) return html`<div>${label}${this.#diff(file.diff)}</div>`;
    if (file.change === 'unchanged') return html`<div>${label}</div>`;
    if (file.text !== undefined) return html`<div>${label}<pre>${file.text}</pre></div>`;
    return html`<div>${label}</div>`;
  }

  render() {
    const p = this._preview;
    const notices = this._statuses.filter((s) => s.updateAvailable || s.gone);
    return html`
      <div class="notices">
        ${this._message ? html`<div class="notice">${this._message} <button @click=${() => (this._message = null)}>OK</button></div>` : nothing}
        ${notices.map((s) => html`<div class="notice">
          ${s.gone
            ? html`The public listing for "${s.skill}" was hidden or removed, so your copy was paused. Check it before you turn it back on.`
            : html`"${s.skill}" has a new public version. <button @click=${() => this.#review(s.listingId)}>Review</button>`}
        </div>`)}
      </div>
      ${p
        ? html`<div class="backdrop" role="dialog" aria-label="Review public skill">
            <div class="modal">
              <h2>${p.updates ? `Update "${p.updates}"` : 'Add a public skill'}: ${p.title}</h2>
              <div class="meta">by ${p.owner} · version ${p.version} · ${p.license}</div>
              <p>${p.description}</p>
              <div class="warning">Nobody has reviewed this. Agents follow what a skill says, and it can include scripts. It arrives paused and stays paused until you turn it on.</div>
              <h3>SKILL.md</h3>
              ${p.contentDiff ? this.#diff(p.contentDiff) : html`<pre>${p.content}</pre>`}
              ${p.files.length ? html`<h3>Files</h3>${p.files.map((f) => this.#file(f))}` : nothing}
              ${p.removedFiles.length ? html`<h3>Removed files</h3><pre>${p.removedFiles.join('\n')}</pre>` : nothing}
              <button ?disabled=${this._busy} @click=${() => this.#add()}>${p.updates ? 'Update, paused' : 'Add, paused'}</button>
              <button @click=${() => (this._preview = null)}>Cancel</button>
            </div>
          </div>`
        : nothing}
    `;
  }
}

customElements.define('directory-import', DirectoryImport);
