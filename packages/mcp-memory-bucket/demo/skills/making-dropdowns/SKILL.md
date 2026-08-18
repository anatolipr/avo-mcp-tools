---
name: making-dropdowns
description: >-
  Build a dropdown/popover/menu in this project's Lit web components using the
  native Popover API + CSS anchor positioning (confirmed working in Chrome,
  Firefox, and Safari as of 2026) — no Floating UI, no manual
  getBoundingClientRect() flip logic, no z-index fights. Use whenever adding a
  new dropdown, context menu, tooltip-with-content, or "small floating panel
  anchored to a button" in any folderfoo Lit element.
tags:
  - lit
  - dropdown
  - popover
  - css-anchor-positioning
  - frontend
  - web-components
trigger_phrases:
  - dropdown
  - popover
  - context menu
  - floating panel
  - select component
  - combobox
metadata:
  owner: personal
  status: stable
  extends: null
body: >-
  # Making dropdowns


  This project's dropdowns are built on two native browser features, not a

  library:


  - **[Popover
  API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API)**
    — promotes an element to the **top layer**, a paint layer above the entire
    document. An element there cannot be clipped by an ancestor's
    `overflow: hidden/auto`, and doesn't need `z-index` to stack above
    anything. Also gives you free light-dismiss (outside click closes it) and
    Escape-to-close.
  - **[CSS anchor
  positioning](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_anchor_positioning)**
    — lets the popover position itself relative to its trigger button in pure
    CSS (`anchor-name` / `position-anchor` / `anchor()`), with automatic
    flip-to-fit via `position-try-fallbacks`. No `getBoundingClientRect()`
    measuring, no manual flip-attribute toggling.

  Together these replace what Floating UI / Popper / Tippy used to be needed

  for. Both ship unprefixed in Chrome and Firefox as of 2026, and this

  project's implementation has also been manually confirmed working in

  Safari.


  Two real implementations already exist in this repo — read them before

  writing a new one:


  - `public/elements/folderfoo-tag-filter.js`
    — the **simple case**: anchor button and popover live in the same
    component's own shadow root.
  - `public/elements/folderfoo-tag-picker.js`
    paired with
    `public/elements/folderfoo-file-open.js`
    — the **cross-component case**: the anchor button lives in a *different*
    component's shadow root than the popover. This is the case that has a
    sharp edge (see below) and is worth reading even if your dropdown looks
    like the simple case at first glance.

  For the full worked example, the exact code, and the Chromium bug this

  project hit and worked around, see

  [reference.md](reference.md).


  ## Decision: which shape is your dropdown?


  <check>

  Is the button that opens the dropdown, and the dropdown's content, rendered

  by the SAME Lit element (same shadow root)?

  </check>


  - **Yes** → single-component pattern. Anchor and popover are both plain
    elements in one `render()`. See "Pattern A" below.
  - **No** (e.g. a list renders N buttons, each opens a popover that's a
    *separate custom element*) → cross-component pattern. The popover must be
    set on the **host element** of the child component, not an inner div —
    see "Pattern B" below and definitely read reference.md's "the anchor-name
    scoping trap" section before shipping it.

  ## Pattern A: popover + anchor inside one component


  Anchor button and popover content are both in the same `render()`. This is

  `folderfoo-tag-filter.js` in full; adapt the anchor name and content.


  ```js

  import { LitElement, html, css } from
  'https://cdn.jsdelivr.net/npm/lit@3/+esm';


  // Per-instance anchor name so multiple copies of this component on one

  // page don't fight over the same anchor - see reference.md's "why

  // per-instance names" section.

  let _instanceCounter = 0;


  class MyDropdown extends LitElement {
    static styles = css`
      .toggle { /* ...button styles... */ }

      .menu {
        /* [popover] promotes this to the top layer: renders above
           everything, no z-index, never clipped by an ancestor's
           overflow: hidden/auto. CSS anchor positioning keeps it glued to
           the toggle button through any reflow with no JS measuring, and
           position-try-fallbacks flips it upward automatically when there
           isn't room below. */
        position: fixed;
        margin: 0;
        inset: auto;
        top: anchor(bottom);
        left: anchor(left);
        position-try-fallbacks: flip-block;
        /* ...visual styles: background, border, box-shadow, padding... */
      }
      .menu:popover-open {
        margin-top: 4px; /* the gap you'd normally get from top: calc(100% + 4px) */
      }
    `;

    constructor() {
      super();
      this._anchorName = `--my-dropdown-${++_instanceCounter}`;
    }

    _toggleOpen() {
      this.renderRoot.querySelector('.menu')?.togglePopover();
    }

    render() {
      return html`
        <button
          class="toggle"
          style=${`anchor-name: ${this._anchorName}`}
          @click=${() => this._toggleOpen()}
        >Open</button>

        <div class="menu" popover style=${`position-anchor: ${this._anchorName}`}>
          <!-- dropdown content -->
        </div>
      `;
    }
  }

  ```


  Key points:


  - `popover` (bare = `popover="auto"`) gives you light-dismiss and
    single-open-at-a-time for free. Don't write your own
    `document.addEventListener('click', ...)` outside-click handler — delete
    it if you're migrating one.
  - No `z-index` anywhere. Top-layer elements paint above the whole document
    by insertion order; you don't need to out-number an ancestor's z-index.
  - `togglePopover()` / `showPopover()` / `hidePopover()` are the imperative
    API. `popovertarget="id"` on the button is the *declarative* alternative
    (skips the click handler entirely) — use it when the button doesn't need
    to do anything else on click.
  - If you need to react to it opening/closing (e.g. to sync external state),
    listen for the native `toggle` event:
    `@toggle=${(e) => e.newState === 'open' ? ... : ...}` — `e.newState` is
    `'open'` or `'closed'`.

  ## Pattern B: popover on a child component's host, anchored to a parent's
  button


  Use this when a list renders N trigger buttons and each opens a *separate

  custom element* as its popover (one instance created/destroyed per row,

  gated by a Lit conditional). This is

  `folderfoo-tag-picker.js` + `folderfoo-file-open.js`.


  **The rule that makes this different from Pattern A:** `anchor-name` /

  `position-anchor` can only resolve within the same DOM tree scope. If the

  anchor button lives in `folderfoo-file-open.js`'s shadow root, the

  positioned element must *also* be reachable in that scope — an element

  inside a *child* component's own separate shadow root cannot see it. So the

  popover has to be the child component's **host element itself** (which

  *is* a light-DOM child of the parent's shadow root), not a div inside the

  child's `render()` output.


  Parent (owns the buttons, assigns the anchor name):


  ```js

  // folderfoo-file-open.js (the list)

  static styles = css`
    .tag-btn {
      /* anchor-name set inline in the template below, only on whichever
         row's button currently has its popover open - see "the
         anchor-name scoping trap" in reference.md for why NOT to put this
         in the CSS rule (i.e. NOT: .tag-btn { anchor-name: ... }) applied
         to every row uniformly. */
    }
  `;


  render() {
    return html`
      ${this.rows.map(row => html`
        <button
          class="tag-btn"
          style=${this.openFor === row.id ? 'anchor-name: --my-row-anchor' : ''}
          @click=${() => this._toggle(row.id)}
        >⋮</button>
        ${this.openFor === row.id
          ? html`<my-row-popover .rowId=${row.id}
                   @my-row-popover-close=${() => this.openFor = null}
                 ></my-row-popover>`
          : ''}
      `)}
    `;
  }

  ```


  Child (the popover is its own host):


  ```js

  // my-row-popover.js

  class MyRowPopover extends LitElement {
    static styles = css`
      :host {
        /* The HOST is the popover. Not an inner div - see the parent
           component's comment above for why. */
        all: initial;
        position: fixed;
        margin: 0;
        inset: auto;
        top: anchor(bottom);
        right: anchor(right);
        position-try-fallbacks: flip-block;
        /* ...visual styles... */
      }
      :host(:popover-open) { margin-top: 4px; }
    `;

    constructor() {
      super();
      this.addEventListener('toggle', (e) => this._onToggle(e));
    }

    connectedCallback() {
      super.connectedCallback();
      // MUST be here, not in the constructor - see reference.md's
      // "why connectedCallback, not constructor" section. Setting an
      // attribute in a custom element constructor is illegal per spec and
      // leaves the element in a broken half-upgraded state: it will compute
      // a plausible getBoundingClientRect() and match :popover-open, but
      // never actually paint or accept focus.
      this.setAttribute('popover', 'auto');
      this.style.positionAnchor = '--my-row-anchor';
    }

    // Created fresh each time it opens (see the parent's conditional
    // template), so firstUpdated = "just opened."
    firstUpdated() {
      this.showPopover();
    }

    _onToggle(e) {
      if (e.newState === 'closed') {
        this.dispatchEvent(new CustomEvent('my-row-popover-close', { bubbles: true, composed: true }));
      }
    }

    render() {
      return html`<!-- popover content, no wrapper div needed -->`;
    }
  }

  ```


  ## The one Chromium bug you will hit if you skip this


  If every row's trigger button gets the **same** `anchor-name` (e.g. a CSS

  rule like `.tag-btn { anchor-name: --my-anchor }` applied uniformly, which

  looks harmless since only one popover is ever open at a time), Chromium

  computes a plausible box for the popover — `getBoundingClientRect()` looks

  right, `:popover-open` matches — but **never actually paints it, hit-tests

  it, or gives it focus**. It's silently invisible with every signal saying

  it's open. This only shows up once there are enough duplicate-named anchors

  in the same scope (worked fine with 1–2 rows in testing, broke at 8).


  **Fix:** assign the `anchor-name` only to the *currently open* row's

  button (inline `style`, conditional on your "which row is open" state), not

  to every row uniformly. See Pattern B's parent example above, and

  reference.md for the full bisection that found this.


  ## Checklist before shipping a new dropdown


  - [ ] No `z-index` anywhere in the new CSS — if you wrote one, you're
        probably fighting the top layer instead of using it; delete it.
  - [ ] No manual outside-click `document.addEventListener` — `popover`
        gives you light-dismiss for free.
  - [ ] No `getBoundingClientRect()` flip-detection code — `position-anchor`
        + `position-try-fallbacks: flip-block` (or `flip-inline` for
        horizontal flipping) replaces it.
  - [ ] If multiple trigger buttons can exist at once (a list), the
        `anchor-name` is scoped to only the open one, not applied uniformly.
  - [ ] If the popover is its own child custom element, `popover` /
        `positionAnchor` are set in `connectedCallback()`, never the
        constructor.
  - [ ] Tested with more than 1–2 instances of the trigger on screen at once
        (see the Chromium bug above — it doesn't show up at low counts).
  - [ ] Spot-checked in Safari and Firefox, not just Chrome — this project's
        implementation has been manually confirmed working in all three.
  - [ ] If open/closed state is synced through an avosignals `Signal`
        (shared store) rather than a local boolean, the signal is read
        somewhere inside `render()` — even a throwaway `void this._isOpen;`
        line. `SignalWatcher` only subscribes to signals read during
        `render()` (see
        [avosignals.ts](https://github.com/anatolipr/avos/blob/main/packages/avosignals/avosignals.ts)),
        so a signal only ever read from a click handler or `updated()` will
        update the store correctly but never trigger the re-render that
        actually calls `showPopover()`/`hidePopover()` — the dropdown will
        look completely inert while the underlying state is fine.
  - [ ] If the trigger button and the popover are separate elements, toggling
        open/closed doesn't just call `.togglePopover()` in the click
        handler — check for the light-dismiss double-toggle race in
        reference.md first (clicking the trigger while open can fire native
        light-dismiss *before* your handler runs, so a naive
        `togglePopover()` call ends up reopening it).
owner: personal
---
# Making dropdowns

This project's dropdowns are built on two native browser features, not a
library:

- **[Popover API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API)**
  — promotes an element to the **top layer**, a paint layer above the entire
  document. An element there cannot be clipped by an ancestor's
  `overflow: hidden/auto`, and doesn't need `z-index` to stack above
  anything. Also gives you free light-dismiss (outside click closes it) and
  Escape-to-close.
- **[CSS anchor positioning](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_anchor_positioning)**
  — lets the popover position itself relative to its trigger button in pure
  CSS (`anchor-name` / `position-anchor` / `anchor()`), with automatic
  flip-to-fit via `position-try-fallbacks`. No `getBoundingClientRect()`
  measuring, no manual flip-attribute toggling.

Together these replace what Floating UI / Popper / Tippy used to be needed
for. Both ship unprefixed in Chrome and Firefox as of 2026, and this
project's implementation has also been manually confirmed working in
Safari.

Two real implementations already exist in this repo — read them before
writing a new one:

- `public/elements/folderfoo-tag-filter.js`
  — the **simple case**: anchor button and popover live in the same
  component's own shadow root.
- `public/elements/folderfoo-tag-picker.js`
  paired with
  `public/elements/folderfoo-file-open.js`
  — the **cross-component case**: the anchor button lives in a *different*
  component's shadow root than the popover. This is the case that has a
  sharp edge (see below) and is worth reading even if your dropdown looks
  like the simple case at first glance.

For the full worked example, the exact code, and the Chromium bug this
project hit and worked around, see
[reference.md](reference.md).

## Decision: which shape is your dropdown?

<check>
Is the button that opens the dropdown, and the dropdown's content, rendered
by the SAME Lit element (same shadow root)?
</check>

- **Yes** → single-component pattern. Anchor and popover are both plain
  elements in one `render()`. See "Pattern A" below.
- **No** (e.g. a list renders N buttons, each opens a popover that's a
  *separate custom element*) → cross-component pattern. The popover must be
  set on the **host element** of the child component, not an inner div —
  see "Pattern B" below and definitely read reference.md's "the anchor-name
  scoping trap" section before shipping it.

## Pattern A: popover + anchor inside one component

Anchor button and popover content are both in the same `render()`. This is
`folderfoo-tag-filter.js` in full; adapt the anchor name and content.

```js
import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

// Per-instance anchor name so multiple copies of this component on one
// page don't fight over the same anchor - see reference.md's "why
// per-instance names" section.
let _instanceCounter = 0;

class MyDropdown extends LitElement {
  static styles = css`
    .toggle { /* ...button styles... */ }

    .menu {
      /* [popover] promotes this to the top layer: renders above
         everything, no z-index, never clipped by an ancestor's
         overflow: hidden/auto. CSS anchor positioning keeps it glued to
         the toggle button through any reflow with no JS measuring, and
         position-try-fallbacks flips it upward automatically when there
         isn't room below. */
      position: fixed;
      margin: 0;
      inset: auto;
      top: anchor(bottom);
      left: anchor(left);
      position-try-fallbacks: flip-block;
      /* ...visual styles: background, border, box-shadow, padding... */
    }
    .menu:popover-open {
      margin-top: 4px; /* the gap you'd normally get from top: calc(100% + 4px) */
    }
  `;

  constructor() {
    super();
    this._anchorName = `--my-dropdown-${++_instanceCounter}`;
  }

  _toggleOpen() {
    this.renderRoot.querySelector('.menu')?.togglePopover();
  }

  render() {
    return html`
      <button
        class="toggle"
        style=${`anchor-name: ${this._anchorName}`}
        @click=${() => this._toggleOpen()}
      >Open</button>

      <div class="menu" popover style=${`position-anchor: ${this._anchorName}`}>
        <!-- dropdown content -->
      </div>
    `;
  }
}
```

Key points:

- `popover` (bare = `popover="auto"`) gives you light-dismiss and
  single-open-at-a-time for free. Don't write your own
  `document.addEventListener('click', ...)` outside-click handler — delete
  it if you're migrating one.
- No `z-index` anywhere. Top-layer elements paint above the whole document
  by insertion order; you don't need to out-number an ancestor's z-index.
- `togglePopover()` / `showPopover()` / `hidePopover()` are the imperative
  API. `popovertarget="id"` on the button is the *declarative* alternative
  (skips the click handler entirely) — use it when the button doesn't need
  to do anything else on click.
- If you need to react to it opening/closing (e.g. to sync external state),
  listen for the native `toggle` event:
  `@toggle=${(e) => e.newState === 'open' ? ... : ...}` — `e.newState` is
  `'open'` or `'closed'`.

## Pattern B: popover on a child component's host, anchored to a parent's button

Use this when a list renders N trigger buttons and each opens a *separate
custom element* as its popover (one instance created/destroyed per row,
gated by a Lit conditional). This is
`folderfoo-tag-picker.js` + `folderfoo-file-open.js`.

**The rule that makes this different from Pattern A:** `anchor-name` /
`position-anchor` can only resolve within the same DOM tree scope. If the
anchor button lives in `folderfoo-file-open.js`'s shadow root, the
positioned element must *also* be reachable in that scope — an element
inside a *child* component's own separate shadow root cannot see it. So the
popover has to be the child component's **host element itself** (which
*is* a light-DOM child of the parent's shadow root), not a div inside the
child's `render()` output.

Parent (owns the buttons, assigns the anchor name):

```js
// folderfoo-file-open.js (the list)
static styles = css`
  .tag-btn {
    /* anchor-name set inline in the template below, only on whichever
       row's button currently has its popover open - see "the
       anchor-name scoping trap" in reference.md for why NOT to put this
       in the CSS rule (i.e. NOT: .tag-btn { anchor-name: ... }) applied
       to every row uniformly. */
  }
`;

render() {
  return html`
    ${this.rows.map(row => html`
      <button
        class="tag-btn"
        style=${this.openFor === row.id ? 'anchor-name: --my-row-anchor' : ''}
        @click=${() => this._toggle(row.id)}
      >⋮</button>
      ${this.openFor === row.id
        ? html`<my-row-popover .rowId=${row.id}
                 @my-row-popover-close=${() => this.openFor = null}
               ></my-row-popover>`
        : ''}
    `)}
  `;
}
```

Child (the popover is its own host):

```js
// my-row-popover.js
class MyRowPopover extends LitElement {
  static styles = css`
    :host {
      /* The HOST is the popover. Not an inner div - see the parent
         component's comment above for why. */
      all: initial;
      position: fixed;
      margin: 0;
      inset: auto;
      top: anchor(bottom);
      right: anchor(right);
      position-try-fallbacks: flip-block;
      /* ...visual styles... */
    }
    :host(:popover-open) { margin-top: 4px; }
  `;

  constructor() {
    super();
    this.addEventListener('toggle', (e) => this._onToggle(e));
  }

  connectedCallback() {
    super.connectedCallback();
    // MUST be here, not in the constructor - see reference.md's
    // "why connectedCallback, not constructor" section. Setting an
    // attribute in a custom element constructor is illegal per spec and
    // leaves the element in a broken half-upgraded state: it will compute
    // a plausible getBoundingClientRect() and match :popover-open, but
    // never actually paint or accept focus.
    this.setAttribute('popover', 'auto');
    this.style.positionAnchor = '--my-row-anchor';
  }

  // Created fresh each time it opens (see the parent's conditional
  // template), so firstUpdated = "just opened."
  firstUpdated() {
    this.showPopover();
  }

  _onToggle(e) {
    if (e.newState === 'closed') {
      this.dispatchEvent(new CustomEvent('my-row-popover-close', { bubbles: true, composed: true }));
    }
  }

  render() {
    return html`<!-- popover content, no wrapper div needed -->`;
  }
}
```

## The one Chromium bug you will hit if you skip this

If every row's trigger button gets the **same** `anchor-name` (e.g. a CSS
rule like `.tag-btn { anchor-name: --my-anchor }` applied uniformly, which
looks harmless since only one popover is ever open at a time), Chromium
computes a plausible box for the popover — `getBoundingClientRect()` looks
right, `:popover-open` matches — but **never actually paints it, hit-tests
it, or gives it focus**. It's silently invisible with every signal saying
it's open. This only shows up once there are enough duplicate-named anchors
in the same scope (worked fine with 1–2 rows in testing, broke at 8).

**Fix:** assign the `anchor-name` only to the *currently open* row's
button (inline `style`, conditional on your "which row is open" state), not
to every row uniformly. See Pattern B's parent example above, and
reference.md for the full bisection that found this.

## Checklist before shipping a new dropdown

- [ ] No `z-index` anywhere in the new CSS — if you wrote one, you're
      probably fighting the top layer instead of using it; delete it.
- [ ] No manual outside-click `document.addEventListener` — `popover`
      gives you light-dismiss for free.
- [ ] No `getBoundingClientRect()` flip-detection code — `position-anchor`
      + `position-try-fallbacks: flip-block` (or `flip-inline` for
      horizontal flipping) replaces it.
- [ ] If multiple trigger buttons can exist at once (a list), the
      `anchor-name` is scoped to only the open one, not applied uniformly.
- [ ] If the popover is its own child custom element, `popover` /
      `positionAnchor` are set in `connectedCallback()`, never the
      constructor.
- [ ] Tested with more than 1–2 instances of the trigger on screen at once
      (see the Chromium bug above — it doesn't show up at low counts).
- [ ] Spot-checked in Safari and Firefox, not just Chrome — this project's
      implementation has been manually confirmed working in all three.
- [ ] If open/closed state is synced through an avosignals `Signal`
      (shared store) rather than a local boolean, the signal is read
      somewhere inside `render()` — even a throwaway `void this._isOpen;`
      line. `SignalWatcher` only subscribes to signals read during
      `render()` (see
      [avosignals.ts](https://github.com/anatolipr/avos/blob/main/packages/avosignals/avosignals.ts)),
      so a signal only ever read from a click handler or `updated()` will
      update the store correctly but never trigger the re-render that
      actually calls `showPopover()`/`hidePopover()` — the dropdown will
      look completely inert while the underlying state is fine.
- [ ] If the trigger button and the popover are separate elements, toggling
      open/closed doesn't just call `.togglePopover()` in the click
      handler — check for the light-dismiss double-toggle race in
      reference.md first (clicking the trigger while open can fire native
      light-dismiss *before* your handler runs, so a naive
      `togglePopover()` call ends up reopening it).
