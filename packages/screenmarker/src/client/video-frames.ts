import { LitElement, css, html } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';

/**
 * Frame grabber: plays a video file (MP4, QuickTime .mov, WebM — whatever
 * the browser can decode) in a dialog. Nothing is uploaded: the video is
 * read from disk.
 *
 * - Scrub or step to a frame and "Add this frame", or place markers (M) on
 *   several frames, review them ("Marked"), and add them all as pages.
 * - "Detect changes" samples the video once into small brightness grids,
 *   then places markers where a large enough part of the screen changed
 *   (a dialog opening, a new page) and settled. The sensitivity dial sets
 *   how much of the screen must change, so a moving cursor or a blinking
 *   caret is ignored; moving it re-computes the markers instantly from the
 *   cached samples.
 *
 * Emits `frames` with the captured PNGs (full video resolution), in time order.
 */

// Most screen recordings are 30 or 60 fps; one step of 1/30 s lands on a new frame either way.
const FRAME_STEP = 1 / 30;
// Detection grid: frames are scaled to this width, then averaged in CELL×CELL squares.
const SAMPLE_WIDTH = 192;
const CELL = 4;
// A cell counts as changed when its brightness moved by more than this (0–255).
const CELL_DELTA = 10;
// Markers closer than this (seconds) are the same marker.
const SAME_TIME = 0.15;
// A change that never settles (scrolling, video playing) is marked after this long anyway.
const MAX_SETTLE = 2;

export interface FrameEventDetail {
  frames: { blob: Blob; time: number }[];
}

interface Marker {
  time: number;
  auto: boolean;
}

interface Sample {
  time: number;
  cells: Uint8Array;
}

function formatTime(t: number): string {
  if (!Number.isFinite(t)) return '0:00.00';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** Share of the screen that must change, for a sensitivity of 0–100 (100: the slightest change). */
export function thresholdFor(sensitivity: number): number {
  const k = 1 - Math.min(100, Math.max(0, sensitivity)) / 100;
  return 0.002 + 0.3 * k * k;
}

/** Fraction of cells whose brightness changed noticeably between two samples. */
function changed(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > CELL_DELTA) n++;
  return n / a.length;
}

/**
 * Times worth a screenshot: the first frame, then each point where the
 * screen differs from the last marked frame by at least `threshold` and has
 * settled (stopped changing), so mid-animation frames are skipped.
 */
export function detectChanges(samples: Sample[], threshold: number, skipRepeats = false): number[] {
  if (!samples.length) return [];
  const out = [samples[0]!.time];
  const marked = [samples[0]!];
  let ref = samples[0]!;
  let pendingSince: number | null = null;
  const settled = Math.min(threshold / 2, 0.01);
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    if (pendingSince === null && changed(s.cells, ref.cells) >= threshold) pendingSince = s.time;
    if (pendingSince === null) continue;
    const still = changed(s.cells, samples[i - 1]!.cells) <= settled;
    if (still || s.time - pendingSince >= MAX_SETTLE || i === samples.length - 1) {
      // It may have changed back (a tooltip that came and went): only mark a real difference.
      if (changed(s.cells, ref.cells) >= threshold) {
        // With skipRepeats, a screen that looks like one already marked (switching back to it) is not marked again.
        if (!skipRepeats || !marked.some((m) => changed(s.cells, m.cells) < threshold)) {
          out.push(s.time);
          marked.push(s);
        }
        ref = s;
      }
      pendingSince = null;
    }
  }
  return out;
}

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(v.currentTime - t) < 1e-4 && !v.seeking && v.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, 4000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the frame'))), type, quality)
  );
}

export class VideoFrames extends LitElement {
  static properties = {
    file: { attribute: false },
    added: { type: Number },
    duration: { state: true },
    time: { state: true },
    playing: { state: true },
    error: { state: true },
    markers: { state: true },
    sensitivity: { state: true },
    skipRepeats: { state: true },
    reviewing: { state: true },
    progress: { state: true },
  };

