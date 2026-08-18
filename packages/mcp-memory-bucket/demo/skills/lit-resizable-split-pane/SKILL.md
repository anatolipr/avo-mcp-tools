---
name: lit-resizable-split-pane
description: >-
  Builds a draggable splitter between two side-by-side panes in Lit (e.g. a list
  and a detail/preview panel) using pointer events on a thin divider element,
  with the split position stored in a Signal, clamped to a min/max percentage,
  and persisted to localStorage. Use whenever the user asks for a resizable
  layout, a draggable divider/splitter between two panels, or to make a
  list/preview or sidebar/content split adjustable.
tags:
  - lit
  - resizable
  - splitter
  - split-pane
  - drag
  - frontend
  - web-components
  - avosignals
trigger_phrases:
  - resizable panes
  - draggable splitter
  - split pane
  - resize list and preview
  - adjustable divider
metadata:
  owner: personal
  status: stable
  extends: null
body: >-
  ## Resizable split pane in Lit


  A two-pane layout (e.g. a results list and a detail/preview panel) where

  the user can drag a thin divider to resize either side. No library —

  just pointer events on a `div`, driven by a percentage stored in a

  `Signal` ([[lit-avosignals-mcp-page]]).


  ### Shape


  ```

  .body-region (flex row, fixed height)

  ├── left-pane   — width: ${splitPct}%

  ├── .splitter   — 6px wide, cursor: col-resize, flex: 0 0 auto

  └── right-pane  — flex: 1 1 auto, min-width: 0

  ```


  The **left pane** gets an explicit percentage width; the **right pane**

  gets `flex: 1 1 auto` so it absorbs whatever's left. Give the right pane

  `min-width: 0` — without it, a flex item's default `min-width: auto` can

  refuse to shrink below its content's natural width (e.g. a long

  unbreakable line), which silently defeats the drag past a certain point.


  ### State: one Signal, clamped, persisted


  ```ts

  const SPLIT_STORAGE_KEY = 'my-app-split-pct';

  const SPLIT_MIN_PCT = 20;

  const SPLIT_MAX_PCT = 80;


  function loadSplitPct(): number {
    const raw = Number(localStorage.getItem(SPLIT_STORAGE_KEY));
    return Number.isFinite(raw) && raw >= SPLIT_MIN_PCT && raw <= SPLIT_MAX_PCT ? raw : 40;
  }


  #splitPct = new Signal<number>(loadSplitPct());

  #dragging = new Signal<boolean>(false); // drives a hover/active style on the
  divider

  ```


  Clamp on every drag update, not just at load — an unclamped drag lets the

  user shrink a pane to zero width or push it past the container edge.


  ### Drag handlers: pointerdown on the divider, pointermove/up on `document`


  Binding `pointermove`/`pointerup` to `document` (not the divider itself)

  is what lets the drag continue tracking even when the pointer moves

  faster than the divider is wide, or leaves the divider's bounds entirely

  mid-drag — the divider is only 6px wide, so a `mousemove` bound to it

  alone would drop events constantly.


  ```ts

  #boundOnDragMove = (e: PointerEvent) => this.#onDragMove(e);

  #boundOnDragEnd = () => this.#onDragEnd();


  #onDragStart(e: PointerEvent) {
    e.preventDefault(); // stops text selection while dragging
    this.#dragging.set(true);
    document.addEventListener('pointermove', this.#boundOnDragMove);
    document.addEventListener('pointerup', this.#boundOnDragEnd);
  }


  #onDragMove(e: PointerEvent) {
    const region = this.renderRoot.querySelector('.body-region') as HTMLElement | null;
    if (!region) return;
    const rect = region.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    this.#splitPct.set(Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, pct)));
  }


  #onDragEnd() {
    this.#dragging.set(false);
    document.removeEventListener('pointermove', this.#boundOnDragMove);
    document.removeEventListener('pointerup', this.#boundOnDragEnd);
    localStorage.setItem(SPLIT_STORAGE_KEY, String(this.#splitPct.value));
  }

  ```


  Store handler references as bound class fields (`#boundOnDragMove`), not

  inline arrow functions passed straight to `addEventListener` — an inline

  arrow can't be `removeEventListener`'d later since each one is a distinct

  function reference, which leaks a listener on every drag.


  Only write to `localStorage` in `#onDragEnd`, not on every `pointermove`

  — writing on every move is needless I/O for a value that only matters

  once the user stops dragging.


  ### Template


  ```ts

  static styles = css`
    .body-region { display: flex; height: calc(100vh - 130px); }
    left-pane-el { overflow-y: auto; flex: 0 0 auto; }
    right-pane-el { overflow-y: auto; flex: 1 1 auto; min-width: 0; }
    .splitter {
      flex: 0 0 auto;
      width: 6px;
      cursor: col-resize;
      background: #8882;
      position: relative;
    }
    .splitter:hover, .splitter.dragging { background: #2563eb55; }
    .splitter::after {
      /* widen the hit area past the visible 6px without widening the divider itself */
      content: '';
      position: absolute;
      top: 0; bottom: 0;
      left: -3px; right: -3px;
    }
  `;


  render() {
    return html`
      <div class="body-region">
        <left-pane-el style=${`width: ${this.#splitPct.value}%; border-right: 1px solid #8883;`}></left-pane-el>
        <div
          class="splitter ${this.#dragging.value ? 'dragging' : ''}"
          @pointerdown=${(e: PointerEvent) => this.#onDragStart(e)}
        ></div>
        <right-pane-el></right-pane-el>
      </div>
    `;
  }

  ```


  The `::after` pseudo-element widens the *hit area* (via `left: -3px;

  right: -3px`) without widening the *visible* divider — a 6px-only

  hit target is hard to grab precisely.


  ## Checklist


  - [ ] Left pane's width is a percentage driven by the signal; right pane
        is `flex: 1 1 auto; min-width: 0` to absorb the remainder.
  - [ ] Drag position is clamped (e.g. 20–80%) on every `pointermove`, not
        just at initial load.
  - [ ] `pointermove`/`pointerup` listeners are bound to `document`, not
        the divider element itself.
  - [ ] Handler references are bound class fields so they can be
        `removeEventListener`'d in `#onDragEnd` — no inline arrows passed
        directly to `addEventListener`.
  - [ ] `e.preventDefault()` in the `pointerdown` handler to stop text
        selection while dragging.
  - [ ] Persisted value (if any) is written once in `#onDragEnd`, not on
        every `pointermove`.
owner: personal
---
## Resizable split pane in Lit

A two-pane layout (e.g. a results list and a detail/preview panel) where
the user can drag a thin divider to resize either side. No library —
just pointer events on a `div`, driven by a percentage stored in a
`Signal` ([[lit-avosignals-mcp-page]]).

### Shape

```
.body-region (flex row, fixed height)
├── left-pane   — width: ${splitPct}%
├── .splitter   — 6px wide, cursor: col-resize, flex: 0 0 auto
└── right-pane  — flex: 1 1 auto, min-width: 0
```

The **left pane** gets an explicit percentage width; the **right pane**
gets `flex: 1 1 auto` so it absorbs whatever's left. Give the right pane
`min-width: 0` — without it, a flex item's default `min-width: auto` can
refuse to shrink below its content's natural width (e.g. a long
unbreakable line), which silently defeats the drag past a certain point.

### State: one Signal, clamped, persisted

```ts
const SPLIT_STORAGE_KEY = 'my-app-split-pct';
const SPLIT_MIN_PCT = 20;
const SPLIT_MAX_PCT = 80;

function loadSplitPct(): number {
  const raw = Number(localStorage.getItem(SPLIT_STORAGE_KEY));
  return Number.isFinite(raw) && raw >= SPLIT_MIN_PCT && raw <= SPLIT_MAX_PCT ? raw : 40;
}

#splitPct = new Signal<number>(loadSplitPct());
#dragging = new Signal<boolean>(false); // drives a hover/active style on the divider
```

Clamp on every drag update, not just at load — an unclamped drag lets the
user shrink a pane to zero width or push it past the container edge.

### Drag handlers: pointerdown on the divider, pointermove/up on `document`

Binding `pointermove`/`pointerup` to `document` (not the divider itself)
is what lets the drag continue tracking even when the pointer moves
faster than the divider is wide, or leaves the divider's bounds entirely
mid-drag — the divider is only 6px wide, so a `mousemove` bound to it
alone would drop events constantly.

```ts
#boundOnDragMove = (e: PointerEvent) => this.#onDragMove(e);
#boundOnDragEnd = () => this.#onDragEnd();

#onDragStart(e: PointerEvent) {
  e.preventDefault(); // stops text selection while dragging
  this.#dragging.set(true);
  document.addEventListener('pointermove', this.#boundOnDragMove);
  document.addEventListener('pointerup', this.#boundOnDragEnd);
}

#onDragMove(e: PointerEvent) {
  const region = this.renderRoot.querySelector('.body-region') as HTMLElement | null;
  if (!region) return;
  const rect = region.getBoundingClientRect();
  const pct = ((e.clientX - rect.left) / rect.width) * 100;
  this.#splitPct.set(Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, pct)));
}

#onDragEnd() {
  this.#dragging.set(false);
  document.removeEventListener('pointermove', this.#boundOnDragMove);
  document.removeEventListener('pointerup', this.#boundOnDragEnd);
  localStorage.setItem(SPLIT_STORAGE_KEY, String(this.#splitPct.value));
}
```

Store handler references as bound class fields (`#boundOnDragMove`), not
inline arrow functions passed straight to `addEventListener` — an inline
arrow can't be `removeEventListener`'d later since each one is a distinct
function reference, which leaks a listener on every drag.

Only write to `localStorage` in `#onDragEnd`, not on every `pointermove`
— writing on every move is needless I/O for a value that only matters
once the user stops dragging.

### Template

```ts
static styles = css`
  .body-region { display: flex; height: calc(100vh - 130px); }
  left-pane-el { overflow-y: auto; flex: 0 0 auto; }
  right-pane-el { overflow-y: auto; flex: 1 1 auto; min-width: 0; }
  .splitter {
    flex: 0 0 auto;
    width: 6px;
    cursor: col-resize;
    background: #8882;
    position: relative;
  }
  .splitter:hover, .splitter.dragging { background: #2563eb55; }
  .splitter::after {
    /* widen the hit area past the visible 6px without widening the divider itself */
    content: '';
    position: absolute;
    top: 0; bottom: 0;
    left: -3px; right: -3px;
  }
`;

render() {
  return html`
    <div class="body-region">
      <left-pane-el style=${`width: ${this.#splitPct.value}%; border-right: 1px solid #8883;`}></left-pane-el>
      <div
        class="splitter ${this.#dragging.value ? 'dragging' : ''}"
        @pointerdown=${(e: PointerEvent) => this.#onDragStart(e)}
      ></div>
      <right-pane-el></right-pane-el>
    </div>
  `;
}
```

The `::after` pseudo-element widens the *hit area* (via `left: -3px;
right: -3px`) without widening the *visible* divider — a 6px-only
hit target is hard to grab precisely.

## Checklist

- [ ] Left pane's width is a percentage driven by the signal; right pane
      is `flex: 1 1 auto; min-width: 0` to absorb the remainder.
- [ ] Drag position is clamped (e.g. 20–80%) on every `pointermove`, not
      just at initial load.
- [ ] `pointermove`/`pointerup` listeners are bound to `document`, not
      the divider element itself.
- [ ] Handler references are bound class fields so they can be
      `removeEventListener`'d in `#onDragEnd` — no inline arrows passed
      directly to `addEventListener`.
- [ ] `e.preventDefault()` in the `pointerdown` handler to stop text
      selection while dragging.
- [ ] Persisted value (if any) is written once in `#onDragEnd`, not on
      every `pointermove`.
