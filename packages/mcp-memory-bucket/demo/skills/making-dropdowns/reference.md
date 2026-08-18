# Dropdowns reference: full examples, API notes, and the Chromium bug

This is the deep-dive companion to [SKILL.md](SKILL.md). Read that first for
the decision tree and the short patterns; come here for the complete
annotated code and the story behind the one real gotcha.

## Background: what these replace

Before this project's dropdowns were converted, both used the "classic"
approach:

- `position: absolute` on the popover, inside a `position: relative`
  wrapper around the anchor.
- A hand-written flip function (`_updateFlip()`) that called
  `getBoundingClientRect()` on the anchor and the popover, compared
  available space above/below against the nearest scrolling ancestor
  (found by manually walking up through nested shadow roots), and toggled
  a `[flipped]` attribute or CSS class.
- A `document.addEventListener('click', ...)` outside-click handler to
  implement dismiss-on-click-away, careful to call `e.stopPropagation()`
  in the right places so it didn't fight the anchor button's own click
  handler.
- `z-index` tuning to make sure the popover painted above sibling rows,
  modal backdrops, etc.

All four of those are gone in the current implementation. The Popover API
subsumes the click-away/z-index/clipping concerns; CSS anchor positioning
subsumes the flip math.

## The two native features, precisely

### Popover API

Any element can become a popover by giving it the `popover` attribute:

```html
<div popover>content</div>
```

- `popover` (or `popover="auto"`) — standard dropdown/menu semantics.
  Light-dismiss on outside click, Escape closes it, and only one `auto`
  popover can be open at a time document-wide (opening a second
  auto-dismisses the first, unless they're nested — see MDN's Popover API
  guide for the nesting exception).
- `popover="manual"` — no light-dismiss, no auto-exclusivity. You control
  everything. Rarely what you want for a dropdown; more for toasts/banners.
- Imperative control: `el.showPopover()`, `el.hidePopover()`,
  `el.togglePopover()`.
- Declarative control: `<button popovertarget="my-id">` toggles the
  popover with id `my-id` with no JS at all. Use this when the trigger
  button doesn't need to do anything else.
