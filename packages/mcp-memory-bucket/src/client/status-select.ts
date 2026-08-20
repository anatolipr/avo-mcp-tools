import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';

let _instanceCounter = 0;

/**
 * Single-select combobox for a free-form status: click to open a popover listing every known
 * option (not just the current value — a plain <input list> "datalist" only surfaces options
 * that match the current text, which reads as "there's only one option" once a value is picked).
 * Typing filters the list; a query matching nothing offers "Create '<query>'", same affordance
 * as tag-multiselect's allowCreate, but selecting/creating here replaces the value and closes
 * the menu instead of toggling a multi-select set.
 */
export class StatusSelect extends LitElement {
  static properties = {
    options: { attribute: false },
    value: { attribute: false },
    onChange: { attribute: false },
  };

  declare options: string[];
  declare value: string;
  declare onChange: (value: string) => void;

  #query = new Signal<string>('');
  #open = new Signal<boolean>(false);
  #highlighted = new Signal<number>(-1);
  #anchorName: string;
  #listboxId: string;

  static styles = css`
    :host {
      display: inline-block;
      position: relative;
      width: 100%;
      max-width: 320px;
      font: inherit;
      font-size: 13px;
    }
    .field {
      display: flex;
      align-items: center;
      gap: 4px;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      background: var(--bg);
      padding: 3px 4px 3px 8px;
      min-height: 30px;
      box-sizing: border-box;
    }
    .field:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-tint);
    }
    .input {
      flex: 1 1 auto;
      min-width: 0;
      border: none;
      outline: none;
      padding: 5px 2px;
      font: inherit;
      font-size: 13px;
      background: transparent;
      color: inherit;
    }
    .chevron-btn {
      border: none;
      background: transparent;
      cursor: pointer;
      color: inherit;
      opacity: 0.6;
      font-size: 12px;
      padding: 2px 5px;
      line-height: 1;
      flex: 0 0 auto;
    }
    .chevron-btn:hover { opacity: 1; }
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
    .option.selected { font-weight: 600; }
    .empty { padding: 6px 8px; opacity: 0.6; font-style: italic; font-size: 12px; }
    .create-option { color: var(--accent); font-style: italic; }
  `;

  constructor() {
    super();
    new SignalWatcher(this);
    this.options = [];
    this.value = '';
    this.onChange = () => {};
    this.#anchorName = `--status-select-${++_instanceCounter}`;
    this.#listboxId = `status-select-listbox-${_instanceCounter}`;
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

  // Unfiltered when the query is untouched (e.g. it still equals the current value) so opening
  // the menu always shows every option — only actively typing a *different* query narrows it.
  get #filtered() {
    const q = this.#query.value.trim().toLowerCase();
    if (!q || q === this.value.trim().toLowerCase()) return this.options;
    return this.options.filter((o) => o.toLowerCase().includes(q));
  }

  #openMenu() {
    this.#query.set(this.value);
    this.#open.set(true);
    this.updateComplete.then(() => {
      (this.renderRoot.querySelector('.menu') as HTMLElement | null)?.showPopover();
    });
  }

  #closeMenu() {
    this.#open.set(false);
    this.#highlighted.set(-1);
    this.#query.set(this.value);
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
    if (!this.#open.value) this.#openMenu();
  }

  #normalize(raw: string): string {
    return raw.trim().toLowerCase().replace(/\s+/g, '-');
  }

  #selectOption(raw: string) {
    const normalized = this.#normalize(raw);
    if (!normalized) return this.#closeMenu();
    this.onChange(normalized);
    this.#query.set(normalized);
    this.#highlighted.set(-1);
    this.#closeMenu();
  }

  get #canCreate(): boolean {
    const q = this.#normalize(this.#query.value);
    return q.length > 0 && !this.options.some((o) => o.toLowerCase() === q);
  }

  // Navigable rows = filtered options, plus a trailing "create" row when offered — kept in sync
  // with render()'s <li> list so arrow keys and Enter can reach the create row too.
  get #navigableCount(): number {
    return this.#filtered.length + (this.#canCreate ? 1 : 0);
  }

  #onKeydown(e: KeyboardEvent) {
    const count = this.#navigableCount;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.#openMenu();
      if (count) this.#highlighted.set((this.#highlighted.value + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.#openMenu();
      if (count) this.#highlighted.set((this.#highlighted.value - 1 + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const items = this.#filtered;
      const highlightedOption = items[this.#highlighted.value];
      if (highlightedOption !== undefined) {
        this.#selectOption(highlightedOption);
      } else if (this.#highlighted.value === items.length && this.#canCreate) {
        this.#selectOption(this.#query.value);
      } else if (this.#query.value.trim()) {
        this.#selectOption(this.#query.value);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.#closeMenu();
    }
  }

  render() {
    const value = this.value;
    const items = this.#filtered;
    const open = this.#open.value;
    const highlighted = this.#highlighted.value;
    return html`
      <div class="field" style=${`anchor-name: ${this.#anchorName}`}>
        <input
          class="input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded=${open}
          aria-controls=${this.#listboxId}
          aria-activedescendant=${highlighted >= 0 ? `${this.#listboxId}-opt-${highlighted}` : ''}
          .value=${open ? this.#query.value : value}
          @input=${(e: Event) => this.#onInput(e)}
          @focus=${() => this.#openMenu()}
          @click=${() => this.#openMenu()}
          @keydown=${(e: KeyboardEvent) => this.#onKeydown(e)}
          @blur=${() => {
            // A blur not caused by clicking inside the menu (mousedown there is prevented,
            // so this only fires for tab-away/outside-click) commits free-typed text as-is.
            if (this.#open.value && this.#query.value.trim() && this.#normalize(this.#query.value) !== value) {
              this.#selectOption(this.#query.value);
            } else {
              this.#closeMenu();
            }
          }}
        />
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
        popover="manual"
        style=${`position-anchor: ${this.#anchorName}`}
      >
        ${items.map(
          (option, i) => html`
            <li
              id=${`${this.#listboxId}-opt-${i}`}
              role="option"
              aria-selected=${option === value}
              class=${`option ${option === value ? 'selected' : ''} ${i === highlighted ? 'highlighted' : ''}`}
              @mousedown=${(e: Event) => e.preventDefault()}
              @click=${() => this.#selectOption(option)}
            >
              ${option}
            </li>
          `
        )}
        ${this.#canCreate
          ? html`
              <li
                id=${`${this.#listboxId}-opt-${items.length}`}
                role="option"
                class=${`option create-option ${items.length === highlighted ? 'highlighted' : ''}`}
                @mousedown=${(e: Event) => e.preventDefault()}
                @click=${() => this.#selectOption(this.#query.value)}
              >
                ${items.length ? 'Create' : 'No match. Create'} '${this.#normalize(this.#query.value)}'
              </li>
            `
          : ''}
        ${!items.length && !this.#canCreate ? html`<li class="empty">No options</li>` : ''}
      </ul>
    `;
  }
}

customElements.define('status-select', StatusSelect);