  declare file: File | null;
  declare added: number;
  declare duration: number;
  declare time: number;
  declare playing: boolean;
  declare error: string;
  declare markers: Marker[];
  declare sensitivity: number;
  declare skipRepeats: boolean;
  declare reviewing: boolean;
  // A running job (sampling, thumbnails, adding frames): label and 0–1, or null.
  declare progress: { label: string; value: number } | null;

  #video = createRef<HTMLVideoElement>();
  #url: string | null = null;
  // A second, hidden player for detection, thumbnails and full-size captures, so the visible one keeps its place.
  #sampler: HTMLVideoElement | null = null;
  #samplerQueue: Promise<unknown> = Promise.resolve();
  #samples: Sample[] | null = null;
  #cancel = false;
  #thumbs = new Map<number, string>();

  constructor() {
    super();
    this.file = null;
    this.added = 0;
    this.duration = 0;
    this.time = 0;
    this.playing = false;
    this.error = '';
    this.markers = [];
    this.sensitivity = 50;
    this.skipRepeats = false;
    this.reviewing = false;
    this.progress = null;
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
      height: calc(100vh - 32px);
      max-height: 900px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .header,
    .controls,
    .detect {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      flex-wrap: wrap;
    }
    .header {
      border-bottom: 1px solid var(--border, #ddd);
    }
    .header .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .controls,
    .detect {
      border-top: 1px solid var(--border, #ddd);
    }
    .stage {
      flex: 1;
      min-height: 0;
      position: relative;
      background: #000;
    }
    video {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .grid {
      position: absolute;
      inset: 0;
      overflow: auto;
      background: var(--panel, #fff);
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      align-content: start;
      gap: 12px;
      padding: 14px;
    }
    .shot {
      position: relative;
      border: 1px solid var(--border, #ddd);
      border-radius: 6px;
      overflow: hidden;
      cursor: pointer;
      background: rgba(128, 128, 128, 0.12);
    }
    .shot img,
    .shot .ph {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 9;
      object-fit: contain;
      background: #000;
    }
    .shot .meta {
      display: flex;
      justify-content: space-between;
      padding: 4px 6px;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .shot .x {
      position: absolute;
      top: 4px;
      right: 4px;
      padding: 0 6px;
    }
    .track {
      flex: 1;
      min-width: 200px;
      position: relative;
      display: flex;
      align-items: center;
    }
    .track input {
      width: 100%;
      margin: 10px 0;
    }
    .tick {
      position: absolute;
      top: 0;
      width: 2px;
      height: 8px;
      margin-left: -1px;
      background: var(--accent, #0a84ff);
      cursor: pointer;
    }
    .tick.auto {
      background: #f5a623;
    }
    .tick::after {
      content: '';
      position: absolute;
      inset: -4px -5px;
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
      padding: 5px 10px;
      background: var(--button-bg, transparent);
      color: inherit;
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    button.on {
      background: rgba(10, 132, 255, 0.15);
      border-color: var(--accent, #0a84ff);
    }
    .primary {
      background: var(--accent, #0a84ff);
      border-color: var(--accent, #0a84ff);
      color: #fff;
    }
    .sens {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .sens input {
      width: 140px;
    }
    .muted {
      opacity: 0.65;
      font-size: 12px;
    }
    progress {
      width: 140px;
    }
    .spacer {
      flex: 1;
    }
    .error {
      padding: 24px;
      color: #d33;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.#onKey, true);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.#onKey, true);
    this.#cancel = true;
    this.#sampler?.removeAttribute('src');
    this.#sampler = null;
    if (this.#url) URL.revokeObjectURL(this.#url);
    this.#url = null;
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('file')) {
      if (this.#url) URL.revokeObjectURL(this.#url);
      this.#url = this.file ? URL.createObjectURL(this.file) : null;
      this.#sampler = null;
      this.#samples = null;
      this.#thumbs.clear();
      this.error = '';
      this.duration = 0;
      this.time = 0;
      this.markers = [];
      this.reviewing = false;
    }
  }

  /** Keys go to the dialog while it is open (capture phase, so editor shortcuts never see them). */
  #onKey = (e: KeyboardEvent) => {
    const target = e.composedPath()[0] as HTMLElement | undefined;
    // Let the sliders handle their own arrow keys.
    if (target?.tagName === 'INPUT' && e.key.startsWith('Arrow')) return;
    const k = e.key;
    let handled = true;
    if (k === 'Escape') this.reviewing ? (this.reviewing = false) : this.#close();
    else if (k === 'ArrowLeft' || k === ',') this.#step(e.shiftKey ? -1 : -FRAME_STEP);
    else if (k === 'ArrowRight' || k === '.') this.#step(e.shiftKey ? 1 : FRAME_STEP);
    else if (k === ' ' || k === 'k') this.#togglePlay();
    else if (k === 'm' || k === 'M') this.#toggleMarker();
    else if (k === 'Enter') void (e.shiftKey ? this.#addMarked() : this.#addCurrent());
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ---------- playback ----------

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
    if (!v || this.reviewing) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  #jumpTo(t: number): void {
    this.reviewing = false;
    void this.updateComplete.then(() => this.#seek(t));
  }

  // ---------- markers ----------

  #sorted(list: Marker[]): Marker[] {
    return [...list].sort((a, b) => a.time - b.time);
  }

  #toggleMarker(t = this.#video.value?.currentTime ?? this.time): void {
    const near = this.markers.find((m) => Math.abs(m.time - t) < SAME_TIME / 2);
    this.markers = near ? this.markers.filter((m) => m !== near) : this.#sorted([...this.markers, { time: t, auto: false }]);
  }

  #removeMarker(m: Marker): void {
    this.markers = this.markers.filter((x) => x !== m);
  }

  /** Replaces the detected markers (hand-placed ones stay) with the times found at the current sensitivity. */
  #applyDetection(): void {
    if (!this.#samples) return;
    const manual = this.markers.filter((m) => !m.auto);
    const found = detectChanges(this.#samples, thresholdFor(this.sensitivity), this.skipRepeats)
      .filter((t) => !manual.some((m) => Math.abs(m.time - t) < SAME_TIME))
      .map((time) => ({ time, auto: true }));
    this.markers = this.#sorted([...manual, ...found]);
  }

  // ---------- the hidden sampler ----------

  /** Runs jobs on the hidden player one at a time. */
  #useSampler<T>(job: (v: HTMLVideoElement) => Promise<T>): Promise<T> {
    const run = this.#samplerQueue.then(async () => job(await this.#samplerReady()));
    this.#samplerQueue = run.catch(() => undefined);
    return run;
  }

  async #samplerReady(): Promise<HTMLVideoElement> {
    if (this.#sampler && this.#sampler.readyState >= 1) return this.#sampler;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = this.#url ?? '';
    await new Promise<void>((resolve, reject) => {
      v.addEventListener('loadeddata', () => resolve(), { once: true });
      v.addEventListener('error', () => reject(new Error('cannot read this video')), { once: true });
    });
    this.#sampler = v;
    return v;
  }

  /** Samples the whole video into small brightness grids (once; the dial re-uses them). */
  async #detect(): Promise<void> {
    if (this.#samples) {
      this.#applyDetection();
      return;
    }
    this.#cancel = false;
    this.progress = { label: 'Scanning video…', value: 0 };
    try {
      const samples = await this.#useSampler(async (v) => {
        const dur = v.duration || this.duration;
        const step = Math.max(0.2, dur / 1500);
        const w = SAMPLE_WIDTH;
        const h = Math.max(CELL, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth) / CELL) * CELL);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const cw = w / CELL;
        const ch = h / CELL;
        const out: Sample[] = [];
        for (let t = 0; t <= dur; t += step) {
          if (this.#cancel) return null;
          await seekTo(v, Math.min(t, Math.max(0, dur - 0.001)));
          ctx.drawImage(v, 0, 0, w, h);
          const px = ctx.getImageData(0, 0, w, h).data;
          const cells = new Uint8Array(cw * ch);
          for (let cy = 0; cy < ch; cy++) {
            for (let cx = 0; cx < cw; cx++) {
              let sum = 0;
              for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
                for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
                  const i = (y * w + x) * 4;
                  sum += px[i]! * 0.299 + px[i + 1]! * 0.587 + px[i + 2]! * 0.114;
                }
              }
              cells[cy * cw + cx] = sum / (CELL * CELL);
            }
          }
          out.push({ time: v.currentTime, cells });
          this.progress = { label: 'Scanning video…', value: Math.min(1, t / dur) };
        }
        return out;
      });
      if (samples) {
        this.#samples = samples;
        this.#applyDetection();
      }
    } catch (err) {
      this.error = `Change detection failed: ${(err as Error).message}`;
    } finally {
      this.progress = null;
    }
  }

  /** The frame at `t`, drawn at `maxWidth` (or full size). */
  #capture(t: number, maxWidth = Infinity, type = 'image/png'): Promise<Blob> {
    return this.#useSampler(async (v) => {
      await seekTo(v, t);
      const scale = Math.min(1, maxWidth / v.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
      canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height);
      return toBlob(canvas, type, 0.8);
    });
  }

  /** Previews for the review grid, made one by one in the background. */
  async #loadThumbs(): Promise<void> {
    for (const m of this.markers) {
      if (!this.reviewing) return;
      if (this.#thumbs.has(m.time)) continue;
      try {
        const blob = await this.#capture(m.time, 360, 'image/jpeg');
        this.#thumbs.set(m.time, URL.createObjectURL(blob));
        this.requestUpdate();
      } catch {
        return;
      }
    }
  }

  // ---------- adding frames ----------

  #emit(frames: FrameEventDetail['frames']): void {
    this.dispatchEvent(new CustomEvent<FrameEventDetail>('frames', { detail: { frames }, bubbles: true, composed: true }));
  }

  async #addCurrent(): Promise<void> {
    const v = this.#video.value;
    if (!v?.videoWidth || this.progress) return;
    v.pause();
    try {
      this.#emit([{ blob: await this.#capture(v.currentTime), time: v.currentTime }]);
    } catch (err) {
      this.error = `Could not capture this frame: ${(err as Error).message}`;
    }
  }

  async #addMarked(): Promise<void> {
    const list = this.#sorted(this.markers);
    if (!list.length || this.progress) return;
    this.#cancel = false;
    const frames: FrameEventDetail['frames'] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        if (this.#cancel) return;
        this.progress = { label: `Capturing ${i + 1} of ${list.length}…`, value: i / list.length };
        frames.push({ blob: await this.#capture(list[i]!.time), time: list[i]!.time });
      }
      this.#emit(frames);
      this.markers = [];
      this.reviewing = false;
    } catch (err) {
      this.error = `Could not capture the frames: ${(err as Error).message}`;
    } finally {
      this.progress = null;
    }
  }

  #close(): void {
    this.#cancel = true;
    this.#video.value?.pause();
    for (const url of this.#thumbs.values()) URL.revokeObjectURL(url);
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  // ---------- rendering ----------

  #renderReview() {
    if (!this.markers.length) {
      return html`<div class="grid"><div class="muted">No marked frames. Press M on a frame, or Detect changes.</div></div>`;
    }
    return html`
      <div class="grid">
        ${this.markers.map((m) => {
          const thumb = this.#thumbs.get(m.time);
          return html`
            <div class="shot" @click=${() => this.#jumpTo(m.time)} title="Go to this frame">
              ${thumb ? html`<img src=${thumb} alt="" />` : html`<div class="ph"></div>`}
              <div class="meta">
                <span>${formatTime(m.time)}</span>
                <span class="muted">${m.auto ? 'detected' : 'marked'}</span>
              </div>
              <button
                class="x"
                title="Remove this marker"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this.#removeMarker(m);
                }}
              >
                ✕
              </button>
            </div>
          `;
        })}
      </div>
    `;
  }

