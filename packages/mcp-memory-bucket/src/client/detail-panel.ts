import { LitElement, html, css, nothing } from 'lit';
import { marked } from 'marked';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import './tag-multiselect.js';
import './status-select.js';
import './help-tooltip.js';
import type { EntryDetail, Selection, Facets } from './types.js';

const VIEW_MODE_KEY = 'mem-bucket-detail-view-mode';

/**
 * Converts a UTC ISO timestamp to the calendar date it falls on in the browser's local timezone
 * — mirrors the server's toLocalDate (src/store/date-extract.ts), which is what actually populates
 * doc_dates (and therefore what the date-range filter and the "click date to filter" shortcut key
 * off of). A naive `.slice(0, 10)` on the raw UTC string can show a different date than what's
 * actually filterable — e.g. a doc created at 2026-08-20T04:10:00Z is still 2026-08-19 evening in
 * US Pacific time, so filtering by "08/20" would find nothing despite the UI showing "2026-08-20".
 */
function toLocalDate(isoTimestamp: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(new Date(isoTimestamp));
}

const SKILL_STATUS_DEFAULTS = ['stable', 'beta', 'unreviewed'];
const MEMORY_STATUS_DEFAULTS = ['active', 'shipped', 'abandoned'];
const MEMORY_DOC_TYPES = ['plan', 'spec', 'sql', 'testing-todo', 'discovery', 'session-summary', 'other'];
const MEMORY_KEY_TYPES = ['ticket', 'freeform'];

const FIELD_HELP = {
  description:
    'What this doc is / does, shown in search results and list views. For skills, this is also the only thing an agent sees before deciding whether to load the full body — so state both what it does and when to use it.',
  tags: 'Free-form keywords used to filter and search. Not the only thing matched during full-text search, but the fastest way to narrow a list view.',
  status:
    'Lifecycle state — stable/beta/unreviewed for skills, active/shipped/abandoned for memory docs. Skills default to "unreviewed" if left unset, so low-trust content doesn\'t read as equivalent to a reviewed pattern.',
  name: "The skill's identifier — becomes its containing folder name on disk. Lowercase letters, numbers, and hyphens only.",
  owner: 'Who authored or maintains this skill — a person or team name, free text.',
  extends: "Name of another skill this one builds on or specializes, if any. Leave blank if it doesn't extend anything.",
  trigger_phrases:
    "Extra keyword phrases beyond the description that should surface this skill in search — phrasings a user might type that don't literally appear in the description text.",
  key: 'The lookup handle for this memory doc — usually a ticket ID, sometimes a free-form name. One key can have several docs attached (a plan, a spec, session notes) all retrievable together.',
  key_type: '"ticket" if the key is a real ticket ID, "freeform" for a name like "Spot Chart Design".',
  doc_type: 'What kind of content this is — shapes how it should be read (a plan reads differently than raw SQL or a session summary).',
  related_to: 'Another key this doc relates to, if any — free text, not validated against existing keys.',
} as const;

interface Draft {
  description: string;
  tags: string[];
  status: string;
  // skills
  name: string;
  owner: string;
  extends: string;
  trigger_phrases: string[];
  // memory
  key: string;
  key_type: string;
  doc_type: string;
  related_to: string;
}

function draftFrom(d: EntryDetail): Draft {
  return {
    description: d.description ?? '',
    tags: d.tags ?? [],
    status: d.status ?? '',
    name: d.name ?? '',
    owner: d.owner ?? '',
    extends: d.extends ?? '',
    trigger_phrases: d.trigger_phrases ?? [],
    key: d.key ?? '',
    key_type: d.key_type ?? '',
    doc_type: d.doc_type ?? '',
    related_to: d.related_to ?? '',
  };
}

export class DetailPanel extends LitElement {
  static properties = {
    selected: { attribute: false },
    onChanged: { attribute: false },
    facets: { attribute: false },
    onTagClick: { attribute: false },
    onFolderClick: { attribute: false },
    onDateClick: { attribute: false },
    onKeyClick: { attribute: false },
    _doc: { state: true },
    _viewMode: { state: true },
    _editing: { state: true },
    _draft: { state: true },
    _addingFrontmatter: { state: true },
    _renaming: { state: true },
    _renameValue: { state: true },
  };