- State: `el.matches(':popover-open')` (CSS pseudo-class, also queryable
  in JS), and the `toggle` event
  (`e.newState` is `'open'` or `'closed'`, mirrors the
  `HTMLElement`'s `ontoggle`/`onbeforetoggle`) fires on open and close —
  including when the browser closes it for you via light-dismiss or Esc,
  which is the only reliable hook for "the user dismissed this without
  clicking anything I control."
- **What "top layer" actually buys you:** the element renders in a special
  paint layer above the entire document, outside all normal stacking
  contexts. It is not a descendant of its DOM parent for paint/clipping
  purposes. A parent's `overflow: hidden`, `clip-path`, or a `z-index` war
  three ancestors up — none of it applies. This is the entire reason the
  old `_updateFlip()` code needed to find "the nearest scrolling ancestor"
  (folderfoo-tag-picker.js's old code walked up through nested shadow
  roots to find `.panel`) — it doesn't need to anymore, because the
  popover was never going to be clipped by it in the first place.

### CSS anchor positioning

```css
.trigger { anchor-name: --my-anchor; }

.popover {
  position: fixed;
  position-anchor: --my-anchor;
  top: anchor(bottom);
  left: anchor(left);
  position-try-fallbacks: flip-block;
}
```

- `anchor-name` on the trigger declares it as a named anchor.
- `position-anchor` on the positioned element (must be `position: fixed`
  or `position: absolute`) references that name.
- `anchor(bottom)`, `anchor(left)`, `anchor(right)`, `anchor(top)`,
  `anchor(center)` resolve to the anchor's edge/center coordinates, usable
  anywhere a `<length>` is valid in `top`/`left`/`right`/`bottom`/`inset`.
- `position-try-fallbacks: flip-block` (vertical flip) or `flip-inline`
  (horizontal flip), or a comma-separated list of both/custom
  `@position-try` blocks, tells the browser to try an alternate position
  when the primary one doesn't fit the containing block — this is the
  automatic replacement for manual "does it fit below, else flip up" logic.
  The browser re-evaluates on every layout change (scroll, resize, content
  height change), so there's no stale-flip-decision bug the way a one-shot
  JS measurement could have.
- **Same-tree-scope requirement:** an anchor reference only resolves within
  one DOM tree scope (roughly: one shadow root, or the light document).
  An element inside a *different* shadow root — even a descendant
  custom element's own shadow root — cannot be an anchor target from
  outside, and cannot reference an anchor from outside. This is the
  reason Pattern B (in SKILL.md) puts `popover`/`position-anchor` on the
  child component's **host** rather than an inner div: the host element is
  a light-DOM child living in the *parent's* shadow root — the same scope
  the anchor button lives in — while anything inside the child's own
  shadow root is not.

## Pattern A in full: folderfoo-tag-filter.js

This is the actual current file (trimmed of unrelated business logic —
tag data, delete-tag affordance — to keep the dropdown mechanics visible).
See the real file for the complete version.

```js
import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

const DROPDOWN_ID = 'filter';
let _instanceCounter = 0;

class FolderfooTagFilter extends LitElement {
  static styles = css`
    :host { all: initial; position: static; }

    .toggle {
      /* ordinary button styling */
    }

    .menu {
      /* [popover] promotes this to the top layer, so it renders above
         everything (no z-index needed) and is never clipped by an
         ancestor's overflow: hidden/auto - e.g. folderfoo-file-open.js's
         scrolling file <ul>. CSS anchor positioning (anchor-name on
         .toggle, position-anchor here) keeps it glued to the toggle
         button through any reflow without any JS measuring, and
         position-try-fallbacks swaps it to open upward automatically
         when there isn't room below (replaces the old _updateFlip()
         rect math). */
      position: fixed;
      margin: 0;
      inset: auto;
      top: anchor(bottom);
      left: anchor(left);
      position-try-fallbacks: flip-block;
      background: white;
      border: 1px solid #ddd;
      border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2);
      padding: 8px;
      width: 200px;
      box-sizing: border-box;
    }
    .menu:popover-open {
      margin-top: 4px;
    }
  `;

  constructor() {
    super();
    // Per-instance anchor name - if two <folderfoo-tag-filter> ever
    // exist on one page, they must not share a name (see "why
    // per-instance names" below).
    this._anchorName = `--folderfoo-tag-filter-${++_instanceCounter}`;
  }

  connectedCallback() {
    super.connectedCallback();
    tagStore.ensureLoaded();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._isOpen) tagStore.closeDropdown();
  }

  get _isOpen() {
    return tagStore.openDropdown.get() === DROPDOWN_ID;
  }

  // Mirrors the popover's actual open/closed state (native light-dismiss,
  // Esc, or another dropdown opening elsewhere all need to be able to
  // close this one) back into shared app state.
  _onToggleEvent(e) {
    if (e.newState === 'open') {
      tagStore.openDropdownFor(DROPDOWN_ID);
    } else if (this._isOpen) {
      tagStore.closeDropdown();
    }
  }

  _toggleOpen() {
    // NOT menu.togglePopover() - see "the light-dismiss double-toggle
    // race" below for why calling that directly makes the toggle button
    // only ever open the menu, never close it.
    const wasOpen = this._isOpen;
    tagStore.closeDropdown();
    if (!wasOpen) {
      tagStore.openDropdownFor(DROPDOWN_ID);
    }
  }

  // Keeps the native popover's open state in sync with shared app state
  // when it changes from elsewhere (e.g. a different dropdown opening
  // closes this one). The reverse direction (this popover closing
  // itself via light-dismiss/Esc/togglePopover) is handled by
  // _onToggleEvent above.
  updated() {
    const menu = this.renderRoot.querySelector('.menu');
    if (!menu) return;
    if (this._isOpen && !menu.matches(':popover-open')) menu.showPopover();
    if (!this._isOpen && menu.matches(':popover-open')) menu.hidePopover();
  }

  render() {
    // Read _isOpen here even though its value isn't used in the template
    // below - see "why render() must read the signal" further down for
    // why this line has to exist.
    void this._isOpen;
    return html`
      <button
        class="toggle"
        style=${`anchor-name: ${this._anchorName}`}
        @click=${() => this._toggleOpen()}
      >Tags</button>

      <div
        class="menu"
        popover
        style=${`position-anchor: ${this._anchorName}`}
        @toggle=${(e) => this._onToggleEvent(e)}
      >
        <!-- content -->
      </div>
    `;
  }
}

customElements.define('folderfoo-tag-filter', FolderfooTagFilter);
```

