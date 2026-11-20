import { LitElement, html, css } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';

/** One palette entry. `hint` is a shortcut or short note shown on the right. */
export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// Two Shift taps (with no other key between) this close together open the palette.
const DOUBLE_SHIFT_MS = 300;

/**
 * Fuzzy match score of `query` against `text`: every query character must
 * appear in order; earlier, consecutive and word-start matches score higher.
 * Returns -1 for no match.
 */
function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const direct = t.indexOf(query.toLowerCase().trim());
  if (direct !== -1) return 1000 - direct;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i === -1) return -1;
    if (i === prev + 1) score += 5;
    if (i === 0 || /[\s\-/(]/.test(t[i - 1]!)) score += 8;
    score -= i - ti;
    prev = i;
    ti = i + 1;
  }
  return score;
}

/**
 * Shift-Shift command palette: a fuzzy-searchable list of the app's
 * commands. Opens on a double Shift tap anywhere on the page (or `open()`);
 * ↑/↓ choose, Enter runs, Esc or a click outside closes. The host passes
 * `commands`, rebuilt when it renders, so labels and availability stay current.
 */
export class ScreenMarkerPalette extends LitElement {
  static properties = {
    commands: { attribute: false },
    query: { state: true },
    selected: { state: true },
  };

  declare commands: Command[];
  declare query: string;
  declare selected: number;
  #dialog = createRef<HTMLDialogElement>();
  #input = createRef<HTMLInputElement>();
  #lastShift = 0;

  constructor() {
    super();
    this.commands = [];
    this.query = '';
    this.selected = 0;
  }

  static styles = css`
    dialog {
      width: min(560px, calc(100vw - 32px));
      margin-top: 12vh;
      padding: 0;
      border: 1px solid var(--border, #3a3b3e);
      border-radius: 12px;
      background: var(--panel, #232427);
      color: var(--text, #f0f0f0);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
      font-family: system-ui, sans-serif;
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.35);
    }
    input {
      box-sizing: border-box;
      width: 100%;
      padding: 14px 16px;
      font: inherit;
      font-size: 16px;
      color: inherit;
      background: transparent;
      border: none;
      border-bottom: 1px solid var(--border, #3a3b3e);
      outline: none;
    }
    .list {
      max-height: 50vh;
      overflow: auto;
      padding: 6px;
    }
    .item {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
    }
    .item.selected {
      background: var(--accent, #007aff);
      color: #fff;
    }
    .hint {
      opacity: 0.6;
      font-size: 12px;
      white-space: nowrap;
    }
    .empty {
      padding: 12px;
      opacity: 0.6;
      font-size: 14px;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.#onWindowKey, true);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.#onWindowKey, true);
  }

  /** Detects the double Shift tap; any other key in between cancels it. */
  #onWindowKey = (e: KeyboardEvent) => {
    if (e.key !== 'Shift' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) {
      this.#lastShift = 0;
      return;
    }
    const now = performance.now();
    if (this.#lastShift && now - this.#lastShift < DOUBLE_SHIFT_MS) {
      this.#lastShift = 0;
      if (!this.#dialog.value?.open) this.open();
    } else {
      this.#lastShift = now;
    }
  };

  open(): void {
    this.query = '';
    this.selected = 0;
    this.#dialog.value?.showModal();
    void this.updateComplete.then(() => this.#input.value?.focus());
  }

  #close(): void {
    this.#dialog.value?.close();
  }

  #results(): Command[] {
    if (!this.query.trim()) return this.commands;
    return this.commands
      .map((c) => ({ c, score: fuzzyScore(`${c.label} ${c.hint ?? ''}`, this.query) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.c);
  }

  #run(cmd: Command | undefined): void {
    if (!cmd) return;
    this.#close();
    // After the dialog closes, so commands that focus or open things are not undone by it.
    setTimeout(() => cmd.run(), 0);
  }

  #onKey = (e: KeyboardEvent) => {
    const results = this.#results();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      this.selected = (this.selected + dir + results.length) % results.length;
      void this.updateComplete.then(() =>
        this.renderRoot.querySelector('.item.selected')?.scrollIntoView({ block: 'nearest' })
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.#run(results[this.selected]);
    }
    // Keep the editor's own shortcuts from firing while typing here.
    e.stopPropagation();
  };

  #onDialogClick = (e: MouseEvent) => {
    const d = this.#dialog.value;
    if (!d) return;
    const r = d.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) this.#close();
  };

  render() {
    const results = this.#results();
    return html`
      <dialog ${ref(this.#dialog)} @click=${this.#onDialogClick}>
        <input
          ${ref(this.#input)}
          placeholder="Type a command…"
          .value=${this.query}
          @input=${(e: Event) => {
            this.query = (e.target as HTMLInputElement).value;
            this.selected = 0;
          }}
          @keydown=${this.#onKey}
        />
        <div class="list">
          ${results.length
            ? results.map(
                (c, i) => html`<div
                  class="item ${i === this.selected ? 'selected' : ''}"
                  @mousemove=${() => {
                    if (this.selected !== i) this.selected = i;
                  }}
                  @click=${() => this.#run(c)}
                >
                  <span>${c.label}</span>${c.hint ? html`<span class="hint">${c.hint}</span>` : ''}
                </div>`
              )
            : html`<div class="empty">No matching command</div>`}
        </div>
      </dialog>
    `;
  }
}

customElements.define('screen-marker-palette', ScreenMarkerPalette);
