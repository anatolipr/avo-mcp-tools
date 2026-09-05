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
  group: anatoli
created_at: '2026-08-19T16:39:13.490Z'
body: >-
  ## Making dropdowns


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

      /* Two custom @position-try fallbacks, not the flip-block keyword —
         see "Flipping AND shrinking to fit" below for why: flip-block
         alone only remaps top/bottom, it doesn't also bound the far edge,
         so a tall menu can still overflow whichever side it lands on.
         Each fallback here pins BOTH edges (anchor side + a fixed margin
         off the opposite viewport edge), which is what lets height: auto
         actually shrink the box to fit. */
      @position-try --menu-below {
        top: anchor(bottom);
        bottom: 8px;
        margin-top: 4px;
        margin-bottom: 0;
      }
      @position-try --menu-above {
        bottom: anchor(top);
        top: 8px;
        margin-top: 0;
        margin-bottom: 4px;
      }

      .menu {
        /* [popover] promotes this to the top layer: renders above
           everything, no z-index, never clipped by an ancestor's
           overflow: hidden/auto. CSS anchor positioning keeps it glued to
           the toggle button through any reflow with no JS measuring. */
        position: fixed;
        margin: 0;
        inset: auto;
        top: anchor(bottom);
        bottom: 8px;
        left: anchor(left);
        position-try-fallbacks: --menu-below, --menu-above;
        /* Without this, the browser only tries --menu-above once the
           --menu-below position actually overflows — so on a short page
           where both sides have similar (insufficient) room, it can stay
           "below" even when "above" would fit better. most-block-size
           makes it evaluate both up front and pick whichever gives more
           room, matching how native <select> always chooses the roomier
           side. */
        position-try-order: most-block-size;
        /* Popovers get a UA-stylesheet default of height: fit-content,
           which sizes to content and ignores the bottom inset entirely —
           so even with both top and bottom set, the menu would still grow
           to fit all its options and overflow. height: auto overrides
           that default so top+bottom actually bound the box, letting it
           shrink below max-height when space is tight (confirmed via
           Playwright measurement: without this line the box measured
           height: fit-content and ignored bottom; with it, bottom is
           honored and the box shrinks to the true gap). */
        height: auto;
        max-height: 320px; /* ceiling for when there's plenty of room */
        overflow-y: auto;  /* scroll within whatever space remains, if content still exceeds it */
        /* ...visual styles: background, border, box-shadow, padding... */
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

  ## Start here: the plain default (works for almost everything)


  Before reaching for the "flip AND shrink" machinery below, use this —

  it's what actually shipped and was confirmed working after a real bug

  hunt (see "A bug this project actually hit" below). It's `flip-block` +

  a fixed `max-height`, nothing more:


  ```css

  .menu {
    position: fixed;
    margin: 0;
    inset: auto;
    top: anchor(bottom);
    left: anchor(left);
    width: anchor-size(width); /* omit if the menu shouldn't match the anchor's width */
    position-try-fallbacks: flip-block;
    max-height: 320px;
    overflow-y: auto;
    /* ...visual styles: background, border, box-shadow, padding... */
  }

  /* The 4px gap belongs here, not baked into a custom @position-try —
     see "A bug this project actually hit" for why. */
  .menu:popover-open { margin-top: 4px; }

  ```


  Do **not** set both `top` and `bottom` on the base (non-fallback) rule.

  Only `top: anchor(bottom)` — pin one edge, let the browser size the box

  to its content, and use `max-height` + `overflow-y: auto` as the ceiling.

  This covers the overwhelming majority of dropdowns (tag inputs, action

  menus, single-field autocomplete). Reach for the heavier "flip AND

  shrink" pattern below only if you've actually observed a menu getting

  clipped by the viewport edge with the plain version — don't add it

  preemptively.


  ### A bug this project actually hit


  An early version of a tag-input menu used the "flip AND shrink" pattern

  below (paired `@position-try` blocks each setting `top`+`bottom`+one

  margin) as its *only* positioning rule, including for the common case.

  The menu rendered detached from its input — sometimes pinned near the

  viewport top, overlapping unrelated content — even though the anchor

  name/`position-anchor` wiring was correct and Chromium's anchor

  positioning support was in range (confirmed at Chrome/Electron's bundled

  146). Simplifying to the plain default above (one `top` pin, no `bottom`

  on the base rule, gap moved to a `:popover-open` rule instead of inside

  `@position-try`) fixed it immediately. The exact interaction between

  over-constrained `top`+`bottom` and `anchor()` resolution on the *base*

  (non-fallback) rule wasn't root-caused further, but the practical

  takeaway holds: don't double-pin edges unless you've actually hit a

  clipping problem that requires it.


  ## Flipping AND shrinking to fit — only if the plain default clips


  The naive version of this pattern uses `position-try-fallbacks:

  flip-block` and a fixed `max-height`. That's enough to make the menu

  *flip sides*, but it is **not** enough to make it *fit* — and the two get

  conflated easily because they look like the same problem.


  **Only reach for this section if you've confirmed clipping** (e.g. via

  Playwright `getBoundingClientRect()` measurement, or a visibly cropped

  menu near a viewport edge) — the plain default above resolves cleanly

  for most dropdowns and doesn't have the double-pinning risk described

  above.


  **What `flip-block` actually does, and doesn't do:** it only tries the

  flipped position once the *initial* declared position overflows the

  viewport. If neither the initial position nor the flipped one has enough

  room for the menu's full (fit-content) height, the browser sticks with

  whichever it tried first — usually "below" — and the menu gets clipped by

  the viewport edge. This is easy to miss in manual testing: on a page with

  one field near the top, shrinking the window symmetrically eats into the

  space above and below at the same rate, so you can shrink the window a

  lot and never see a flip, then conclude flip-block is broken. It isn't —

  it correctly determined that flipping wouldn't have helped, because the

  menu (sized to its full content) didn't fit on the other side either.
  Confirmed

  by measuring actual `getBoundingClientRect()` values via Playwright: with

  `spaceAbove ≈ spaceBelow ≈ 135px` and a 207px-tall (content-sized) menu,

  neither side fits, so the browser correctly leaves it at the initial

  "below" position rather than flipping into an equally-cramped "above."


  **Two separate fixes, both needed for select-like behavior:**


  1. **Pick the roomier side, not just "flip if the first choice overflows."**
     Add `position-try-order: most-block-size` alongside
     `position-try-fallbacks`. This makes the browser evaluate every listed
     fallback *up front* and choose whichever gives the most room in the
     block direction — closer to how native `<select>` always opens toward
     the side with more space, rather than only reacting to overflow.
     Baseline as of February 2026 (Chrome 125+, Edge 125+, Safari 26+,
     Firefox 147+).

  2. **Let the menu shrink to whatever room it actually has, not just cap
     at a fixed max-height.** This needs a CSS mechanism most people reach
     for and it silently fails on a popover: setting both `top` and
     `bottom` insets is supposed to auto-compute the box's height to fill
     the gap between them (normal CSS box-model over-constrained
     resolution) — **but popovers carry a UA-stylesheet default of
     `height: fit-content`**, which sizes the box to its content and
     ignores the `bottom` inset as a sizing constraint entirely. The fix is
     one line: explicitly declare `height: auto;` on the popover to
     override that default. Once that's set, `top`/`bottom` genuinely bound
     the box and it shrinks below `max-height` whenever the true available
     space is smaller than the cap. This also means `flip-block` alone
     (which only remaps `top`/`bottom`, not the *opposite* edge) can't
     produce this effect — you need paired custom `@position-try` rules
     (`--menu-below`/`--menu-above` above) that each pin *both* edges, not
     just the keyword.

  Symptom checklist if you're debugging a menu that opens toward the

  "wrong" side or gets visibly cropped:


  - [ ] Confirm it's actually a bug, not correct behavior: measure real
        `spaceAbove`/`spaceBelow` vs. the menu's natural content height. If
        neither side has enough room, clipping *is* correct without fix #2
        below — the menu needs to shrink, not just flip.
  - [ ] `position-try-order: most-block-size` is present if you want
        "roomier side wins" instead of "only flip on overflow."
    - [ ] `.menu` (or whatever element carries `popover`) has an explicit
        `height: auto;` if you're relying on `top`+`bottom` insets to bound
        its size — check computed style in DevTools; if it silently reads
        back as `height: fit-content`-driven (i.e. equals the content's
        natural height regardless of the `bottom` inset), this is missing.
  - [ ] If flipping between two states, both fallbacks pin *both* edges
        (anchor edge + a fixed offset from the *opposite* viewport edge),
        not just the near edge — a bare `flip-block` keyword doesn't give
        you this.

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
        gives you light-dismiss for free (unless you're on `popover="manual"`
        per lit-autocomplete-combobox's edge 1, which needs it).
  - [ ] No `getBoundingClientRect()` flip-detection code — `position-anchor`
        + `position-try-fallbacks` (custom `@position-try` pair, or
        `flip-block`/`flip-inline` for the simple case) replaces it.
  - [ ] If the menu's content height can vary or the viewport can be short,
        use the paired `@position-try` + `position-try-order:
        most-block-size` + `height: auto` combo above, not bare
        `flip-block` — see "Flipping AND shrinking to fit."
  - [ ] If multiple trigger buttons can exist at once (a list), the
        `anchor-name` is scoped to only the open one, not applied uniformly.
  - [ ] If the popover is its own child custom element, `popover` /
        `positionAnchor` are set in `connectedCallback()`, never the
        constructor.
  - [ ] Tested with more than 1–2 instances of the trigger on screen at once
        (see the Chromium bug above — it doesn't show up at low counts).
  - [ ] The base (non-fallback) `.menu`/`.suggestions` rule pins only ONE
        edge (`top: anchor(bottom)`, not also `bottom: ...`) — see "Start
        here: the plain default" and "A bug this project actually hit."
        Reserve dual-edge pinning for the "flip AND shrink" section, and
        only after confirming real clipping.
  - [ ] The visual gap between anchor and menu is set via
        `.menu:popover-open { margin-top: ...px; }`, not baked into a
        `@position-try` block's `margin-top`/`margin-bottom` — a gap that
        only exists inside a fallback silently disappears on the base
        (non-flipped) position.
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
status: stable
owner: personal
extends: null
group: anatoli
---
## Making dropdowns

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

    /* Two custom @position-try fallbacks, not the flip-block keyword —
       see "Flipping AND shrinking to fit" below for why: flip-block
       alone only remaps top/bottom, it doesn't also bound the far edge,
       so a tall menu can still overflow whichever side it lands on.
       Each fallback here pins BOTH edges (anchor side + a fixed margin
       off the opposite viewport edge), which is what lets height: auto
       actually shrink the box to fit. */
    @position-try --menu-below {
      top: anchor(bottom);
      bottom: 8px;
      margin-top: 4px;
      margin-bottom: 0;
    }
    @position-try --menu-above {
      bottom: anchor(top);
      top: 8px;
      margin-top: 0;
      margin-bottom: 4px;
    }

    .menu {
      /* [popover] promotes this to the top layer: renders above
         everything, no z-index, never clipped by an ancestor's
         overflow: hidden/auto. CSS anchor positioning keeps it glued to
         the toggle button through any reflow with no JS measuring. */
      position: fixed;
      margin: 0;
      inset: auto;
      top: anchor(bottom);
      bottom: 8px;
      left: anchor(left);
      position-try-fallbacks: --menu-below, --menu-above;
      /* Without this, the browser only tries --menu-above once the
         --menu-below position actually overflows — so on a short page
         where both sides have similar (insufficient) room, it can stay
         "below" even when "above" would fit better. most-block-size
         makes it evaluate both up front and pick whichever gives more
         room, matching how native <select> always chooses the roomier
         side. */
      position-try-order: most-block-size;
      /* Popovers get a UA-stylesheet default of height: fit-content,
         which sizes to content and ignores the bottom inset entirely —
         so even with both top and bottom set, the menu would still grow
         to fit all its options and overflow. height: auto overrides
         that default so top+bottom actually bound the box, letting it
         shrink below max-height when space is tight (confirmed via
         Playwright measurement: without this line the box measured
         height: fit-content and ignored bottom; with it, bottom is
         honored and the box shrinks to the true gap). */
      height: auto;
      max-height: 320px; /* ceiling for when there's plenty of room */
      overflow-y: auto;  /* scroll within whatever space remains, if content still exceeds it */
      /* ...visual styles: background, border, box-shadow, padding... */
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

## Start here: the plain default (works for almost everything)

Before reaching for the "flip AND shrink" machinery below, use this —
it's what actually shipped and was confirmed working after a real bug
hunt (see "A bug this project actually hit" below). It's `flip-block` +
a fixed `max-height`, nothing more:

```css
.menu {
  position: fixed;
  margin: 0;
  inset: auto;
  top: anchor(bottom);
  left: anchor(left);
  width: anchor-size(width); /* omit if the menu shouldn't match the anchor's width */
  position-try-fallbacks: flip-block;
  max-height: 320px;
  overflow-y: auto;
  /* ...visual styles: background, border, box-shadow, padding... */
}
/* The 4px gap belongs here, not baked into a custom @position-try —
   see "A bug this project actually hit" for why. */
.menu:popover-open { margin-top: 4px; }
```

Do **not** set both `top` and `bottom` on the base (non-fallback) rule.
Only `top: anchor(bottom)` — pin one edge, let the browser size the box
to its content, and use `max-height` + `overflow-y: auto` as the ceiling.
This covers the overwhelming majority of dropdowns (tag inputs, action
menus, single-field autocomplete). Reach for the heavier "flip AND
shrink" pattern below only if you've actually observed a menu getting
clipped by the viewport edge with the plain version — don't add it
preemptively.

### A bug this project actually hit

An early version of a tag-input menu used the "flip AND shrink" pattern
below (paired `@position-try` blocks each setting `top`+`bottom`+one
margin) as its *only* positioning rule, including for the common case.
The menu rendered detached from its input — sometimes pinned near the
viewport top, overlapping unrelated content — even though the anchor
name/`position-anchor` wiring was correct and Chromium's anchor
positioning support was in range (confirmed at Chrome/Electron's bundled
146). Simplifying to the plain default above (one `top` pin, no `bottom`
on the base rule, gap moved to a `:popover-open` rule instead of inside
`@position-try`) fixed it immediately. The exact interaction between
over-constrained `top`+`bottom` and `anchor()` resolution on the *base*
(non-fallback) rule wasn't root-caused further, but the practical
takeaway holds: don't double-pin edges unless you've actually hit a
clipping problem that requires it.

## Flipping AND shrinking to fit — only if the plain default clips

The naive version of this pattern uses `position-try-fallbacks:
flip-block` and a fixed `max-height`. That's enough to make the menu
*flip sides*, but it is **not** enough to make it *fit* — and the two get
conflated easily because they look like the same problem.

**Only reach for this section if you've confirmed clipping** (e.g. via
Playwright `getBoundingClientRect()` measurement, or a visibly cropped
menu near a viewport edge) — the plain default above resolves cleanly
for most dropdowns and doesn't have the double-pinning risk described
above.

**What `flip-block` actually does, and doesn't do:** it only tries the
flipped position once the *initial* declared position overflows the
viewport. If neither the initial position nor the flipped one has enough
room for the menu's full (fit-content) height, the browser sticks with
whichever it tried first — usually "below" — and the menu gets clipped by
the viewport edge. This is easy to miss in manual testing: on a page with
one field near the top, shrinking the window symmetrically eats into the
space above and below at the same rate, so you can shrink the window a
lot and never see a flip, then conclude flip-block is broken. It isn't —
it correctly determined that flipping wouldn't have helped, because the
menu (sized to its full content) didn't fit on the other side either. Confirmed
by measuring actual `getBoundingClientRect()` values via Playwright: with
`spaceAbove ≈ spaceBelow ≈ 135px` and a 207px-tall (content-sized) menu,
neither side fits, so the browser correctly leaves it at the initial
"below" position rather than flipping into an equally-cramped "above."

**Two separate fixes, both needed for select-like behavior:**

1. **Pick the roomier side, not just "flip if the first choice overflows."**
   Add `position-try-order: most-block-size` alongside
   `position-try-fallbacks`. This makes the browser evaluate every listed
   fallback *up front* and choose whichever gives the most room in the
   block direction — closer to how native `<select>` always opens toward
   the side with more space, rather than only reacting to overflow.
   Baseline as of February 2026 (Chrome 125+, Edge 125+, Safari 26+,
   Firefox 147+).

2. **Let the menu shrink to whatever room it actually has, not just cap
   at a fixed max-height.** This needs a CSS mechanism most people reach
   for and it silently fails on a popover: setting both `top` and
   `bottom` insets is supposed to auto-compute the box's height to fill
   the gap between them (normal CSS box-model over-constrained
   resolution) — **but popovers carry a UA-stylesheet default of
   `height: fit-content`**, which sizes the box to its content and
   ignores the `bottom` inset as a sizing constraint entirely. The fix is
   one line: explicitly declare `height: auto;` on the popover to
   override that default. Once that's set, `top`/`bottom` genuinely bound
   the box and it shrinks below `max-height` whenever the true available
   space is smaller than the cap. This also means `flip-block` alone
   (which only remaps `top`/`bottom`, not the *opposite* edge) can't
   produce this effect — you need paired custom `@position-try` rules
   (`--menu-below`/`--menu-above` above) that each pin *both* edges, not
   just the keyword.

Symptom checklist if you're debugging a menu that opens toward the
"wrong" side or gets visibly cropped:

- [ ] Confirm it's actually a bug, not correct behavior: measure real
      `spaceAbove`/`spaceBelow` vs. the menu's natural content height. If
      neither side has enough room, clipping *is* correct without fix #2
      below — the menu needs to shrink, not just flip.
- [ ] `position-try-order: most-block-size` is present if you want
      "roomier side wins" instead of "only flip on overflow."
  - [ ] `.menu` (or whatever element carries `popover`) has an explicit
      `height: auto;` if you're relying on `top`+`bottom` insets to bound
      its size — check computed style in DevTools; if it silently reads
      back as `height: fit-content`-driven (i.e. equals the content's
      natural height regardless of the `bottom` inset), this is missing.
- [ ] If flipping between two states, both fallbacks pin *both* edges
      (anchor edge + a fixed offset from the *opposite* viewport edge),
      not just the near edge — a bare `flip-block` keyword doesn't give
      you this.

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
      gives you light-dismiss for free (unless you're on `popover="manual"`
      per lit-autocomplete-combobox's edge 1, which needs it).
- [ ] No `getBoundingClientRect()` flip-detection code — `position-anchor`
      + `position-try-fallbacks` (custom `@position-try` pair, or
      `flip-block`/`flip-inline` for the simple case) replaces it.
- [ ] If the menu's content height can vary or the viewport can be short,
      use the paired `@position-try` + `position-try-order:
      most-block-size` + `height: auto` combo above, not bare
      `flip-block` — see "Flipping AND shrinking to fit."
- [ ] If multiple trigger buttons can exist at once (a list), the
      `anchor-name` is scoped to only the open one, not applied uniformly.
- [ ] If the popover is its own child custom element, `popover` /
      `positionAnchor` are set in `connectedCallback()`, never the
      constructor.
- [ ] Tested with more than 1–2 instances of the trigger on screen at once
      (see the Chromium bug above — it doesn't show up at low counts).
- [ ] The base (non-fallback) `.menu`/`.suggestions` rule pins only ONE
      edge (`top: anchor(bottom)`, not also `bottom: ...`) — see "Start
      here: the plain default" and "A bug this project actually hit."
      Reserve dual-edge pinning for the "flip AND shrink" section, and
      only after confirming real clipping.
- [ ] The visual gap between anchor and menu is set via
      `.menu:popover-open { margin-top: ...px; }`, not baked into a
      `@position-try` block's `margin-top`/`margin-bottom` — a gap that
      only exists inside a fallback silently disappears on the base
      (non-flipped) position.
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