**Why per-instance anchor names, when this component only ever has one
button?** Because `anchor-name` is a document-wide-unique-per-scope
identifier, not a per-component-instance one. If this component is ever
used twice on the same page (two `<folderfoo-tag-filter>` elements), a
hardcoded shared name would make both toggle buttons register the same
anchor name, and whichever popover queries it would resolve to whichever
button happens to win under the engine's tie-breaking rule (commonly "last
one in DOM order," but don't rely on that) rather than "the one that
actually opened it." A `let _instanceCounter` module-level counter,
incremented once per constructor call, sidesteps this cheaply.

### The light-dismiss double-toggle race

If `_toggleOpen` just calls `menu.togglePopover()` directly, the toggle
button silently stops being able to close the menu — it can only ever open
it. Here's why: `.toggle` is a *separate* element from the popover
(`.menu`). When the menu is already open and you click `.toggle`, the
browser's own light-dismiss algorithm treats that click as "outside the
popover" and closes the menu *before* your click handler runs — firing the
popover's `toggle` event, which flips the shared store to closed. Your
`_toggleOpen` handler then runs and calls `togglePopover()` on what is now
an already-closed popover, which reopens it. Net effect: every click
appears to "open" the menu, even the ones meant to close it.

The fix is to decide open-vs-close explicitly from state captured before
light-dismiss can touch it (`wasOpen`, read at the very start of the
handler), rather than asking the popover element what its current state is
mid-click.

### Why sync state through `updated()`/a shared store instead of just calling `showPopover()` directly