  render() {
    const n = this.markers.length;
    const busy = !!this.progress;
    const pct = (thresholdFor(this.sensitivity) * 100).toFixed(thresholdFor(this.sensitivity) < 0.01 ? 1 : 0);
    const isMarked = this.markers.some((m) => Math.abs(m.time - this.time) < SAME_TIME / 2);
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
              <div class="stage">
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
                ${this.reviewing ? this.#renderReview() : ''}
              </div>
              <div class="controls">
                <button @click=${() => this.#togglePlay()} title="Play / pause (Space)">${this.playing ? '⏸' : '▶'}</button>
                <button @click=${() => this.#step(-FRAME_STEP)} title="Previous frame (←; Shift+← one second)">⏮</button>
                <div class="track">
                  ${this.duration
                    ? this.markers.map(
                        (m) => html`<span
                          class="tick ${m.auto ? 'auto' : ''}"
                          style="left:${(m.time / this.duration) * 100}%"
                          title="${formatTime(m.time)} (${m.auto ? 'detected' : 'marked'})"
                          @click=${() => this.#jumpTo(m.time)}
                        ></span>`
                      )
                    : ''}
                  <input
                    type="range"
                    min="0"
                    max=${this.duration || 0}
                    step="0.001"
                    .value=${String(this.time)}
                    @input=${(e: Event) => {
                      this.reviewing = false;
                      this.#seek(Number((e.target as HTMLInputElement).value));
                    }}
                  />
                </div>
                <button @click=${() => this.#step(FRAME_STEP)} title="Next frame (→; Shift+→ one second)">⏭</button>
                <span class="time">${formatTime(this.time)} / ${formatTime(this.duration)}</span>
                <button class=${isMarked ? 'on' : ''} ?disabled=${!this.duration} @click=${() => this.#toggleMarker()} title="Mark or unmark this frame (M)">
                  ◆ ${isMarked ? 'Marked' : 'Mark'}
                </button>
                <button ?disabled=${!this.duration || busy} @click=${() => void this.#addCurrent()} title="Add this frame as a page now (Enter)">
                  ＋ Add this frame
                </button>
              </div>
              <div class="detect">
                <button ?disabled=${!this.duration || busy} @click=${() => void this.#detect()} title="Find frames where the screen changed a lot, and mark them">
                  ✨ Detect changes
                </button>
                <label class="sens" title="How much of the screen must change for a new frame: low ignores small changes (cursor, typing), high catches them">
                  Sensitivity
                  <span class="muted">low</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    .value=${String(this.sensitivity)}
                    @input=${(e: Event) => {
                      this.sensitivity = Number((e.target as HTMLInputElement).value);
                      this.#applyDetection();
                    }}
                  />
                  <span class="muted">high</span>
                  <span class="muted">(≥ ${pct}% of the screen)</span>
                </label>
                <label class="sens" title="Don't mark a screen again when the video switches back to one already marked">
                  <input
                    type="checkbox"
                    .checked=${this.skipRepeats}
                    @change=${(e: Event) => {
                      this.skipRepeats = (e.target as HTMLInputElement).checked;
                      this.#applyDetection();
                    }}
                  />
                  Skip repeats
                </label>
                ${busy
                  ? html`<span>${this.progress!.label}</span><progress .value=${this.progress!.value}></progress>
                      <button @click=${() => (this.#cancel = true)}>Cancel</button>`
                  : ''}
                <span class="spacer"></span>
                <button
                  class=${this.reviewing ? 'on' : ''}
                  ?disabled=${!n && !this.reviewing}
                  @click=${() => {
                    this.reviewing = !this.reviewing;
                    if (this.reviewing) {
                      this.#video.value?.pause();
                      void this.#loadThumbs();
                    }
                  }}
                  title="Show only the marked frames, to check them before adding"
                >
                  ▦ Review marked (${n})
                </button>
                <button ?disabled=${!n || busy} @click=${() => (this.markers = [])} title="Remove all markers">Clear</button>
                <button class="primary" ?disabled=${!n || busy} @click=${() => void this.#addMarked()} title="Add every marked frame as a page, in time order (Shift+Enter)">
                  ＋ Add ${n} marked as pages
                </button>
              </div>
              ${this.error ? html`<div class="detect error">${this.error}</div>` : ''}
            `}
      </div>
    `;
  }
}

customElements.define('screen-marker-video', VideoFrames);
