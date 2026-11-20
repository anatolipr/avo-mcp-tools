import { LitElement, html, css } from 'lit';

/** One slide: its build images (one when nothing is revealed step by step), plus title and speaker notes. */
export interface Slide {
  builds: string[];
  // Size of every build image, in image pixels.
  width: number;
  height: number;
  title: string;
  notes: string;
}

/**
 * Full-screen slide viewer: one slide per page (image + annotations +
 * tags, pre-flattened by the caller into image URLs). Used both for
 * presenting the open document and for a shared public link, where it is
 * the whole UI (`public-view`: no exit back to the editor, only "Edit a copy").
 *
 * Keys: → / Space / PageDown / Enter next (next reveal step, then next
 * slide), ← / PageUp / Backspace previous, Home / End, F fullscreen,
 * L laser pointer (hold, or tap to toggle), N speaker notes (editor mode
 * only), Esc close (editor mode only). Clicking the right or left half of
 * the slide also steps forward / back. Zoom: `zoom` (editor zoom, image
 * pixels to device pixels) opens at that size, else slides fit the screen;
 * +/- and Cmd/Ctrl +/-, Cmd/Ctrl+wheel or pinch zoom, 0 fits again, and a
 * zoomed slide scrolls.
 *
 * Events: `presenter-close`, `presenter-edit-copy`.
 */
export class ScreenMarkerPresenter extends LitElement {
  static properties = {
    slides: { attribute: false },
    index: { type: Number },
    zoom: { attribute: false },
    scale: { state: true },
    build: { state: true },
    laser: { state: true },
    laserPos: { state: true },
    showNotes: { state: true },
    publicView: { type: Boolean, attribute: 'public-view' },
    heading: { type: String },
    message: { type: String },
    idle: { state: true },
  };

