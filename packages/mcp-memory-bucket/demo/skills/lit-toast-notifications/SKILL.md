---
name: lit-toast-notifications
description: >-
  Build a toast/notification stack in a Lit web-components frontend — a
  top-center queue of auto-dismissing messages
  (success/danger/warning/info/default), capped at a few visible at once, called
  from anywhere via a module-level `toast.success(...)`/`toast.danger(...)` API
  rather than prop-drilling a callback. Ported from htmlpaint.com's Toast.svelte
  + notifications.js store pattern onto avosignals (Signal + SignalWatcher)
  instead of a Svelte store. Use whenever adding a "copied!"/"saved!"/"failed
  to..." confirmation toast, or any other transient status message, to a
  Lit-based frontend.
tags:
  - lit
  - toast
  - notification
  - avosignals
  - frontend
  - web-components
trigger_phrases:
  - toast
  - notification
  - toast notification
  - copied to clipboard message
  - success message
  - snackbar
metadata:
  owner: personal
  status: unreviewed
  extends: null
  group: anatoli
created_at: '2026-09-06T22:28:21.064Z'
body: >-
  ## Toast/notification stack in Lit


  A **module-level queue** (a `Signal<Toast[]>`) plus **one stack component**
  mounted once near the app root. Any other component calls a plain exported
  function to push a toast — no prop-drilling a callback down through the tree,
  no per-component toast state.


  Reference implementation: `packages/mcp-memory-bucket/src/client/toast.ts`
  (built for the Quick Prompts feature's "copied to clipboard" confirmation).
  Ported from htmlpaint.com's `src/notification/Toast.svelte` +
  `notifications.js`, which used a Svelte store — this version uses
  `avosignals`' `Signal`/`SignalWatcher` instead, matching how every other
  stateful component in that codebase already works (see
  `add-folder-modal.ts`/`folder-view.ts` for the same shape).


  ### Shape


  ```ts

  export type ToastType = 'default' | 'success' | 'danger' | 'warning' | 'info';


  const queue = new Signal<Toast[]>([]);


  function send(message: string, type: ToastType = 'default', timeoutMs = 2200)
  {
    const id = Math.random().toString(36).slice(2, 11);
    const next = [...queue.value, { id, type, message, timeout: timeoutMs }];
    queue.set(next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next);
    setTimeout(() => queue.set(queue.value.filter((t) => t.id !== id)), timeoutMs);
  }


  export const toast = {
    send,
    success: (m: string, t?: number) => send(m, 'success', t),
    danger: (m: string, t?: number) => send(m, 'danger', t),
    // ...warning, info, default
  };

  ```


  Call it from anywhere with zero setup: `toast.success('Copied!')`,
  `toast.danger('Failed to save')`.


  ### The stack component


  ```ts

  export class ToastStack extends LitElement {
    constructor() { super(); new SignalWatcher(this); }
    render() {
      return html`${queue.value.map((t) => html`<div class="toast">${t.message}</div>`)}`;
    }
  }

  customElements.define('toast-stack', ToastStack);

  ```


  Mount **exactly one** `<toast-stack>`, anywhere in the app shell's `render()`
  (e.g. as the last line, a sibling of everything else — it's `position: fixed`,
  so placement in the tree doesn't matter, only that it exists once). Because
  the queue is module-level, a toast pushed from a modal that immediately closes
  itself still renders and outlives that modal — the toast has no parent/child
  relationship with whatever triggered it.


  ### Design details worth keeping


  - **Cap visible count** (`MAX_VISIBLE`, e.g. 3) by dropping the *oldest*
  excess entries on push, not by refusing new ones — a burst of actions still
  all queue up, the stack just never shows more than a few at once. The
  reference used `result.shift()`; this port uses `slice(next.length -
  MAX_VISIBLE)` for the same effect without mutating.

  - **Auto-dismiss via `setTimeout` keyed to each toast's own id**
  (`queue.set(queue.value.filter(t => t.id !== id))`), not a single shared timer
  — independent toasts with independent lifetimes, no coordination needed
  between them.

  - **Type → color mapping** via a `Record<ToastType, string>` pointing at
  existing theme CSS custom properties (`--danger`, `--success`, `--accent` for
  info, etc.) rather than hardcoded colors — this is what makes it theme-aware
  for free in a codebase that already does light/dark via `light-dark()` CSS. If
  the project has no `--success`/`--warning` vars yet, add them to wherever
  `:root`'s var block lives (e.g. `public/index.html`'s `<style>`) using the
  same `light-dark(lightHex, darkHex)` pattern as the existing vars — don't
  invent a separate theming mechanism for just the toast.

  - **`position: fixed; top: ...; z-index: 9999`** on the host, stacked with
  `display:flex; flex-direction:column; align-items:center; gap:8px` —
  top-center is the reference's placement and reads as "system notification,"
  not "form validation error" (which usually anchors near the field instead).

  - Keep the on-screen message short (a few words: "Copied to clipboard",
  "Failed to save") — a toast is a glance-and-gone confirmation, not a place for
  detail or a call to action.


  ### What NOT to build


  - Don't add click-to-dismiss, action buttons, or a pause-on-hover unless asked
  — the reference is deliberately just "shows up, auto-disappears," and that's
  sufficient for a confirmation toast. Add richness only when a specific need
  shows up.

  - Don't wire toasts through a component prop/event system if the project
  already has a lighter shared-state primitive (a signals library, a store) —
  the whole point of the module-level-queue approach is that callers need zero
  setup beyond an import.
---
## Toast/notification stack in Lit

**One stack component** mounted once near the app root, listening for a `window`-level **CustomEvent**. Any other element, anywhere in the tree — including ones that never import the toast module — triggers a toast just by dispatching that event. A small `toast.success(...)`/`toast.danger(...)` helper object is sugar over the same dispatch, for the common case of already being in a `.ts` file that can import it.

Reference implementation: `packages/mcp-memory-bucket/src/client/toast.ts` (built for the Quick Prompts feature's "copied to clipboard" confirmation). Ported from htmlpaint.com's `src/notification/Toast.svelte` + `notifications.js` (which queued into a Svelte store) — this version keeps per-toast state in an `avosignals` `Signal` local to the stack component, matching how other stateful components in that codebase work (see `add-folder-modal.ts`/`folder-view.ts`), but picked a **DOM CustomEvent** over a shared-module Signal/store for the cross-component transport itself, since a real event bubbles across shadow-DOM boundaries and needs no import coupling between the trigger and the stack.

### Why an event, not a shared module import

A module-level store (`import { toast } from './toast.js'`) works, but only for code that can import that exact file — awkward across package boundaries, dynamically-loaded widgets, or anything that shouldn't take a direct dependency on the toast implementation. A `window.dispatchEvent(new CustomEvent(...))` has no such coupling: literally anything with a reference to `window` can trigger one. Use the event as the actual contract; treat any `toast.*` helper as optional convenience wrapping it.

### Shape

```ts
export const TOAST_EVENT = 'mem-bucket-toast';
export interface ToastEventDetail { message: string; type?: ToastType; timeoutMs?: number; }

function dispatch(message: string, type: ToastType = 'default', timeoutMs = 2200) {
  window.dispatchEvent(new CustomEvent<ToastEventDetail>(TOAST_EVENT, {
    detail: { message, type, timeoutMs }, bubbles: true, composed: true,
  }));
}

export const toast = {
  send: dispatch,
  success: (m: string, t?: number) => dispatch(m, 'success', t),
  danger: (m: string, t?: number) => dispatch(m, 'danger', t),
  // ...warning, info, default
};
```

Two equivalent ways to trigger one:

```ts
toast.success('Copied!');                                    // convenience helper
window.dispatchEvent(new CustomEvent('mem-bucket-toast', {    // raw event, no import needed
  detail: { message: 'Copied!', type: 'success' }, bubbles: true, composed: true,
}));
```

`bubbles: true, composed: true` matter — `composed` is what lets the event escape a shadow root (every Lit component's `renderRoot` is one) and still reach a `window`-level listener.

### The stack component

```ts
export class ToastStack extends LitElement {
  #queue = new Signal<Toast[]>([]);
  #onEvent = (e: Event) => { /* push (e as CustomEvent<ToastEventDetail>).detail into #queue, auto-remove after timeoutMs */ };

  connectedCallback() { super.connectedCallback(); window.addEventListener(TOAST_EVENT, this.#onEvent); }
  disconnectedCallback() { super.disconnectedCallback(); window.removeEventListener(TOAST_EVENT, this.#onEvent); }

  render() { return html`${this.#queue.value.map((t) => html`<div class="toast">${t.message}</div>`)}`; }
}
customElements.define('toast-stack', ToastStack);
```

Mount **exactly one** `<toast-stack>`, anywhere in the app shell's `render()` (it's `position: fixed`, so tree placement doesn't matter, only that it exists once and is connected to receive the `window` event). Because the trigger is an event dispatch, a toast fired from a modal that immediately closes itself still renders and outlives that modal — there's no parent/child lifecycle tying them together.

### Design details worth keeping

- **Cap visible count** (`MAX_VISIBLE`, e.g. 3) by dropping the *oldest* excess entries on push, not by refusing new ones — a burst of actions still all queue up, the stack just never shows more than a few at once.
- **Auto-dismiss via `setTimeout` keyed to each toast's own id**, not a single shared timer — independent toasts with independent lifetimes.
- **Type → color mapping** via a `Record<ToastType, string>` pointing at existing theme CSS custom properties (`--danger`, `--success`, `--accent` for info, etc.) rather than hardcoded colors — this is what makes it theme-aware for free in a codebase that already does light/dark via `light-dark()` CSS. If the project has no `--success`/`--warning` vars yet, add them to wherever `:root`'s var block lives (e.g. `public/index.html`'s `<style>`) using the same `light-dark(lightHex, darkHex)` pattern as the existing vars.
- **`position: fixed; top: ...; z-index: 9999`** on the host, stacked with `display:flex; flex-direction:column; align-items:center; gap:8px` — top-center reads as "system notification," not "form validation error" (which usually anchors near the field instead).
- Keep the on-screen message short (a few words: "Copied to clipboard", "Failed to save") — a toast is a glance-and-gone confirmation, not a place for detail or a call to action.

### Where to add toasts in an existing app

Good candidates: any `fetch()` that mutates server state (POST/PATCH/DELETE) where success currently just updates local state with no visible confirmation, or a `catch` block that only sets a small inline error `Signal` that's easy to miss. Bad candidates: an action that already has a clear, sufficient inline confirmation (e.g. a button that visibly changes its own label to "Saved").

### What NOT to build

- Don't add click-to-dismiss, action buttons, or a pause-on-hover unless asked — the reference is deliberately just "shows up, auto-disappears," and that's sufficient for a confirmation toast. Add richness only when a specific need shows up.
- Don't wire toasts through a component prop/event system that requires the CALLER to be told about a specific target element — the whole point of a `window`-level event is that callers need zero reference to the stack, just the event name/shape.