  declare selected: Selection | null;
  declare onChanged: (() => void) | undefined;
  declare facets: Facets | undefined;
  declare onTagClick: ((tag: string) => void) | undefined;
  declare onFolderClick: ((folder: string) => void) | undefined;
  declare onDateClick: ((date: string) => void) | undefined;
  declare onKeyClick: ((key: string) => void) | undefined;
  private _doc?: EntryDetail | null;
  private _viewMode: 'markdown' | 'raw' =
    (localStorage.getItem(VIEW_MODE_KEY) as 'markdown' | 'raw' | null) ?? 'markdown';
  private _editing = false;
  private _draft: Draft | null = null;
  private _addingFrontmatter = false;
  private _renaming = false;
  private _renameValue = '';

  static styles = css`
    :host { display: block; padding: 16px; }
    h2 { margin: 0 0 4px; font-size: 16px; }
    .title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .title-row h2 { margin: 0; }
    .title-link {
      background: none; border: none; padding: 0; margin: 0; font: inherit; font-weight: inherit;
      color: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 3px;
      text-align: left;
    }
    .title-link:hover { opacity: 0.8; }
    .key-link {
      background: none; border: none; padding: 0; margin: 0; font: inherit;
      color: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
    }
    .key-link:hover { opacity: 0.8; }
    .pill {
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      padding: 2px 9px;
      font-size: 11px;
      display: inline-flex;
      align-items: center;
      background: none;
      color: inherit;
      font-family: inherit;
    }
    .pill.folder-pill {
      cursor: pointer;
      color: var(--purple-fg);
      border-color: var(--purple);
      background: var(--purple-tint);
    }
    .pill.folder-pill:hover { background: var(--hover-strong); }
    .pill.tag-pill {
      cursor: pointer;
      background: var(--bg-subtle);
    }
    .pill.tag-pill:hover { background: var(--hover); border-color: var(--border-strong); }
    .pill.warn-pill {
      border-color: var(--danger);
      color: var(--danger);
      background: none;
    }
    .pill.muted-pill {
      opacity: 0.65;
    }
    .info-grid {
      display: grid;
      grid-template-columns: max-content 1fr;
      column-gap: 10px;
      row-gap: 7px;
      font-size: 12px;
      margin-bottom: 12px;
      align-items: start;
    }
    .info-grid dt {
      opacity: 0.55;
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding-top: 2px;
      white-space: nowrap;
    }
    .info-grid dd {
      margin: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
    }
    .info-grid dd.description { opacity: 0.85; }
    .info-grid .date-value {
      cursor: pointer;
      text-decoration: underline dotted;
      text-underline-offset: 2px;
    }
    .info-grid .date-value:hover { opacity: 0.75; }
    .info-grid .hint { opacity: 0.5; font-style: italic; }
    .bare-notice { font-size: 12px; opacity: 0.6; font-style: italic; margin-bottom: 12px; }
    .attachments-section {
      font-size: 12px;
      margin-bottom: 12px;
    }
    .attachments-section h4 {
      margin: 0 0 6px;
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.55;
      font-weight: 600;
    }
    .attachments-section ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .attachment-meta { opacity: 0.55; font-size: 11px; }
    .source-path {
      font-family: monospace;
      font-size: 11px;
      opacity: 0.6;
      cursor: pointer;
      word-break: break-all;
    }
    pre {
      white-space: pre-wrap;
      font-size: 12px;
      background: var(--bg-subtle);
      padding: 12px;
      border-radius: 6px;
      max-height: 60vh;
      overflow-y: auto;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: monospace;
      font-size: 12px;
      background: var(--bg-subtle);
      color: inherit;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      min-height: 30vh;
      resize: vertical;
    }
    .empty { opacity: 0.5; font-size: 13px; }
    .view-toggle {
      display: flex;
      gap: 4px;
      margin-bottom: 8px;
    }
    .view-toggle button {
      font-size: 11px;
      padding: 3px 8px;
      border: 1px solid var(--border);
      background: transparent;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.6;
    }
    .view-toggle button.active {
      opacity: 1;
      background: var(--hover);
      font-weight: 600;
    }
    .markdown-body {
      font-size: 13px;
      line-height: 1.5;
      max-height: 60vh;
      overflow-y: auto;
      padding: 12px;
      background: var(--bg-subtle);
      border-radius: 6px;
    }
    .markdown-body :first-child { margin-top: 0; }
    .markdown-body :last-child { margin-bottom: 0; }
    .markdown-body pre {
      background: var(--hover);
      max-height: none;
    }
    .markdown-body code {
      font-family: monospace;
      font-size: 12px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }
    .actions button {
      font-size: 11px;
      padding: 4px 10px;
      border: 1px solid var(--border);
      background: transparent;
      color: inherit;
      border-radius: 4px;
      cursor: pointer;
    }
    .actions button.danger {
      border-color: var(--danger);
      color: var(--danger);
    }
    .actions button.primary {
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
    }
    .edit-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 12px;
      padding: 12px;
      background: var(--bg-subtle);
      border-radius: 6px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field label {
      font-size: 11px;
      font-weight: 600;
      opacity: 0.7;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .field input[type='text'],
    .field select,
    .field textarea {
      font-size: 13px;
      padding: 6px 8px;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      background: var(--bg);
      color: inherit;
      font-family: inherit;
    }
    .field input[type='text'],
    .field select {
      max-width: 320px;
    }
    .field textarea {
      min-height: 60px;
      resize: vertical;
    }
    .field-row {
      display: flex;
      gap: 10px;
    }
    .field-row .field { flex: 1; }
    .form-actions {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }
    .form-actions button {
      font-size: 12px;
      padding: 5px 12px;
      border-radius: 4px;
      cursor: pointer;
    }
    .form-actions button.save {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: var(--accent-fg);
    }
    .form-actions button.cancel {
      border: 1px solid var(--border);
      background: transparent;
      color: inherit;
    }
    .rename-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .rename-row input {
      flex: 1;
      font-size: 12px;
      padding: 4px 6px;
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      background: var(--bg);
      color: inherit;
    }
    .hint { font-size: 11px; opacity: 0.6; }
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has('selected') && this.selected) {
      this._editing = false;
      this._addingFrontmatter = false;
      this._renaming = false;
      this.#load();
      this.scrollTop = 0;
    }
  }

  async #load() {
    const { table, id } = this.selected!;
    const res = await fetch(`/api/entries/${table}/${encodeURIComponent(id)}`);
    this._doc = res.ok ? ((await res.json()) as EntryDetail) : null;
    await this.updateComplete;
    this.shadowRoot?.querySelector('.markdown-body')?.scrollTo(0, 0);
    this.shadowRoot?.querySelector('pre')?.scrollTo(0, 0);
  }

  #copyPath() {
    if (this._doc?.source_path) navigator.clipboard?.writeText(this._doc.source_path);
  }

  #setViewMode(mode: 'markdown' | 'raw') {
    this._viewMode = mode;
    localStorage.setItem(VIEW_MODE_KEY, mode);
  }

  async #toggleDeprecated() {
    const { table, id } = this.selected!;
    const deprecated = !this._doc?.deprecated;
    await fetch(`/api/entries/${table}/${encodeURIComponent(id)}/deprecated`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deprecated }),
    });
    await this.#load();
    this.onChanged?.();
  }

  async #togglePaused() {
    const { table, id } = this.selected!;
    const paused = !this._doc?.paused;
    await fetch(`/api/entries/${table}/${encodeURIComponent(id)}/paused`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused }),
    });
    await this.#load();
    this.onChanged?.();
  }

  async #deleteDoc() {
    if (!window.confirm("Delete this doc? This can't be undone.")) return;
    const { table, id } = this.selected!;
    await fetch(`/api/entries/${table}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    this._doc = null;
    this.onChanged?.();
  }

  #startEdit() {
    if (!this._doc) return;
    this._draft = draftFrom(this._doc);
    this._editing = true;
    this._addingFrontmatter = false;
  }

  #startAddFrontmatter() {
    if (!this._doc) return;
    // Bare memory doc: deriveFrontmatter already seeded a usable id/key from the filename, but
    // doc_type/description/key are just filename-derived guesses — ask doc_type first since it
    // shapes which fields matter, then land in the same form startEdit() uses.
    this._draft = draftFrom(this._doc);
    this._addingFrontmatter = true;
    this._editing = false;
  }

  #confirmDocType(docType: string) {
    if (!this._draft) return;
    this._draft = { ...this._draft, doc_type: docType };
    this._addingFrontmatter = false;
    this._editing = true;
  }

  #cancelEdit() {
    this._editing = false;
    this._addingFrontmatter = false;
    this._draft = null;
  }

  #updateDraft(patch: Partial<Draft>) {
    if (!this._draft) return;
    this._draft = { ...this._draft, ...patch };
  }

  #toggleDraftTag(tag: string) {
    if (!this._draft) return;
    const tags = this._draft.tags.includes(tag)
      ? this._draft.tags.filter((t) => t !== tag)
      : [...this._draft.tags, tag];
    this.#updateDraft({ tags });
  }

  #toggleDraftTriggerPhrase(phrase: string) {
    if (!this._draft) return;
    const trigger_phrases = this._draft.trigger_phrases.includes(phrase)
      ? this._draft.trigger_phrases.filter((p) => p !== phrase)
      : [...this._draft.trigger_phrases, phrase];
    this.#updateDraft({ trigger_phrases });
  }

  async #saveEdit() {
    if (!this._draft || !this.selected) return;
    const { table, id } = this.selected;
    const isSkill = table === 'skills';
    const frontmatter: Record<string, unknown> = {
      description: this._draft.description,
      tags: this._draft.tags,
      status: this._draft.status,
    };
    if (isSkill) {
      frontmatter.owner = this._draft.owner || null;
      frontmatter.extends = this._draft.extends || null;
      frontmatter.trigger_phrases = this._draft.trigger_phrases;
    } else {
      frontmatter.key = this._draft.key;
      frontmatter.key_type = this._draft.key_type;
      frontmatter.doc_type = this._draft.doc_type;
      frontmatter.related_to = this._draft.related_to || null;
    }
    const res = await fetch(`/api/entries/${table}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frontmatter }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      window.alert(`Save failed: ${body.error ?? res.statusText}`);
      return;
    }
    this._editing = false;
    this._draft = null;
    await this.#load();
    this.onChanged?.();
  }

  // Memory docs only — skill frontmatter is required by the agentskills.io spec (name/description
  // are both mandatory), so a "delete frontmatter" action there would produce a non-conformant
  // SKILL.md no compliant agent (Claude Code included) can discover or load. Not offered in the UI.
  async #deleteFrontmatter() {
    if (!this.selected || !this._doc || this.selected.table !== 'memory_docs') return;
    const { table, id } = this.selected;
    const consequence =
      "This removes the doc's key, tags, and status — it drops out of key-based lookup and full-text search, and becomes a plain unmanaged file, until frontmatter is added again.";
    if (!window.confirm(`Delete frontmatter for "${this._doc.key}"?\n\n${consequence}`)) return;
    const res = await fetch(`/api/entries/${table}/${encodeURIComponent(id)}/frontmatter`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      window.alert(`Delete failed: ${body.error ?? res.statusText}`);
      return;
    }
    this._doc = null;
    this.selected = null;
    this.onChanged?.();
  }

  #startRename() {
    if (!this._doc) return;
    this._renameValue = this._doc.name ?? '';
    this._renaming = true;
  }

  async #confirmRename() {
    if (!this._doc || !this._renameValue.trim()) return;
    const newName = this._renameValue.trim();
    if (newName === this._doc.name) {
      this._renaming = false;
      return;
    }
    const res = await fetch(`/api/entries/skills/${encodeURIComponent(this._doc.name!)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: newName }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      window.alert(`Rename failed: ${body.error ?? res.statusText}`);
      return;
    }
    this._renaming = false;
    this.selected = { table: 'skills', id: newName };
    await this.#load();
    this.onChanged?.();
  }

  #renderDocTypePrompt() {
    return html`
      <div class="edit-form">
        <div class="hint">What kind of doc is this? This shapes which fields apply next.</div>
        <div class="field">
          <label>doc_type <help-tooltip .text=${FIELD_HELP.doc_type}></help-tooltip></label>
          <select
            @change=${(e: Event) => this.#confirmDocType((e.target as HTMLSelectElement).value)}
          >
            <option value="" selected disabled>Choose…</option>
            ${MEMORY_DOC_TYPES.map((t) => html`<option value=${t}>${t}</option>`)}
          </select>
        </div>
        <div class="form-actions">
          <button class="cancel" @click=${() => this.#cancelEdit()}>Cancel</button>
        </div>
      </div>
    `;
  }

  #renderEditForm(isSkill: boolean) {
    const d = this._draft!;
    const facets = this.facets;
    return html`
      <div class="edit-form">
        ${isSkill
          ? html`
              <div class="field">
                <label>name <help-tooltip .text=${FIELD_HELP.name}></help-tooltip></label>
                <div class="hint">Renaming moves the skill's folder on disk — kept as a separate action.</div>
              </div>
            `
          : html`
              <div class="field-row">
                <div class="field">
                  <label>key <help-tooltip .text=${FIELD_HELP.key}></help-tooltip></label>
                  <input
                    type="text"
                    .value=${d.key}
                    @input=${(e: Event) => this.#updateDraft({ key: (e.target as HTMLInputElement).value })}
                  />
                </div>
                <div class="field">
                  <label>key_type <help-tooltip .text=${FIELD_HELP.key_type}></help-tooltip></label>
                  <select
                    .value=${d.key_type}
                    @change=${(e: Event) => this.#updateDraft({ key_type: (e.target as HTMLSelectElement).value })}
                  >
                    ${MEMORY_KEY_TYPES.map((t) => html`<option value=${t} ?selected=${t === d.key_type}>${t}</option>`)}
                  </select>
                </div>
              </div>
              <div class="field">
                <label>doc_type <help-tooltip .text=${FIELD_HELP.doc_type}></help-tooltip></label>
                <select
                  .value=${d.doc_type}
                  @change=${(e: Event) => this.#updateDraft({ doc_type: (e.target as HTMLSelectElement).value })}
                >
                  ${MEMORY_DOC_TYPES.map((t) => html`<option value=${t} ?selected=${t === d.doc_type}>${t}</option>`)}
                </select>
              </div>
            `}
        <div class="field">
          <label>description <help-tooltip .text=${FIELD_HELP.description}></help-tooltip></label>
          <textarea
            .value=${d.description}
            @input=${(e: Event) => this.#updateDraft({ description: (e.target as HTMLTextAreaElement).value })}
          ></textarea>
        </div>
        <div class="field">
          <label>tags <help-tooltip .text=${FIELD_HELP.tags}></help-tooltip></label>
          <tag-multiselect
            .tags=${facets?.tags ?? []}
            .active=${d.tags}
            .allowCreate=${true}
            .onToggle=${(t: string) => this.#toggleDraftTag(t)}
          ></tag-multiselect>
        </div>
        <div class="field">
          <label>status <help-tooltip .text=${FIELD_HELP.status}></help-tooltip></label>
          <status-select
            .options=${[...new Set([...(isSkill ? SKILL_STATUS_DEFAULTS : MEMORY_STATUS_DEFAULTS), ...(facets?.statuses ?? [])])]}
            .value=${d.status}
            .onChange=${(status: string) => this.#updateDraft({ status })}
          ></status-select>
        </div>
        ${isSkill
          ? html`
              <div class="field-row">
                <div class="field">
                  <label>owner <help-tooltip .text=${FIELD_HELP.owner}></help-tooltip></label>
                  <input
                    type="text"
                    .value=${d.owner}
                    @input=${(e: Event) => this.#updateDraft({ owner: (e.target as HTMLInputElement).value })}
                  />
                </div>
                <div class="field">
                  <label>extends <help-tooltip .text=${FIELD_HELP.extends}></help-tooltip></label>
                  <input
                    type="text"
                    .value=${d.extends}
                    @input=${(e: Event) => this.#updateDraft({ extends: (e.target as HTMLInputElement).value })}
                  />
                </div>
              </div>
              <div class="field">
                <label>trigger_phrases <help-tooltip .text=${FIELD_HELP.trigger_phrases}></help-tooltip></label>
                <tag-multiselect
                  .tags=${[]}
                  .active=${d.trigger_phrases}
                  .allowCreate=${true}
                  .onToggle=${(p: string) => this.#toggleDraftTriggerPhrase(p)}
                ></tag-multiselect>
              </div>
            `
          : html`
              <div class="field">
                <label>related_to <help-tooltip .text=${FIELD_HELP.related_to}></help-tooltip></label>
                <input
                  type="text"
                  .value=${d.related_to}
                  @input=${(e: Event) => this.#updateDraft({ related_to: (e.target as HTMLInputElement).value })}
                />
              </div>
            `}
        <div class="form-actions">
          <button class="save" @click=${() => this.#saveEdit()}>Save</button>
          <button class="cancel" @click=${() => this.#cancelEdit()}>Cancel</button>
        </div>
      </div>
    `;
  }

  #renderTitleRow(d: EntryDetail, isSkill: boolean) {
    const key = isSkill ? undefined : d.key;
    return html`
      <div class="title-row">
        <h2>
          ${key
            ? html`<button class="title-link" title="Search for key '${key}'" @click=${() => this.onKeyClick?.(key)}>
                ${d.name ?? key ?? d.id}
              </button>`
            : (d.name ?? d.key ?? d.id)}
        </h2>
        <button class="pill folder-pill" title="Filter by folder '${d.folder}'" @click=${() => this.onFolderClick?.(d.folder)}>
          📁 ${d.folder}
        </button>
      </div>
    `;
  }

  #renderInfoGrid(d: EntryDetail, isSkill: boolean) {
    const dateStr = d.created_at ? toLocalDate(d.created_at) : null;
    return html`
      <dl class="info-grid">
        <dt>Description</dt>
        <dd class="description">${d.description || '—'}</dd>

        <dt>Tags</dt>
        <dd>
          ${d.tags?.length
            ? d.tags.map(
                (t) => html`<button class="pill tag-pill" @click=${() => this.onTagClick?.(t)}>${t}</button>`
              )
            : html`<span class="hint">no tags</span>`}
        </dd>

        <dt>Status</dt>
        <dd>${d.status}</dd>

        ${d.deprecated || d.paused
          ? html`
              <dt>Flags</dt>
              <dd>
                ${d.deprecated ? html`<span class="pill warn-pill">deprecated</span>` : nothing}
                ${d.paused ? html`<span class="pill muted-pill">paused</span>` : nothing}
              </dd>
            `
          : nothing}

        ${isSkill
          ? html`
              ${d.owner
                ? html`<dt>Owner</dt>
                    <dd>${d.owner}</dd>`
                : nothing}
              ${d.extends
                ? html`<dt>Extends</dt>
                    <dd>${d.extends}</dd>`
                : nothing}
            `
          : html`
              <dt>Key</dt>
              <dd>
                <button class="key-link" title="Search for this key" @click=${() => d.key && this.onKeyClick?.(d.key)}>
                  ${d.key}
                </button>
              </dd>

              <dt>Key type</dt>
              <dd>${d.key_type}</dd>

              <dt>Doc type</dt>
              <dd>${d.doc_type}</dd>

              ${d.related_to
                ? html`<dt>Related to</dt>
                    <dd>${d.related_to}</dd>`
                : nothing}
            `}

        <dt>Created</dt>
        <dd>
          ${dateStr
            ? html`<span class="date-value" title="Filter to this day" @click=${() => this.onDateClick?.(dateStr)}
                >${dateStr}</span
              >`
            : html`<span class="hint">unknown</span>`}
        </dd>
      </dl>
    `;
  }

  /**
   * Builds a `marked` Renderer whose `link` override rewrites `attachment://<filename>` hrefs in
   * body markdown to the real download URL served by src/web/routes.ts
   * (`/api/entries/:table/:id/attachments/:filename` — see #renderAttachments above, which uses
   * the same pattern for the header section). Confirmed against the installed `marked@18.0.10`
   * renderer API (lib/marked.d.ts): `link` takes a single `Tokens.Link` object
   * (`{ href, title, tokens }`), not the v3-era `(href, title, text)` positional signature — so the
   * override below matches that shape and rebinds `this` when delegating to the original so the
   * default renderer's use of `this.parser.parseInline(...)` keeps working.
   */
  #markedWithAttachmentLinks(table: 'skills' | 'memory_docs', docId: string) {
    const renderer = new marked.Renderer();
    const originalLink = renderer.link.bind(renderer);
    renderer.link = (token) => {
      if (typeof token.href === 'string' && token.href.startsWith('attachment://')) {
        const filename = token.href.slice('attachment://'.length);
        return originalLink({
          ...token,
          href: `/api/entries/${table}/${encodeURIComponent(docId)}/attachments/${encodeURIComponent(filename)}`,
        });
      }
      return originalLink(token);
    };
    return renderer;
  }

  #renderAttachments(d: EntryDetail, table: 'skills' | 'memory_docs') {
    if (!d.attachments?.length) return nothing;
    return html`
      <div class="attachments-section">
        <h4>Attachments</h4>
        <ul>
          ${d.attachments.map(
            (a) => html`
              <li>
                <a href="/api/entries/${table}/${encodeURIComponent(d.id)}/attachments/${encodeURIComponent(a.filename)}" target="_blank" rel="noopener"
                  >${a.filename}</a
                >
                <span class="attachment-meta">(${a.mime_type}, ${a.size} bytes)</span>
              </li>
            `
          )}
        </ul>
      </div>
    `;
  }

  render() {
    if (!this.selected) return html`<div class="empty">Select an entry to view its details.</div>`;
    if (!this._doc) return nothing;
    const d = this._doc;
    const isSkill = this.selected.table === 'skills';
    const isBuiltin = isSkill && d.folder === 'builtin';
    const bare = !isSkill && d.has_frontmatter === false;

    if (this._addingFrontmatter) return html`${this.#renderTitleRow(d, isSkill)}${this.#renderDocTypePrompt()}`;
    if (this._editing && this._draft) return html`${this.#renderTitleRow(d, isSkill)}${this.#renderEditForm(isSkill)}`;

    return html`
      ${this.#renderTitleRow(d, isSkill)}
      ${bare ? html`<div class="bare-notice">No frontmatter — this is a plain, unmanaged file.</div>` : this.#renderInfoGrid(d, isSkill)}
      ${isBuiltin
        ? nothing
        : html`
            <div class="actions">
              ${bare
                ? html`<button class="primary" @click=${() => this.#startAddFrontmatter()}>Add frontmatter</button>`
                : html`
                    <button @click=${() => this.#startEdit()}>Edit</button>
                    ${isSkill ? html`<button @click=${() => this.#startRename()}>Rename</button>` : nothing}
                    <button @click=${() => this.#toggleDeprecated()}>${d.deprecated ? 'Un-deprecate' : 'Mark deprecated'}</button>
                    <button @click=${() => this.#togglePaused()}>${d.paused ? 'Resume' : 'Pause'}</button>
                    ${isSkill
                      ? nothing
                      : html`<button class="danger" @click=${() => this.#deleteFrontmatter()}>Delete frontmatter</button>`}
                  `}
              <button class="danger" @click=${() => this.#deleteDoc()}>Delete</button>
            </div>
            ${this._renaming
              ? html`
                  <div class="rename-row">
                    <input
                      type="text"
                      .value=${this._renameValue}
                      @input=${(e: Event) => (this._renameValue = (e.target as HTMLInputElement).value)}
                      @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.#confirmRename()}
                    />
                    <button @click=${() => this.#confirmRename()}>Save</button>
                    <button @click=${() => (this._renaming = false)}>Cancel</button>
                  </div>
                `
              : nothing}
          `}
      ${this.#renderAttachments(d, this.selected.table)}
      <div class="view-toggle">
        <button
          class=${this._viewMode === 'markdown' ? 'active' : ''}
          @click=${() => this.#setViewMode('markdown')}
        >
          Preview
        </button>
        <button
          class=${this._viewMode === 'raw' ? 'active' : ''}
          @click=${() => this.#setViewMode('raw')}
        >
          Raw
        </button>
      </div>
      ${this._viewMode === 'markdown'
        ? html`<div class="markdown-body">${unsafeHTML(
            marked.parse(d.body ?? '', {
              async: false,
              renderer: this.#markedWithAttachmentLinks(this.selected.table, d.id),
            }) as string
          )}</div>`
        : html`<pre>${d.raw_file ?? d.body}</pre>`}
      <div class="source-path" title="click to copy" @click=${() => this.#copyPath()}>${d.source_path}</div>
    `;
  }
}

customElements.define('detail-panel', DetailPanel);
