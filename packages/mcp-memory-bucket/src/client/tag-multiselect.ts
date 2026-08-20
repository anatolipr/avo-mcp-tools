import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';

let _instanceCounter = 0;

export class TagMultiselect extends LitElement {
  static properties = {
    tags: { attribute: false },
    active: { attribute: false },
    onToggle: { attribute: false },
    allowCreate: { attribute: false },
    width: { attribute: false },
  };

  declare tags: string[];
  declare active: string[];
  declare onToggle: (tag: string) => void;
  /** When true, a query that matches nothing renders a "No match. Create '<query>'" row that
   * toggles it on via onToggle — same as picking any existing tag. Off by default so the
   * shared tags-filter usage (a fixed, browsable vocabulary) is unaffected. */
  declare allowCreate: boolean;
  /** Fixed host width (e.g. "260px") for compact usages like the filters row. When unset, the
   * field grows to fill the width of its container — for usages like frontmatter editing that
   * have room to spare. */
  declare width?: string;

  #query = new Signal<string>('');
  #open = new Signal<boolean>(false);
  #highlighted = new Signal<number>(-1);
  #anchorName: string;
  #listboxId: string;

  static styles = css`
    :host {
      display: inline-block;
      position: relative;
      width: fit-content;
      min-width: 200px;
      max-width: 100%;
      font: inherit;
      font-size: 13px;
    }
    .field {
      display: flex;
      align-items: center;
      gap: 4px;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      background: none;
      padding: 3px 4px 3px 8px;
      min-height: 30px;
      box-sizing: border-box;
    }
    .chips-and-input {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      flex: 1 1 auto;
      min-width: 0;
    }
    .field:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-tint);
    }
    .selected-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--accent);
      color: var(--accent-fg);
      border-radius: 999px;
      padding: 2px 6px 2px 10px;
      font-size: 12px;
      white-space: nowrap;
    }
    .selected-chip .remove {
      cursor: pointer;
      opacity: 0.85;
      line-height: 1;
      padding: 2px;
      border-radius: 50%;
    }
    .selected-chip .remove:hover { opacity: 1; background: #ffffff33; }
    .input {
      flex: 1 1 60px;
      min-width: 60px;
      border: none;
      outline: none;
      padding: 5px 2px;
      font: inherit;
      font-size: 13px;
      background: transparent;
      color: inherit;
    }
    .clear-btn, .chevron-btn {
      border: none;
      background: transparent;
      cursor: pointer;
      color: inherit;
      opacity: 0.6;
      font-size: 12px;
      padding: 2px 5px;
      line-height: 1;
    }
    .clear-btn:hover, .chevron-btn:hover { opacity: 1; }
    .chevron-btn { transition: transform 0.15s ease; }
    .chevron-btn.open { transform: rotate(180deg); }

    .menu {
      position: fixed;
      margin: 0;
      inset: auto;
      top: anchor(bottom);
      left: anchor(left);
      width: anchor-size(width);
      position-try-fallbacks: flip-block;
      list-style: none;
      padding: 4px;
      margin: 0;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      color: inherit;
      box-shadow: 0 8px 24px var(--shadow);
      max-height: 260px;
      overflow-y: auto;
      box-sizing: border-box;
    }
    .menu:popover-open { margin-top: 4px; }
    .menu[popover] { display: none; }
    .menu.visible[popover] { display: block; }

    .option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 13px;
    }
    .option:hover, .option.highlighted { background: var(--hover); }
    .option input { margin: 0; pointer-events: none; }
    .empty { padding: 6px 8px; opacity: 0.6; font-style: italic; font-size: 12px; }
    .create-option { color: var(--accent); font-style: italic; }
  `;

  constructor() {
    super();
    new SignalWatcher(this);
    this.tags = [];
    this.active = [];
    this.onToggle = () => {};
    this.allowCreate = false;
    this.#anchorName = `--tag-multiselect-${++_instanceCounter}`;
    this.#listboxId = `tag-multiselect-listbox-${_instanceCounter}`;
  }

  willUpdate() {
    this.style.width = this.width ?? '';
  }

  #boundOnDocumentClick = (e: MouseEvent) => {
    if (!e.composedPath().includes(this)) this.#closeMenu();
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('click', this.#boundOnDocumentClick);
  }

  disconnectedCallback() {
    document.removeEventListener('click', this.#boundOnDocumentClick);
    super.disconnectedCallback();
  }

  get #filtered() {
    const q = this.#query.value.trim().toLowerCase();
    if (!q) return this.tags;
    return this.tags.filter((t) => t.toLowerCase().includes(q));
  }

