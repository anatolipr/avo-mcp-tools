import { LitElement, html, css } from 'lit';

/**
 * Full-screen slide viewer: one slide per page (image + annotations +
 * tags, pre-flattened by the caller into image URLs). Used both for
 * presenting the open document and for a shared public link, where it is
 * the whole UI (`public-view`: no exit back to the editor, only "Edit a copy").
 *
 * Keys: → / Space / PageDown / Enter next, ← / PageUp / Backspace previous,
 * Home / End, F fullscreen, Esc close (editor mode only). Clicking the right
 * or left half of the slide also steps forward / back.
 *
 * Events: `presenter-close`, `presenter-edit-copy`.
 */
export class ScreenMarkerPresenter extends LitElement {
  static properties = {
    slides: { attribute: false },
    index: { type: Number },
    publicView: { type: Boolean, attribute: 'public-view' },
    heading: { type: String },
    message: { type: String },
    idle: { state: true },
  };

  declare slides: string[];
  declare index: number;
  declare publicView: boolean;
  declare heading: string;
  declare message: string;
  declare idle: boolean;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.slides = [];
    this.index = 0;
    this.publicView = false;
    this.heading = '';
    this.message = '';
    this.idle = false;
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 200;
      background: #0b0b0c;
      color: #f0f0f0;
      font-family: system-ui, sans-serif;
      display: flex;
      flex-direction: column;
      user-select: none;
    }
    .slide {
      flex: 1;
      min-height: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      cursor: pointer;
    }
    .slide img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      box-shadow: 0 6px 40px rgba(0, 0, 0, 0.6);
    }
    .message {
      opacity: 0.75;
      font-size: 15px;
      text-align: center;
      max-width: 420px;
      line-height: 1.6;
    }
    .bar {
      position: absolute;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 10px;
      background: rgba(30, 30, 32, 0.85);
      backdrop-filter: blur(8px);
      transition: opacity 0.3s;
    }
    :host([data-idle]) .bar,
    :host([data-idle]) .top {
      opacity: 0;
    }
    :host([data-idle]) {
      cursor: none;
    }
    .top {
      position: absolute;
      top: 14px;
      left: 18px;
      right: 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      opacity: 0.8;
      transition: opacity 0.3s;
      pointer-events: none;
    }
    .top > * {
      pointer-events: auto;
    }
    button {
      font: inherit;
      font-size: 13px;
      color: inherit;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
    }
    button:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.18);
    }
    button:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .count {
      font-size: 13px;
      min-width: 56px;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.#onKey, true);
    window.addEventListener('pointermove', this.#wake);
    this.#wake();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.#onKey, true);
    window.removeEventListener('pointermove', this.#wake);
    clearTimeout(this.#idleTimer);
    if (document.fullscreenElement === this) void document.exitFullscreen();
  }

  /** Controls hide after a few idle seconds so the slide is unobstructed. */
  #wake = () => {
    if (this.idle) this.idle = false;
    this.removeAttribute('data-idle');
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.idle = true;
      this.setAttribute('data-idle', '');
    }, 2500);
  };

  #go(i: number): void {
    const n = this.slides.length;
    if (!n) return;
    this.index = Math.max(0, Math.min(n - 1, i));
  }

  #toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.requestFullscreen?.().catch(() => {});
  }

  #close(): void {
    this.dispatchEvent(new CustomEvent('presenter-close', { bubbles: true, composed: true }));
  }

  // Capture phase on window, so the editor underneath never sees these keys.
  #onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
      case ' ':
      case 'Enter':
        this.#go(this.index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
      case 'Backspace':
        this.#go(this.index - 1);
        break;
      case 'Home':
        this.#go(0);
        break;
      case 'End':
        this.#go(this.slides.length - 1);
        break;
      case 'f':
      case 'F':
        this.#toggleFullscreen();
        break;
      case 'Escape':
        // Leaving fullscreen is the browser's own Esc; only close when not fullscreen.
        if (!document.fullscreenElement && !this.publicView) this.#close();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.#wake();
    }
  };

  #onSlideClick = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    this.#go(this.index + (e.clientX - rect.left < rect.width / 2 ? -1 : 1));
  };

  render() {
    const n = this.slides.length;
    const src = this.slides[this.index];
    return html`
      <div class="top">
        <span>${this.heading}</span>
        ${this.publicView
          ? html`<button @click=${() => this.dispatchEvent(new CustomEvent('presenter-edit-copy', { bubbles: true, composed: true }))}>
              Edit a copy
            </button>`
          : html`<button @click=${() => this.#close()} title="Close (Esc)">✕ Close</button>`}
      </div>
      <div class="slide" @click=${this.#onSlideClick}>
        ${src ? html`<img src=${src} alt="Slide ${this.index + 1} of ${n}" />` : html`<div class="message">${this.message}</div>`}
      </div>
      ${n
        ? html`
            <div class="bar">
              <button ?disabled=${this.index === 0} @click=${() => this.#go(this.index - 1)} title="Previous (←)">‹</button>
              <span class="count">${this.index + 1} / ${n}</span>
              <button ?disabled=${this.index >= n - 1} @click=${() => this.#go(this.index + 1)} title="Next (→)">›</button>
              <button @click=${() => this.#toggleFullscreen()} title="Fullscreen (F)">⛶</button>
            </div>
          `
        : ''}
    `;
  }
}

customElements.define('screen-marker-presenter', ScreenMarkerPresenter);
