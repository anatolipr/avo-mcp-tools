import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';

/**
 * Generic toast/notification system, ported from mcp-memory-bucket's
 * src/client/toast.ts (itself ported from htmlpaint.com's Toast.svelte +
 * notifications.js — a top-center stack, capped at a few visible,
 * auto-dismissing on a timer, themed by type) — see the
 * lit-toast-notifications skill in mcp-memory-bucket/demo/skills/ for the
 * general porting pattern if porting elsewhere again. Transport is a
 * `window`-level CustomEvent (`js-bridge-mcp-toast`), not a shared module
 * import — dispatching a real DOM event (bubbles + composed, so it crosses
 * shadow-DOM boundaries) means ANY element, anywhere in the tree, including
 * ones that never import this file, can trigger a toast just by dispatching
 * the event shape below. `toast.success(...)` etc. are sugar over exactly
 * that dispatch, for the common case of already being in a .ts file that
 * can import this module — both call paths are equivalent, pick whichever
 * is more convenient.
 * Mount ONE <toast-stack> near the app root (see dashboard-app.ts); it's the only listener.
 */

export type ToastType = 'default' | 'success' | 'danger' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  timeout: number;
  sticky: boolean;
}

export const TOAST_EVENT = 'js-bridge-mcp-toast';

/** The `detail` shape of a `js-bridge-mcp-toast` CustomEvent — `type`/`timeoutMs` are optional so a
 * caller dispatching the raw event (rather than using the `toast.*` helpers) can omit either.
 * `sticky: true` skips the auto-dismiss timer entirely and shows a close (✕) button instead — for
 * things a human should actively acknowledge (e.g. a dynamic tool registration log entry) rather
 * than a fire-and-forget confirmation. */
export interface ToastEventDetail {
  message: string;
  type?: ToastType;
  timeoutMs?: number;
  sticky?: boolean;
}

const MAX_VISIBLE = 3;
const DEFAULT_TIMEOUT_MS = 2200;

function dispatch(message: string, type: ToastType = 'default', timeoutMs: number = DEFAULT_TIMEOUT_MS, sticky = false): void {
  window.dispatchEvent(
    new CustomEvent<ToastEventDetail>(TOAST_EVENT, { detail: { message, type, timeoutMs, sticky }, bubbles: true, composed: true })
  );
}

/** Call from anywhere: `toast.success('Copied!')`, `toast.danger('Failed to save')`, etc. —
 * equivalent to dispatching a `js-bridge-mcp-toast` CustomEvent by hand (see TOAST_EVENT). */
export const toast = {
  send: dispatch,
  default: (message: string, timeoutMs?: number) => dispatch(message, 'default', timeoutMs),
  success: (message: string, timeoutMs?: number) => dispatch(message, 'success', timeoutMs),
  danger: (message: string, timeoutMs?: number) => dispatch(message, 'danger', timeoutMs),
  warning: (message: string, timeoutMs?: number) => dispatch(message, 'warning', timeoutMs),
  info: (message: string, timeoutMs?: number) => dispatch(message, 'info', timeoutMs),
  /** Sticky variant: stays until the human clicks its close button. No timeoutMs — it never auto-dismisses. */
  sticky: (message: string, type: ToastType = 'info') => dispatch(message, type, 0, true),
};

const TYPE_COLOR_VAR: Record<ToastType, string> = {
  default: '--fg',
  success: '--success',
  danger: '--danger',
  warning: '--warning',
  info: '--accent',
};

/** Mount exactly one of these (e.g. in dashboard-app.ts's render()) — it listens for
 * `js-bridge-mcp-toast` on `window` regardless of where in the tree it's placed. */
export class ToastStack extends LitElement {
  #queue = new Signal<Toast[]>([]);
  #boundOnToastEvent = (e: Event) => this.#onToastEvent(e as CustomEvent<ToastEventDetail>);

  constructor() {
    super();
    new SignalWatcher(this);
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(TOAST_EVENT, this.#boundOnToastEvent);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(TOAST_EVENT, this.#boundOnToastEvent);
  }

  #onToastEvent(e: CustomEvent<ToastEventDetail>) {
    const { message, type = 'default', timeoutMs = DEFAULT_TIMEOUT_MS, sticky = false } = e.detail;
    const id = Math.random().toString(36).slice(2, 11);
    const next = [...this.#queue.value, { id, type, message, timeout: timeoutMs, sticky }];
    // Drop the OLDEST excess entries rather than refusing new ones — a burst of toasts still all
    // queue up, but the stack only ever shows the most recent MAX_VISIBLE at once (matches the
    // reference's `result.shift()` behavior). Sticky toasts count against this cap too, so a burst
    // of registrations doesn't grow the stack unboundedly — the dashboard's own recentToolRegistrations
    // log (not this stack) is the durable record; the stack is just the "just now" pulse.
    this.#queue.set(next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next);
    if (!sticky) {
      setTimeout(() => this.#dismiss(id), timeoutMs);
    }
  }

  #dismiss(id: string) {
    this.#queue.set(this.#queue.value.filter((t) => t.id !== id));
  }

  static styles = css`
    :host {
      position: fixed;
      top: 14px;
      left: 0;
      right: 0;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      pointer-events: none;
    }
    .toast {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 16px;
      border-radius: 8px;
      background: var(--bg);
      color: inherit;
      border: 1px solid var(--border-strong);
      box-shadow: 0 4px 20px var(--shadow);
      font-size: 13px;
      max-width: min(420px, 90vw);
      animation: toast-in 180ms ease-out;
      pointer-events: auto;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
    .msg { flex: 1 1 auto; min-width: 0; }
    .close-btn {
      flex: 0 0 auto; border: none; background: none; color: inherit; opacity: 0.6;
      cursor: pointer; font-size: 13px; line-height: 1; padding: 2px;
    }
    .close-btn:hover { opacity: 1; }
    @keyframes toast-in {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;

  render() {
    return html`
      ${this.#queue.value.map(
        (t) => html`
          <div class="toast">
            <span class="dot" style=${`background: var(${TYPE_COLOR_VAR[t.type]})`}></span>
            <span class="msg">${t.message}</span>
            ${t.sticky ? html`<button class="close-btn" title="Dismiss" @click=${() => this.#dismiss(t.id)}>✕</button>` : ''}
          </div>
        `
      )}
    `;
  }
}

customElements.define('toast-stack', ToastStack);