This component's open state is shared with a sibling dropdown
(`folderfoo-tag-picker.js`, so that opening one closes the other) via a
small reactive store (`tagStore.openDropdown`, an
[avosignals](https://github.com/anatolipr/avos) `Signal` — see
[avosignals.ts](https://github.com/anatolipr/avos/blob/main/packages/avosignals/avosignals.ts)
for the actual `Signal`/`SignalWatcher` implementation). If your dropdown
doesn't need to coordinate with anything else, you can skip the shared
store entirely and just call `.togglePopover()` on a local boolean (still
watching out for the light-dismiss race above if the trigger and the
popover are separate elements). Native `popover="auto"` already gives you
"opening one auto-popover closes any other auto-popover" for free at the
browser level; the shared-store version here exists only because this
project also needs `folderfoo-file-open.js` to know *which row* is open
for its own conditional rendering (see Pattern B), not merely "is a
popover open somewhere."

### Why render() must read the signal it reacts to

`SignalWatcher` (from avosignals — see the source link above) only tracks
signal reads that happen **during `render()`**: it wraps Lit's `update()`
method and pushes itself onto avosignals' internal tracking stack only for
that call, so any `Signal.get()` invoked while `render()` runs gets
subscribed, and anything read outside it (an event handler, `updated()`,
`firstUpdated()`) does not.

This bit us directly: `_isOpen` (which wraps
`tagStore.openDropdown.get()`) was only ever read from `_toggleOpen`,
`_onToggleEvent`, and `updated()` — never from `render()` itself. The
store updated correctly on every click, but because nothing had
subscribed to it, no re-render was ever scheduled, so `updated()` (the
method that actually calls `showPopover()`/`hidePopover()`) never ran
again after the first render. The toggle button *looked* completely
broken — clicking it did nothing visible — while the underlying app state
was changing correctly the whole time, which is what made it worth calling
out explicitly rather than assuming "the store isn't updating" first.

The fix is the `void this._isOpen;` line in `render()` above: a read with
no use of the value, purely to establish the subscription. Any component
that reacts to a signal only from outside `render()` needs this same
pattern — a lone `void someSignalBackedGetter;` line is enough, it doesn't
need to affect the template.

## Pattern B in full: folderfoo-tag-picker.js + folderfoo-file-open.js

The list side (trimmed to the relevant button/row markup — see the real
file for the full row template, tag chips, etc):

```js
// folderfoo-file-open.js
static styles = css`
  .tag-btn {
    /* anchor-name (set inline, only on whichever row's button currently
       has its picker open - see the template below) is the CSS anchor
       folderfoo-tag-picker.js's popover (see that file's position-anchor)
       stays glued to, without any position: relative wrapper or JS rect
       measuring - the popover's [popover] attribute promotes it to the
       top layer, so it's also never clipped by this <ul>'s own
       overflow-y: auto. Assigning the SAME anchor-name to every row's
       button (rather than just the open one) triggers a Chromium
       rendering bug - see "the anchor-name scoping trap" below. */
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    cursor: pointer;
  }
`;

// Which row's tag picker is open, if any - a filename, or null. Reads a
// shared store rather than owning local state, so opening a different
// row's picker (or the filter dropdown) closes this one.
get tagPickerFor() {
  const id = tagStore.openDropdown.get();
  return id && id !== 'filter' ? id : null;
}

_toggleTagPicker(e, name) {
  e.stopPropagation();
  if (this.tagPickerFor === name) {
    tagStore.closeDropdown();
  } else {
    tagStore.openDropdownFor(name);
  }
}

render() {
  return html`
    <ul>
      ${results.map((f) => html`
        <li>
          <span class="name">${f.name}</span>
          <div class="tag-picker-anchor">
            <button
              type="button"
              class="tag-btn"
              style=${this.tagPickerFor === f.name ? 'anchor-name: --folderfoo-tag-btn' : ''}
              @click=${(e) => this._toggleTagPicker(e, f.name)}
            >🏷</button>
            ${this.tagPickerFor === f.name
              ? html`<folderfoo-tag-picker
                  .filename=${f.name}
                  @folderfoo-tag-picker-close=${() => tagStore.closeDropdown()}
                ></folderfoo-tag-picker>`
              : ''}
          </div>
        </li>
      `)}
    </ul>
  `;
}
```

The popover side — note `popover`/`positionAnchor` are set on `:host`
CSS and on `this` (the host element) in JS, never on an inner div:

```js
// folderfoo-tag-picker.js
class FolderfooTagPicker extends LitElement {
  static properties = {
    filename: { type: String },
  };

  static styles = css`
    :host {
      /* [popover] (set as an attribute in connectedCallback(), not here)
         promotes the HOST element itself to the top layer. It has to be
         the host, not an inner div: CSS anchor positioning can only
         resolve an anchor-name/position-anchor pair within the same tree
         scope, and the anchor button (.tag-btn) lives in
         folderfoo-file-open.js's shadow root - the same scope this host
         element's light-DOM slot sits in - while anything inside THIS
         element's own shadow root is a different, incompatible scope. */
      all: initial;
      position: fixed;
      margin: 0;
      inset: auto;
      top: anchor(bottom);
      right: anchor(right);
      position-try-fallbacks: flip-block;
      background: white;
      border: 1px solid #ddd;
      border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2);
      padding: 8px;
      width: 200px;
      box-sizing: border-box;
    }
    :host(:popover-open) {
      margin-top: 4px;
    }
  `;

  constructor() {
    super();
    this.filename = '';
    this.addEventListener('toggle', (e) => this._onToggleEvent(e));
  }

  connectedCallback() {
    super.connectedCallback();
    // Set directly on the host rather than in the constructor - custom
    // element constructors aren't allowed to set attributes (throws in
    // the direct document.createElement() path, and leaves the element
    // in a broken half-upgraded state via Lit's own element-creation
    // path: it computes a plausible getBoundingClientRect() for the
    // popover but never actually paints or hit-tests it -
    // elementFromPoint() at that exact box falls through to <html>).
    this.setAttribute('popover', 'auto');
    this.style.positionAnchor = '--folderfoo-tag-btn';
  }

  // Created fresh each time it opens, destroyed when it closes (see
  // folderfoo-file-open.js's tagPickerFor-gated template above), so
  // showPopover() here is equivalent to "open immediately."
  firstUpdated() {
    this.showPopover();
  }

  // Native light-dismiss/Esc closing the popover fires this without any
  // click ever reaching our own handlers, so it's the one place that
  // needs to tell folderfoo-file-open.js (which owns tagPickerFor) to
  // un-render this element.
  _onToggleEvent(e) {
    if (e.newState === 'closed') {
      this.dispatchEvent(new CustomEvent('folderfoo-tag-picker-close', { bubbles: true, composed: true }));
    }
  }

  _selectSomething() {
    // ...do the thing...
    // hidePopover() fires the popover's own 'toggle' event, which
    // _onToggleEvent turns into the bubbling close event
    // folderfoo-file-open.js listens for - so closing on selection is
    // just this one call, no separate "tell my parent to close me" step.
    this.hidePopover();
  }

  render() {
    return html`<!-- content, no wrapper div needed -->`;
  }
}

customElements.define('folderfoo-tag-picker', FolderfooTagPicker);
```

## The anchor-name scoping trap (a real Chromium bug, not spec behavior)

This is the one gotcha in this whole approach worth remembering by name.

**The setup:** a list renders N rows, each with its own trigger button. The
obvious-looking CSS is:

```css
/* DON'T DO THIS if N can be more than ~2 */
.tag-btn {
  anchor-name: --my-anchor;
}
```

This looks safe: only one popover is ever open at a time (gated by a
`tagPickerFor`-style condition), so "every button has the same anchor name"
seems irrelevant — only the currently-open one's name will ever actually
get referenced.

**What actually happens in Chromium:** once there are enough elements
sharing one `anchor-name` in the same scope, the popover:

- computes a plausible `getBoundingClientRect()` (real, sane pixel values,
  positioned somewhere near a button),
- matches the `:popover-open` CSS pseudo-class,
- but **never actually paints**, and
- **never accepts focus** (native `popover="auto"` autofocuses itself or
  its first focusable descendant on show — this failing to happen is a
  reliable tell that something is wrong even before you check pixels), and
- **never hit-tests** (`document.elementFromPoint()` at the popover's own
  reported center falls through to `<html>`).

Every individual signal you'd normally use to verify "is this open" says
yes. The only way to catch it is a pixel-level screenshot, or checking
`document.activeElement` didn't move into the popover.

This reproduced at 8 buttons sharing one name; a synthetic test with 1–2
buttons sharing the same name painted fine, which is what made this
particularly easy to miss in early manual testing — small lists work,
larger ones silently break.

**The fix:** don't give the anchor-name to every trigger uniformly. Give it
only to whichever one currently owns the open popover, via an inline
`style` bound to your "which row is open" condition — see the
`folderfoo-file-open.js` example above (`style=${this.tagPickerFor === f.name ? 'anchor-name: --folderfoo-tag-btn' : ''}`).
With only ever one element holding the name in the document at a time, the
ambiguity — and the bug — disappears entirely.

If you ever need genuinely multiple simultaneously-anchored popovers
sharing a naming scheme (not folderfoo's current use case, but plausible
elsewhere), look at
[`anchor-scope`](https://developer.mozilla.org/en-US/docs/Web/CSS/anchor-scope)
first — it scopes an `anchor-name` to a subtree so structurally repeated
components (e.g. a card grid where every card has its own "more options"
button) don't collide, without needing per-instance JS-generated names.
This project didn't need it because at most one dropdown is ever open at a
time, but it's the more scalable answer if that constraint doesn't hold for
your case.

## Why connectedCallback(), not the constructor

Custom element constructors are not allowed to set attributes or otherwise
touch the element beyond creating internal state — this is a hard rule in
the custom elements spec, not a style preference. Doing it anyway:

- **Throws** if the element is created via `document.createElement()`
  directly (`NotSupportedError: The result must not have attributes`).
- **Silently half-breaks** the element when Lit creates it as part of a
  template render — no thrown error, but the element ends up in the same
  broken non-painting state described above (this was actually found while
  chasing the anchor-name bug above; both needed fixing, though the
  anchor-name issue turned out to be the one actually responsible for the
  real-page failure — the constructor-attribute fix alone did not resolve
  it, but is still required correctness).

Always set `popover` and any anchor-related inline styles in
`connectedCallback()`.

## Testing checklist for a new dropdown

Because the anchor-name bug above passes every JS-level check
(`:popover-open` matches, `getBoundingClientRect()` looks sane) and only
shows up visually, verifying a new dropdown means actually looking at
pixels, not just asserting on state:

1. Render the real number of trigger instances you expect in production
   (not just one) — the bug above needs enough duplicates to trigger.
2. Take an actual screenshot (or look at it in a real browser) with the
   dropdown open, not just a DOM/state assertion.
3. Confirm it renders **outside** an ancestor with `overflow: hidden` — put
   it inside one deliberately in a throwaway test page if the real layout
   doesn't have one handy, to prove top-layer promotion is actually
   engaged rather than coincidentally fitting.
4. Click outside it and confirm it closes (light-dismiss).
5. Open a second dropdown elsewhere on the page (if one exists) and confirm
   the first one closes.
6. Spot-check in Safari and Firefox, not just Chrome. The bug above is
   Chromium-specific reasoning (it's about Chromium's top-layer insertion
   implementation, not the spec), so it's not something to assume carries
   over - but conversely, this project's dropdowns have been manually
   confirmed working correctly in Safari and Firefox as well as Chrome, so
   a regression there is worth taking seriously rather than dismissing as
   "just Safari being Safari."