  declare slides: Slide[];
  declare index: number;
  declare zoom: number | null;
  // CSS pixels per slide pixel; null fits the slide to the screen.
  declare scale: number | null;
  declare build: number;
  declare laser: boolean;
  declare laserPos: { x: number; y: number } | null;
  declare showNotes: boolean;
  #laserDownAt = 0;
  declare publicView: boolean;
  declare heading: string;
  declare message: string;
  declare idle: boolean;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.slides = [];
    this.index = 0;
    this.zoom = null;
    this.scale = null;
    this.build = 0;
    this.laser = false;
    this.laserPos = null;
    this.showNotes = false;
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
      /* Follows the image's alpha, so transparent margins around tags cast no box. */
      filter: drop-shadow(0 6px 30px rgba(0, 0, 0, 0.6));
    }
    /* Flex + auto margins, not grid centering, so an overflowing slide can scroll to every edge. */
    .slide.zoomed {
      display: flex;
      overflow: auto;
    }
    .slide.zoomed img {
      flex: none;
      margin: auto;
      max-width: none;
      max-height: none;
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
    .laser {
      position: fixed;
      width: 16px;
      height: 16px;
      margin: -8px 0 0 -8px;
      border-radius: 50%;
      background: radial-gradient(circle, #ff2d2d 0 35%, rgba(255, 45, 45, 0.45) 55%, rgba(255, 45, 45, 0) 72%);
      box-shadow: 0 0 14px 4px rgba(255, 40, 40, 0.55);
      pointer-events: none;
      z-index: 5;
    }
    :host([data-laser]) .slide {
      cursor: none;
    }
    .notes {
      flex: none;
      max-height: 28vh;
      overflow: auto;
      padding: 12px 24px 64px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      font-size: 16px;
      line-height: 1.5;
      white-space: pre-wrap;
      background: #151517;
    }
    .notes.empty {
      opacity: 0.5;
      font-style: italic;
    }
    .dots {
      display: inline-flex;
      gap: 3px;
      margin-left: 2px;
    }
    .dots i {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.25);
    }
    .dots i.on {
      background: rgba(255, 255, 255, 0.85);
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
    window.addEventListener('keyup', this.#onKeyUp, true);
    window.addEventListener('pointermove', this.#onMove);
    this.addEventListener('wheel', this.#onWheel, { passive: false });
    this.#wake();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.#onKey, true);
    window.removeEventListener('keyup', this.#onKeyUp, true);
    window.removeEventListener('pointermove', this.#onMove);
    this.removeEventListener('wheel', this.#onWheel);
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

  #onMove = (e: PointerEvent) => {
    if (this.laser) this.laserPos = { x: e.clientX, y: e.clientY };
    if (!this.laser) this.#wake();
  };

  #setLaser(on: boolean): void {
    this.laser = on;
    this.toggleAttribute('data-laser', on);
    if (!on) this.laserPos = null;
  }

  #go(i: number, build = 0): void {
    const n = this.slides.length;
    if (!n) return;
    this.index = Math.max(0, Math.min(n - 1, i));
    const builds = this.slides[this.index]!.builds.length;
    this.build = build < 0 ? builds - 1 : Math.min(build, builds - 1);
  }

  /** Next reveal step on this slide, else the next slide. */
  #next(): void {
    const builds = this.slides[this.index]?.builds.length ?? 1;
    if (this.build < builds - 1) this.build++;
    else if (this.index < this.slides.length - 1) this.#go(this.index + 1);
  }

  /** Previous reveal step, else the previous slide fully revealed. */
  #prev(): void {
    if (this.build > 0) this.build--;
    else if (this.index > 0) this.#go(this.index - 1, -1);
  }

  #dpr(): number {
    return window.devicePixelRatio || 1;
  }

  /** Current CSS pixels per slide pixel, measured when fitting. */
  #currentScale(): number {
    if (this.scale !== null) return this.scale;
    const img = this.renderRoot.querySelector('.slide img');
    const w = this.slides[this.index]?.width;
    return img && w ? img.getBoundingClientRect().width / w : 1 / this.#dpr();
  }

  /** Sets the zoom, keeping the slide point under (clientX, clientY) fixed; defaults to the view center. */
  async #zoomTo(scale: number, clientX?: number, clientY?: number): Promise<void> {
    const dpr = this.#dpr();
    // Same limits as the editor (10%–400%), in its device-pixel terms.
    scale = Math.min(4 / dpr, Math.max(0.1 / dpr, scale));
    const view = this.renderRoot.querySelector<HTMLElement>('.slide');
    const img = view?.querySelector('img');
    if (!view || !img) {
      this.scale = scale;
      return;
    }
    const v = view.getBoundingClientRect();
    const x = clientX ?? v.left + v.width / 2;
    const y = clientY ?? v.top + v.height / 2;
    const r = img.getBoundingClientRect();
    const fx = (x - r.left) / r.width;
    const fy = (y - r.top) / r.height;
    this.scale = scale;
    await this.updateComplete;
    const r2 = img.getBoundingClientRect();
    view.scrollLeft += r2.left + fx * r2.width - x;
    view.scrollTop += r2.top + fy * r2.height - y;
  }

  #zoomBy(factor: number, clientX?: number, clientY?: number): void {
    void this.#zoomTo(this.#currentScale() * factor, clientX, clientY);
  }

  /** Cmd/Ctrl+wheel and trackpad pinch zoom around the cursor; a plain wheel scrolls a zoomed slide. */
  #onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    this.#zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX, e.clientY);
  };

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('zoom')) this.scale = this.zoom ? this.zoom / this.#dpr() : null;
    // A new deck (or start index) from the host starts that slide at its first step.
    if (changed.has('slides') || changed.has('index')) {
      const builds = this.slides[this.index]?.builds.length ?? 1;
      if (this.build >= builds) this.build = 0;
    }
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
    if (e.altKey) return;
    // Zoom keys work bare and with Cmd/Ctrl (the editor's shortcuts); other modified keys pass through.
    const zoomKey = e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0';
    if ((e.metaKey || e.ctrlKey) && !zoomKey) return;
    let handled = true;
    switch (e.key) {
      case '=':
      case '+':
        this.#zoomBy(1.2);
        break;
      case '-':
        this.#zoomBy(1 / 1.2);
        break;
      case '0':
        this.scale = null;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
      case ' ':
      case 'Enter':
        this.#next();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
      case 'Backspace':
        this.#prev();
        break;
      case 'l':
      case 'L':
        // Hold L for the laser; a quick tap toggles it on until the next tap.
        if (!e.repeat) {
          this.#laserDownAt = Date.now();
          if (!this.laser) this.#setLaser(true);
          else this.#laserDownAt = -1; // this press turns it off on release
        }
        break;
      case 'n':
      case 'N':
        if (!this.publicView) this.showNotes = !this.showNotes;
        break;
      case 'Home':
        this.#go(0);
        break;
      case 'End':
        this.#go(this.slides.length - 1, -1);
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

  #onKeyUp = (e: KeyboardEvent) => {
    if (e.key !== 'l' && e.key !== 'L') return;
    e.stopImmediatePropagation();
    const held = this.#laserDownAt > 0 && Date.now() - this.#laserDownAt > 250;
    if (this.#laserDownAt === -1 || held) this.#setLaser(false);
    this.#laserDownAt = 0;
  };

  #onSlideClick = (e: MouseEvent) => {
    if (this.laser) return; // pointing, not navigating
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    if (e.clientX - rect.left < rect.width / 2) this.#prev();
    else this.#next();
  };

  render() {
    const n = this.slides.length;
    const slide = this.slides[this.index];
    const src = slide?.builds[this.build];
    const title = slide?.title || this.heading;
    const zoomed = this.scale !== null && !!slide?.width;
    return html`
      <div class="top">
        <span>${title}</span>
        ${this.publicView
          ? html`<button @click=${() => this.dispatchEvent(new CustomEvent('presenter-edit-copy', { bubbles: true, composed: true }))}>
              Edit a copy
            </button>`
          : html`<button @click=${() => this.#close()} title="Close (Esc)">✕ Close</button>`}
      </div>
      <div class="slide ${zoomed ? 'zoomed' : ''}" @click=${this.#onSlideClick}>
        ${src
          ? html`<img
              src=${src}
              alt="Slide ${this.index + 1} of ${n}"
              style=${zoomed ? `width:${slide!.width * this.scale!}px; height:${slide!.height * this.scale!}px` : ''}
            />`
          : html`<div class="message">${this.message}</div>`}
      </div>
      ${this.showNotes && !this.publicView
        ? html`<div class="notes ${slide?.notes ? '' : 'empty'}">${slide?.notes || 'No notes for this slide.'}</div>`
        : ''}
      ${n
        ? html`
            <div class="bar">
              <button ?disabled=${this.index === 0 && this.build === 0} @click=${() => this.#prev()} title="Previous (←)">‹</button>
              <span class="count">${this.index + 1} / ${n}</span>
              ${slide && slide.builds.length > 1
                ? html`<span class="dots" title="Reveal steps">${slide.builds.map((_, i) => html`<i class=${i <= this.build ? 'on' : ''}></i>`)}</span>`
                : ''}
              <button
                ?disabled=${this.index >= n - 1 && this.build >= (slide?.builds.length ?? 1) - 1}
                @click=${() => this.#next()}
                title="Next (→)"
              >
                ›
              </button>
              <button class=${this.laser ? 'on' : ''} @click=${() => this.#setLaser(!this.laser)} title="Laser pointer (hold or tap L)">●</button>
              ${this.publicView
                ? ''
                : html`<button @click=${() => (this.showNotes = !this.showNotes)} title="Speaker notes (N)">Notes</button>`}
              <button @click=${() => this.#zoomBy(1 / 1.2)} title="Zoom out (-, Cmd/Ctrl+scroll, pinch)">−</button>
              <button
                class="count"
                @click=${() => (this.scale = null)}
                title="Fit to screen (0)"
              >${zoomed ? `${Math.round(this.scale! * this.#dpr() * 100)}%` : 'Fit'}</button>
              <button @click=${() => this.#zoomBy(1.2)} title="Zoom in (+, Cmd/Ctrl+scroll, pinch)">+</button>
              <button @click=${() => this.#toggleFullscreen()} title="Fullscreen (F)">⛶</button>
            </div>
          `
        : ''}
      ${this.laser && this.laserPos ? html`<div class="laser" style="left:${this.laserPos.x}px; top:${this.laserPos.y}px"></div>` : ''}
    `;
  }
}

customElements.define('screen-marker-presenter', ScreenMarkerPresenter);
