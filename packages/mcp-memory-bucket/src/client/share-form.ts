import { LitElement, html, css, nothing } from 'lit';

/** GET <base>/share-status — see remote/sharing.ts's shareStatus. */
interface ShareAccess {
  members: Array<{ username: string; role: string }>;
  links: Array<{ id: string; kind: 'invite' | 'public'; role: string; expiresAt: string; revoked: boolean; redeemers?: string[]; viewCount?: number }>;
}

/**
 * The owner's sharing controls for one thing on folderfoo: share with a username (read-only or
 * editor), copy an invite link (login, grants the picked role) or a public link (no login,
 * read-only), and see/remove who has access and which links are live. `base` is the thing's share
 * route prefix — `/api/entries/<table>/<id>` for a doc, `/api/folders/<kind>/<name>` for a whole
 * connected folder — and `query` any query string those routes need (a skill's `?folder=`).
 */
export class ShareForm extends LitElement {
  static properties = {
    base: { attribute: false },
    query: { attribute: false },
    onClose: { attribute: false },
    _username: { state: true },
    _role: { state: true },
    _busy: { state: true },
    _status: { state: true },
    _access: { state: true },
  };

  declare base: string;
  declare query: string;
  declare onClose: () => void;
  private _username = '';
  private _role: 'member' | 'editor' = 'member';
  private _busy = false;
  private _status: string | null = null;
  private _access: ShareAccess | null = null;

  static styles = css`
    :host { display: block; }
    .share-form {
      display: flex; flex-direction: column; gap: 8px; padding: 10px; margin-top: 4px;
      border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-subtle);
    }
    .share-row { display: flex; gap: 6px; align-items: center; }
    .share-row input[type='text'] {
      flex: 1; font-size: 12px; padding: 4px 6px; border: 1px solid var(--border-strong);
      border-radius: 4px; background: var(--bg); color: inherit;
    }
    .share-row select {
      font-size: 12px; padding: 4px 6px; border: 1px solid var(--border-strong); border-radius: 4px;
      background: var(--bg); color: inherit;
    }
    .share-links-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .share-status { font-size: 11px; opacity: 0.75; }
    .share-access { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
    .share-who { flex: 1 1 auto; font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  `;

  connectedCallback() {
    super.connectedCallback();
    void this.#loadAccess();
  }

  #url(suffix: string): string {
    return `${this.base}/${suffix}${this.query ?? ''}`;
  }

  async #loadAccess() {
    const res = await fetch(this.#url('share-status')).catch(() => null);
    if (res?.ok) this._access = (await res.json()) as ShareAccess;
  }

  /** Runs one change, reports its outcome in the status line, and reloads the access list. */
  async #act(request: Promise<Response>, success: (body: Record<string, unknown>) => string | Promise<string>, failure: string) {
    this._busy = true;
    this._status = null;
    try {
      const res = await request;
      const body = await res.json().catch(() => ({}));
      this._status = res.ok ? await success(body) : `${failure}: ${body.error ?? res.statusText}`;
    } finally {
      this._busy = false;
      void this.#loadAccess();
    }
  }

  #shareWithUser() {
    const username = this._username.trim();
    if (!username) return;
    const request = fetch(this.#url('share'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, role: this._role }),
    });
    void this.#act(request, () => ((this._username = ''), `Shared with ${username}.`), 'Share failed');
  }

  #copyLink(kind: 'share-link' | 'public-link') {
    // An invite link grants the role picked beside the username box; a public link is always read-only.
    const request = fetch(this.#url(kind), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(kind === 'share-link' ? { role: this._role } : {}),
    });
    void this.#act(
      request,
      async (body) => {
        // Rebuilt on this page's own origin, in case it is reached under a different host than the server assumes.
        const url = new URL(String(body.url));
        const linkText = new URL(`${url.pathname}${url.search}`, window.location.origin).toString();
        try {
          await navigator.clipboard?.writeText(linkText);
          return `${kind === 'share-link' ? 'Invite' : 'Public'} link copied to clipboard.`;
        } catch {
          return `Link: ${linkText}`;
        }
      },
      'Failed to create link'
    );
  }

  #removeAccess(username: string) {
    void this.#act(fetch(this.#url(`share/${encodeURIComponent(username)}`), { method: 'DELETE' }), () => `Removed ${username}.`, 'Remove failed');
  }

  #revokeLink(link: ShareAccess['links'][number]) {
    void this.#act(
      fetch(this.#url(`links/${link.kind}/${encodeURIComponent(link.id)}`), { method: 'DELETE' }),
      () => 'Link revoked — people who already joined keep access until removed.',
      'Revoke failed'
    );
  }

  #renderAccess() {
    const access = this._access;
    if (!access) return nothing;
    const live = access.links.filter((l) => !l.revoked && new Date(l.expiresAt).getTime() > Date.now());
    return html`
      <div class="share-access">
        ${access.members.length === 0 && live.length === 0 ? html`<div class="share-status">Not shared with anyone yet.</div>` : nothing}
        ${access.members.map(
          (m) => html`
            <div class="share-row">
              <span class="share-who">${m.username}</span>
              <span class="share-status">${m.role === 'editor' ? 'can edit' : 'read-only'}</span>
              <button ?disabled=${this._busy} @click=${() => this.#removeAccess(m.username)}>Remove</button>
            </div>
          `
        )}
        ${live.map(
          (l) => html`
            <div class="share-row">
              <span class="share-who">${l.kind === 'public' ? 'Public link' : `Invite link (${l.role === 'editor' ? 'can edit' : 'read-only'})`}</span>
              <span class="share-status">
                ${l.kind === 'public' ? `${l.viewCount ?? 0} views` : `${l.redeemers?.length ?? 0} joined`} · expires ${new Date(l.expiresAt).toLocaleDateString()}
              </span>
              <button ?disabled=${this._busy} @click=${() => this.#revokeLink(l)}>Revoke</button>
            </div>
          `
        )}
      </div>
    `;
  }

  render() {
    return html`
      <div class="share-form">
        <div class="share-row">
          <input
            type="text"
            placeholder="username"
            .value=${this._username}
            @input=${(e: Event) => (this._username = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.#shareWithUser()}
          />
          <select .value=${this._role} @change=${(e: Event) => (this._role = (e.target as HTMLSelectElement).value as 'member' | 'editor')}>
            <option value="member">Read-only</option>
            <option value="editor">Can edit</option>
          </select>
          <button ?disabled=${this._busy || !this._username.trim()} @click=${() => this.#shareWithUser()}>Share</button>
        </div>
        <div class="share-links-row">
          <button ?disabled=${this._busy} title="Recipient logs in; grants the role picked above" @click=${() => this.#copyLink('share-link')}>Copy invite link</button>
          <button ?disabled=${this._busy} title="Anyone with the link can read it, no login" @click=${() => this.#copyLink('public-link')}>Copy public link</button>
          <button @click=${() => this.onClose?.()}>Close</button>
        </div>
        ${this._status ? html`<div class="share-status">${this._status}</div>` : nothing}
        ${this.#renderAccess()}
      </div>
    `;
  }
}

customElements.define('share-form', ShareForm);