  #openMenu() {
    this.#open.set(true);
    this.updateComplete.then(() => {
      (this.renderRoot.querySelector('.menu') as HTMLElement | null)?.showPopover();
    });
  }

  #closeMenu() {
    this.#open.set(false);
    this.#highlighted.set(-1);
    (this.renderRoot.querySelector('.menu') as HTMLElement | null)?.hidePopover();
  }

  #toggleMenu() {
    if (this.#open.value) {
      this.#closeMenu();
    } else {
      this.#openMenu();
      (this.renderRoot.querySelector('.input') as HTMLElement | null)?.focus();
    }
  }

  #onInput(e: Event) {
    this.#query.set((e.target as HTMLInputElement).value);
    this.#highlighted.set(-1);
    this.#openMenu();
  }

  #selectOption(tag: string) {
    this.onToggle(tag);
    this.#query.set('');
    this.#highlighted.set(-1);
  }

  get #canCreate(): boolean {
    if (!this.allowCreate) return false;
    const q = this.#query.value.trim();
    return q.length > 0 && !this.tags.includes(q) && !this.active.includes(q);
  }

  #clearAll(e: Event) {
    e.stopPropagation();
    this.active.forEach((t) => this.onToggle(t));
    this.#query.set('');
    (this.renderRoot.querySelector('.input') as HTMLElement | null)?.focus();
    this.#openMenu();
  }

  #onKeydown(e: KeyboardEvent) {
    const items = this.#filtered;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.#openMenu();
      if (items.length) this.#highlighted.set((this.#highlighted.value + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.#openMenu();
      if (items.length) this.#highlighted.set((this.#highlighted.value - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' || (this.allowCreate && e.key === ',')) {
      const highlighted = items[this.#highlighted.value];
      if (highlighted !== undefined) {
        e.preventDefault();
        this.#selectOption(highlighted);
      } else if (this.#canCreate) {
        e.preventDefault();
        this.#selectOption(this.#query.value.trim());
      }
    } else if (e.key === 'Backspace' && !this.#query.value && this.active.length > 0) {
      const last = this.active[this.active.length - 1];
      if (last !== undefined) this.onToggle(last);
    } else if (e.key === 'Escape') {
      this.#closeMenu();
    }
  }

  render() {
    const active = this.active;
    const items = this.#filtered;
    const open = this.#open.value;
    const highlighted = this.#highlighted.value;
    return html`
      <div class="field" style=${`anchor-name: ${this.#anchorName}`}>
        <div class="chips-and-input">
          ${active.map(
            (tag) => html`
              <span class="selected-chip">
                ${tag}
                <span class="remove" @click=${() => this.onToggle(tag)}>✕</span>
              </span>
            `
          )}
          <input
            class="input"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded=${open}
            aria-controls=${this.#listboxId}
            aria-activedescendant=${highlighted >= 0 ? `${this.#listboxId}-opt-${highlighted}` : ''}
            placeholder=${active.length === 0 ? 'Filter by tag…' : ''}
            .value=${this.#query.value}
            @input=${(e: Event) => this.#onInput(e)}
            @focus=${() => this.#openMenu()}
            @click=${() => this.#openMenu()}
            @keydown=${(e: KeyboardEvent) => this.#onKeydown(e)}
          />
        </div>
        ${active.length > 0
          ? html`<button class="clear-btn" tabindex="-1" @mousedown=${(e: Event) => e.preventDefault()} @click=${(e: Event) => this.#clearAll(e)}>✕</button>`
          : ''}
        <button
          class="chevron-btn ${open ? 'open' : ''}"
          tabindex="-1"
          @mousedown=${(e: Event) => e.preventDefault()}
          @click=${() => this.#toggleMenu()}
        >
          ▾
        </button>
      </div>

      <ul
        id=${this.#listboxId}
        class="menu ${open ? 'visible' : ''}"
        role="listbox"
        aria-multiselectable="true"
        popover="manual"
        style=${`position-anchor: ${this.#anchorName}`}
      >
        ${items.length
          ? items.map(
              (tag, i) => html`
                <li
                  id=${`${this.#listboxId}-opt-${i}`}
                  role="option"
                  aria-selected=${active.includes(tag)}
                  class=${i === highlighted ? 'option highlighted' : 'option'}
                  @mousedown=${(e: Event) => e.preventDefault()}
                  @click=${() => this.#selectOption(tag)}
                >
                  <input type="checkbox" .checked=${active.includes(tag)} tabindex="-1" />
                  ${tag}
                </li>
              `
            )
          : this.#canCreate
            ? html`
                <li
                  class="option create-option"
                  @mousedown=${(e: Event) => e.preventDefault()}
                  @click=${() => this.#selectOption(this.#query.value.trim())}
                >
                  No match. Create '${this.#query.value.trim()}'
                </li>
              `
            : html`<li class="empty">${this.allowCreate ? 'Type to create a tag' : 'No matches'}</li>`}
      </ul>
    `;
  }
}

customElements.define('tag-multiselect', TagMultiselect);
