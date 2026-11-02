import { LitElement, html, css, nothing } from 'lit';

interface Preview {
  files: string[];
  categories: string[];
  title: string;
  description: string;
  group: string | null;
}

const LICENSES = ['CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0', 'MIT', 'All-Rights-Reserved'];

/**
 * Publishes one skill to the public directory. Only a person can do this, from here: there is no
 * MCP tool, because publishing can leak secrets that cannot be recalled. Shows every file first,
 * and every refusal with its reason.
 */
export class PublishForm extends LitElement {
  static properties = {
    base: { attribute: false },
    query: { attribute: false },
    _preview: { state: true },
    _title: { state: true },
    _description: { state: true },
    _category: { state: true },
    _license: { state: true },
    _busy: { state: true },
    _message: { state: true },
    _details: { state: true },
    _secrets: { state: true },
    _url: { state: true },
  };

  declare base: string;
  declare query: string;
  private _preview: Preview | null = null;
  private _title = '';
  private _description = '';
  private _category = '';
  private _license = 'MIT';
  private _busy = false;
  private _message: string | null = null;
  private _details: string[] = [];
  private _secrets = false;
  private _url: string | null = null;

  static styles = css`
    :host { display: block; font-size: 12px; }
    details { margin-top: 4px; }
    summary { cursor: pointer; font-weight: 600; }
    label { display: block; margin-top: 6px; }
    input, select, textarea {
      display: block; width: 100%; box-sizing: border-box; font: inherit; padding: 4px 6px;
      border: 1px solid var(--border-strong); border-radius: 4px; background: var(--bg); color: inherit;
    }
    ul { margin: 4px 0; padding-left: 18px; max-height: 140px; overflow: auto; }
    button { font: inherit; margin: 6px 6px 0 0; padding: 3px 10px; cursor: pointer; }
    p { margin: 6px 0 0; }
  `;

  async #open(e: Event): Promise<void> {
    if (!(e.target as HTMLDetailsElement).open || this._preview) return;
    const res = await fetch(`${this.base}/publish-preview${this.query}`);
    const data = await res.json();
    if (!res.ok) {
      this._message = data.error;
      return;
    }
    this._preview = data as Preview;
    this._title = this._preview.title;
    this._description = this._preview.description;
    const { categories, group } = this._preview;
    this._category = categories.find((c) => c.toLowerCase() === (group ?? '').toLowerCase()) ?? categories[categories.length - 1] ?? '';
  }

  async #publish(confirmSecrets: boolean): Promise<void> {
    this._busy = true;
    this._message = null;
    this._details = [];
    this._secrets = false;
    try {
      const res = await fetch(`${this.base}/publish${this.query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: this._title, description: this._description, category: this._category, license: this._license, confirmSecrets }),
      });
      const data = await res.json();
      if (res.ok) {
        this._url = data.url;
        this._message = data.status === 'listed' ? 'It is public now. Anyone can add it, paused, after reading it.' : `A person will check it first. ${data.heldReason ?? ''}`;
        return;
      }
      this._message = data.error;
      this._details = data.reasons ?? (data.secrets ?? []).map((s: { kind: string; file: string; line: number }) => `${s.kind}, ${s.file} line ${s.line}`);
      this._secrets = Array.isArray(data.secrets) && data.secrets.length > 0;
    } catch (err) {
      this._message = (err as Error).message;
    } finally {
      this._busy = false;
    }
  }

  render() {
    const p = this._preview;
    return html`
      <details @toggle=${(e: Event) => this.#open(e)}>
        <summary>Publish to public skills</summary>
        ${p
          ? html`
              <p>Anyone can read this, including children. Copies cannot be recalled, so check for private details. Later edits stay private until you publish again.</p>
              <label>Title <input .value=${this._title} maxlength="120" @input=${(e: Event) => (this._title = (e.target as HTMLInputElement).value)} /></label>
              <label>Description <textarea maxlength="2000" .value=${this._description} @input=${(e: Event) => (this._description = (e.target as HTMLTextAreaElement).value)}></textarea></label>
              ${p.categories.length
                ? html`<label>Category
                    <select @change=${(e: Event) => (this._category = (e.target as HTMLSelectElement).value)}>
                      ${p.categories.map((c) => html`<option ?selected=${c === this._category}>${c}</option>`)}
                    </select></label>`
                : nothing}
              <label>License
                <select @change=${(e: Event) => (this._license = (e.target as HTMLSelectElement).value)}>
                  ${LICENSES.map((l) => html`<option ?selected=${l === this._license}>${l}</option>`)}
                </select></label>
              <p>These ${p.files.length} files go public:</p>
              <ul>${p.files.map((f) => html`<li>${f}</li>`)}</ul>
              <button ?disabled=${this._busy || !this._title.trim()} @click=${() => this.#publish(false)}>Publish</button>
              ${this._secrets ? html`<button ?disabled=${this._busy} @click=${() => this.#publish(true)}>Publish anyway</button>` : nothing}
            `
          : nothing}
        ${this._message ? html`<p>${this._message}</p>` : nothing}
        ${this._details.length ? html`<ul>${this._details.map((d) => html`<li>${d}</li>`)}</ul>` : nothing}
        ${this._url ? html`<p><a href=${this._url} target="_blank" rel="noopener">${this._url}</a></p>` : nothing}
      </details>
    `;
  }
}

customElements.define('publish-form', PublishForm);
