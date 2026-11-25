import { LitElement, css, html } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';

/**
 * Frame grabber: plays a video file (MP4, QuickTime .mov, WebM — whatever
 * the browser can decode) in a dialog. Scrub with the slider or step frame
 * by frame, then "Add frame" draws the current frame at the video's own
 * resolution and hands it to the editor as a PNG (a `frame` event), which
 * puts it on a new page. Nothing is uploaded: the video is read from disk.
 */

// Most screen recordings are 30 or 60 fps; one step of 1/30 s lands on a new frame either way.
const FRAME_STEP = 1 / 30;

export interface FrameEventDetail {
  blob: Blob;
  time: number;
}

function formatTime(t: number): string {
  if (!Number.isFinite(t)) return '0:00.00';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export class VideoFrames extends LitElement {
  static properties = {
    file: { attribute: false },
    added: { type: Number },
    duration: { state: true },
    time: { state: true },
    playing: { state: true },
    error: { state: true },
  };

  declare file: File | null;
  declare added: number;
  declare duration: number;
  declare time: number;
  declare playing: boolean;
  declare error: string;

  #video = createRef<HTMLVideoElement>();
  #url: string | null = null;
  #busy = false;

  constructor() {
    super();
    this.file = null;
    this.added = 0;
    this.duration = 0;
    this.time = 0;
    this.playing = false;
    this.error = '';
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 120;
      display: grid;
      place-items: center;
      background: rgba(0, 0, 0, 0.6);
      font: 13px system-ui, sans-serif;
      color: var(--text, #222);
    }
    .card {
      background: var(--panel, #fff);
      border-radius: 10px;
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);
      width: min(1100px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border, #ddd);
    }
    .header .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    video {
      display: block;
      background: #000;
      width: 100%;
      min-height: 0;
      flex: 1;
      max-height: calc(100vh - 200px);
      object-fit: contain;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid var(--border, #ddd);
    }
    input[type='range'] {
      flex: 1;
    }
    .time {
      font-variant-numeric: tabular-nums;
      min-width: 120px;
      text-align: center;
    }
    button {
      font: inherit;
      cursor: pointer;
      border: 1px solid var(--border, #ccc);
      border-radius: 6px;
      padding: 6px 10px;
      background: var(--button-bg, transparent);
      color: inherit;
    }
    .primary {
      background: var(--accent, #0a84ff);
      border-color: var(--accent, #0a84ff);
      color: #fff;
    }
    .error {
      padding: 24px;
      color: #d33;
    }
    .hint {
      opacity: 0.6;
      font-size: 12px;
      padding: 0 14px 10px;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.#onKey, true);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.#onKey, true);
    if (this.#url) URL.revokeObjectURL(this.#url);
    this.#url = null;
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('file')) {
      if (this.#url) URL.revokeObjectURL(this.#url);
      this.#url = this.file ? URL.createObjectURL(this.file) : null;
      this.error = '';
      this.duration = 0;
      this.time = 0;
    }
  }

  /** Keys go to the dialog while it is open (capture phase, so editor shortcuts never see them). */
  #onKey = (e: KeyboardEvent) => {
    const k = e.key;
    let handled = true;
    if (k === 'Escape') this.#close();
    else if (k === 'ArrowLeft' || k === ',') this.#step(e.shiftKey ? -1 : -FRAME_STEP);
    else if (k === 'ArrowRight' || k === '.') this.#step(e.shiftKey ? 1 : FRAME_STEP);
    else if (k === ' ' || k === 'k') this.#togglePlay();
    else if (k === 'Enter' || k === 'a') void this.#grab();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  #seek(t: number): void {
    const v = this.#video.value;
    if (!v || !this.duration) return;
    v.pause();
    v.currentTime = Math.min(this.duration, Math.max(0, t));
    this.time = v.currentTime;
  }

  #step(dt: number): void {
    this.#seek((this.#video.value?.currentTime ?? 0) + dt);
  }

  #togglePlay(): void {
    const v = this.#video.value;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  /** Waits until the frame at the current position is decoded and ready to draw. */
  async #frameReady(v: HTMLVideoElement): Promise<void> {
    if (!v.seeking && v.readyState >= 2) return;
    await new Promise<void>((resolve) => v.addEventListener('seeked', () => resolve(), { once: true }));
  }

  async #grab(): Promise<void> {
    const v = this.#video.value;
    if (!v || !v.videoWidth || this.#busy) return;
    this.#busy = true;
    try {
      v.pause();
      await this.#frameReady(v);
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext('2d')!.drawImage(v, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('could not encode the frame');
      this.dispatchEvent(new CustomEvent<FrameEventDetail>('frame', { detail: { blob, time: v.currentTime }, bubbles: true, composed: true }));
    } catch (err) {
      this.error = `Could not capture this frame: ${(err as Error).message}`;
    } finally {
      this.#busy = false;
    }
  }

  #close(): void {
    this.#video.value?.pause();
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  render() {
    return html`
      <div class="card" @click=${(e: Event) => e.stopPropagation()}>
        <div class="header">
          <span class="name">🎞 ${this.file?.name ?? ''}</span>
          ${this.added ? html`<span>${this.added} frame${this.added === 1 ? '' : 's'} added</span>` : ''}
          <button @click=${() => this.#close()} title="Close (Esc)">Done</button>
        </div>
        ${this.error && !this.duration
          ? html`<div class="error">${this.error}</div>`
          : html`
              <video
                ${ref(this.#video)}
                src=${this.#url ?? ''}
                preload="auto"
                muted
                playsinline
                @loadedmetadata=${(e: Event) => {
                  const v = e.target as HTMLVideoElement;
                  this.duration = v.duration;
                  // Show the first frame rather than a black box.
                  if (v.currentTime === 0) v.currentTime = 0.001;
                }}
                @timeupdate=${(e: Event) => (this.time = (e.target as HTMLVideoElement).currentTime)}
                @seeked=${(e: Event) => (this.time = (e.target as HTMLVideoElement).currentTime)}
                @play=${() => (this.playing = true)}
                @pause=${() => (this.playing = false)}
                @error=${() =>
                  (this.error = 'This browser cannot play this video. Try an MP4 (H.264), or open the .mov in Safari or Chrome.')}
                @click=${() => this.#togglePlay()}
              ></video>
              <div class="controls">
                <button @click=${() => this.#togglePlay()} title="Play / pause (Space)">${this.playing ? '⏸' : '▶'}</button>
                <button @click=${() => this.#step(-FRAME_STEP)} title="Previous frame (←; Shift+← one second)">⏮</button>
                <input
                  type="range"
                  min="0"
                  max=${this.duration || 0}
                  step="0.001"
                  .value=${String(this.time)}
                  @input=${(e: Event) => this.#seek(Number((e.target as HTMLInputElement).value))}
                />
                <button @click=${() => this.#step(FRAME_STEP)} title="Next frame (→; Shift+→ one second)">⏭</button>
                <span class="time">${formatTime(this.time)} / ${formatTime(this.duration)}</span>
                <button class="primary" ?disabled=${!this.duration} @click=${() => void this.#grab()} title="Add this frame as a new page (Enter)">
                  ＋ Add frame as page
                </button>
              </div>
              <div class="hint">
                Drag the slider or use ←/→ to find the frame, then Add frame (Enter). Each frame becomes a new page at the video's full
                resolution. ${this.error}
              </div>
            `}
      </div>
    `;
  }
}

customElements.define('screen-marker-video', VideoFrames);
