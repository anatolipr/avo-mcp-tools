---
name: making-lit-tooltips
description: >-
  Build a hover-triggered help/info tooltip in this project's Lit web components
  using the native Popover API + CSS anchor positioning — same mechanism as
  making-dropdowns, adapted for hover instead of click, a configurable preferred
  side (top/bottom/left/right) with automatic fallback to whichever other side
  fits, and the popover[popover]:not(:popover-open){display:none} gotcha that
  silently breaks a hover tooltip in a way a click-menu never hits. Use whenever
  adding a "?" help icon, info bubble, or any other hover-triggered (not
  click-triggered) floating annotation in a Lit element.
tags:
  - lit
  - tooltip
  - popover
  - css-anchor-positioning
  - frontend
  - web-components
trigger_phrases:
  - tooltip
  - help icon
  - hover popover
  - info bubble
  - popover
  - hover tooltip
metadata:
  owner: personal
  status: unreviewed
  extends: making-dropdowns
created_at: '2026-08-20T15:00:06.936Z'
body: >-
  ## Making hover tooltips


  This extends [[making-dropdowns]] — read that first. It covers the shared

  mechanics in full: the Popover API (top-layer promotion, no z-index, no

  manual outside-click handling), CSS anchor positioning (`anchor-name` /

  `position-anchor` / `anchor()`), `position-try-fallbacks` for automatic

  flip-to-fit, per-instance anchor names (and the Chromium bug you hit if you

  skip them), and why `connectedCallback()` not the constructor for anything

  imperative.


  A hover tooltip is the same two native features, but the trigger is

  *pointer movement*, not a click — which breaks two things a dropdown

  doesn't have to think about: how the popover opens/closes, and how it

  decides which side to prefer before any overflow has even happened.


  Full reference implementation: `help-tooltip.ts` in this repo

  (`packages/mcp-memory-bucket/src/client/help-tooltip.ts`) — a "?"-in-circle

  icon that shows explanatory text on hover, used next to form field labels.

  Read it directly for the complete code; this doc covers the parts that

  differ from a dropdown.


  ## Delta 1: hover open/close, not click toggle


  A dropdown toggles on click and gets light-dismiss for free from

  `popover="auto"`. A tooltip has no equivalent "auto" semantics for

  hover — light-dismiss is keyed to outside *clicks*, not pointer movement —

  so it needs `popover="manual"` and to drive `showPopover()`/`hidePopover()`

  itself from `mouseenter`/`mouseleave` (plus `focus`/`blur` for keyboard

  users):


  ```js

  #show() {
    if (this.#hideTimer) { clearTimeout(this.#hideTimer); this.#hideTimer = null; }
    const bubble = this.renderRoot.querySelector('.bubble');
    if (bubble && !bubble.matches(':popover-open')) bubble.showPopover();
  }


  // Small delay so moving the pointer from the icon onto the bubble itself

  // (e.g. to select/read its text) doesn't immediately close it.

  #scheduleHide() {
    this.#hideTimer = setTimeout(() => {
      this.renderRoot.querySelector('.bubble')?.hidePopover();
    }, 100);
  }


  render() {
    return html`
      <button
        class="icon"
        style=${`anchor-name: ${this.#anchorName}`}
        @mouseenter=${() => this.#show()}
        @mouseleave=${() => this.#scheduleHide()}
        @focus=${() => this.#show()}
        @blur=${() => this.#scheduleHide()}
      >?</button>
      <div
        class="bubble"
        popover="manual"
        style=${`position-anchor: ${this.#anchorName}`}
        @mouseenter=${() => this.#show()}
        @mouseleave=${() => this.#scheduleHide()}
      >${this.text}</div>
    `;
  }

  ```


  Both the icon *and* the bubble need `mouseenter`/`mouseleave` handlers —

  without the bubble's own handlers, moving the pointer off the icon and

  onto the bubble (to read a long tooltip or select its text) immediately

  schedules a close, because the icon's `mouseleave` fires the instant the

  pointer crosses into the bubble's box. The 100ms delay in `#scheduleHide`

  is what makes that crossing survivable; the bubble's own `mouseenter`

  cancels the pending hide once the pointer actually lands on it.


  ## Delta 2: a popover that's ":popover-open" but invisible


  This is the one gotcha worth remembering by name, because every signal

  you'd normally check says the tooltip is working:


  **The mistake:** copying a menu's `.visible` class-gating pattern (seen in

  `status-select.ts`: `.menu[popover] { display: none; } .menu.visible[popover]

  { display: block; }`) without also copying the state (a Signal-backed

  `#open` boolean toggled in lockstep with `showPopover()`) that pattern

  depends on to add the `.visible` class. A hover tooltip driven purely by

  imperative `showPopover()`/`hidePopover()` calls (no Signal, no Lit

  re-render involved in opening/closing) never gets the `.visible` class

  added — so `showPopover()` succeeds, `:popover-open` matches, but

  `display` stays `none` and nothing paints.


  **How this actually presents:**


  - `bubble.matches(':popover-open')` → `true`

  - `getComputedStyle(bubble).display` → `"none"`

  - `getBoundingClientRect()` → all-zero rect

  - No console error, no thrown exception — it just never appears


  **The fix:** don't gate visibility on a class at all when there's no

  Signal/Lit-state driving it. Key `display` directly off the

  `:popover-open` pseudo-class the browser already maintains for you:


  ```css

  .bubble[popover] { display: none; }

  .bubble:popover-open { display: block; }

  ```


  If you ever do need a class-gated variant (e.g. a fade transition), the

  class must be toggled from the same code path that calls

  `showPopover()`/`hidePopover()` — not left dangling from a copy-pasted

  menu pattern. Verify with the same computed-style/rect check above, not

  just `:popover-open`, since that pseudo-class alone doesn't prove

  anything painted.


  ## Delta 3: a configurable preferred side, not just "flip if it overflows"


  A dropdown always opens from a fixed edge (below the trigger, flipping up

  only on overflow). A tooltip attached to a small inline icon can

  reasonably be asked to open in any of the four directions by default

  — e.g. a field label's help icon wants to open **above** the label by

  default (so it doesn't cover the input below it), not below like a menu.


  `position-try-fallbacks` accepts a comma-separated list and tries them in

  order, so the fix is to build that list from a `placement` property

  instead of hardcoding it — the requested side first, the other three as

  fallbacks in a fixed order:


  ```js

  const ALL_PLACEMENTS = ['top', 'bottom', 'left', 'right'];


  const PRIMARY_POSITION = {
    top:    'top: auto; bottom: anchor(top); left: anchor(center); right: auto; translate: -50% 0; margin-bottom: 6px;',
    bottom: 'top: anchor(bottom); bottom: auto; left: anchor(center); right: auto; translate: -50% 0; margin-top: 6px;',
    left:   'top: anchor(center); bottom: auto; left: auto; right: anchor(left); translate: 0 -50%; margin-right: 6px;',
    right:  'top: anchor(center); bottom: auto; left: anchor(right); right: auto; translate: 0 -50%; margin-left: 6px;',
  };


  get #fallbackNames() {
    const rest = ALL_PLACEMENTS.filter((p) => p !== this.placement);
    return [this.placement, ...rest].map((p) => `--bubble-${p}`).join(', ');
  }

  ```


  with one `@position-try --bubble-<side>` block per side declared once in

  `static styles` (all four, always — CSS can't conditionally include a

  `@position-try` block, so declare all of them and just vary which ones a

  given instance's fallback list references):


  ```css

  @position-try --bubble-top {
    top: auto; bottom: anchor(top); left: anchor(center); right: auto;
    translate: -50% 0; margin: 0 0 6px;
  }

  @position-try --bubble-bottom {
    top: anchor(bottom); bottom: auto; left: anchor(center); right: auto;
    translate: -50% 0; margin: 6px 0 0;
  }

  @position-try --bubble-left {
    top: anchor(center); bottom: auto; left: auto; right: anchor(left);
    translate: 0 -50%; margin: 0 6px 0 0;
  }

  @position-try --bubble-right {
    top: anchor(center); bottom: auto; left: anchor(right); right: auto;
    translate: 0 -50%; margin: 0 0 0 6px;
  }

  ```


  Then set both the primary position and the fallback list inline, per

  instance, from the property:


  ```js

  style=${`position-anchor: ${this.#anchorName}; position-try-fallbacks:
  ${this.#fallbackNames}; ${PRIMARY_POSITION[this.placement]}`}

  ```


  Declare `placement` as a plain reactive property (default `'top'`) —

  callers set it same as any other Lit property:

  `<help-tooltip .text=${...} .placement=${'right'}></help-tooltip>`.


  **Why per-side named `@position-try` blocks instead of the `flip-block`/

  `flip-inline` keywords:** those keywords only remap along one axis each

  (block *or* inline), and only in the two directions of that axis. A

  configurable-4-side tooltip needs to go from "prefer left" to "try top,

  bottom, or right" — a fallback chain that crosses both axes — which the

  keyword shorthands can't express. Named blocks are the only way to list

  an arbitrary order across both axes, and they're also what makes a

  *non-default* preferred side possible at all: `flip-block`/`flip-inline`

  have no notion of "which side did the caller ask for," they just react to

  overflow from whatever the base `top`/`left` declarations already said.


  ## Checklist before shipping a new hover tooltip


  - [ ] Same checklist as [[making-dropdowns]] applies first (per-instance
        anchor names, no `z-index`, no manual outside-click handler,
        `connectedCallback()` not the constructor for anything imperative).
  - [ ] Trigger is `mouseenter`/`mouseleave` (+ `focus`/`blur`), not click —
        and both the icon *and* the bubble have their own
        `mouseenter`/`mouseleave` handlers, with a short (~100ms) hide delay,
        so crossing from icon to bubble doesn't flicker-close it.
  - [ ] `popover="manual"`, not bare `popover`/`popover="auto"` — hover has
        no light-dismiss semantics to inherit.
  - [ ] Visibility is keyed off `:popover-open` directly
        (`.bubble[popover] { display: none; } .bubble:popover-open { display:
        block; }`), not a manually-toggled `.visible` class — unless
        something actually toggles that class from the same code path that
        calls `showPopover()`. Verify by checking computed `display` and
        `getBoundingClientRect()` on hover, not just `:popover-open` — a
        stale class-gate passes the pseudo-class check while staying
        invisible.
  - [ ] If the component takes a configurable preferred side, all four
        `@position-try --bubble-<side>` blocks are declared unconditionally
        in `static styles`, and the primary position + `position-try-fallbacks`
        list are built from the `placement` property and set inline per
        instance — not hardcoded to one direction.
owner: personal
extends: making-dropdowns
---
## Making hover tooltips

This extends [[making-dropdowns]] — read that first. It covers the shared
mechanics in full: the Popover API (top-layer promotion, no z-index, no
manual outside-click handling), CSS anchor positioning (`anchor-name` /
`position-anchor` / `anchor()`), `position-try-fallbacks` for automatic
flip-to-fit, per-instance anchor names (and the Chromium bug you hit if you
skip them), and why `connectedCallback()` not the constructor for anything
imperative.

A hover tooltip is the same two native features, but the trigger is
*pointer movement*, not a click — which breaks two things a dropdown
doesn't have to think about: how the popover opens/closes, and how it
decides which side to prefer before any overflow has even happened.

Full reference implementation: `help-tooltip.ts` in this repo
(`packages/mcp-memory-bucket/src/client/help-tooltip.ts`) — a "?"-in-circle
icon that shows explanatory text on hover, used next to form field labels.
Read it directly for the complete code; this doc covers the parts that
differ from a dropdown.

## Delta 1: hover open/close, not click toggle

A dropdown toggles on click and gets light-dismiss for free from
`popover="auto"`. A tooltip has no equivalent "auto" semantics for
hover — light-dismiss is keyed to outside *clicks*, not pointer movement —
so it needs `popover="manual"` and to drive `showPopover()`/`hidePopover()`
itself from `mouseenter`/`mouseleave` (plus `focus`/`blur` for keyboard
users):

```js
#show() {
  if (this.#hideTimer) { clearTimeout(this.#hideTimer); this.#hideTimer = null; }
  const bubble = this.renderRoot.querySelector('.bubble');
  if (bubble && !bubble.matches(':popover-open')) bubble.showPopover();
}

// Small delay so moving the pointer from the icon onto the bubble itself
// (e.g. to select/read its text) doesn't immediately close it.
#scheduleHide() {
  this.#hideTimer = setTimeout(() => {
    this.renderRoot.querySelector('.bubble')?.hidePopover();
  }, 100);
}

render() {
  return html`
    <button
      class="icon"
      style=${`anchor-name: ${this.#anchorName}`}
      @mouseenter=${() => this.#show()}
      @mouseleave=${() => this.#scheduleHide()}
      @focus=${() => this.#show()}
      @blur=${() => this.#scheduleHide()}
    >?</button>
    <div
      class="bubble"
      popover="manual"
      style=${`position-anchor: ${this.#anchorName}`}
      @mouseenter=${() => this.#show()}
      @mouseleave=${() => this.#scheduleHide()}
    >${this.text}</div>
  `;
}
```

Both the icon *and* the bubble need `mouseenter`/`mouseleave` handlers —
without the bubble's own handlers, moving the pointer off the icon and
onto the bubble (to read a long tooltip or select its text) immediately
schedules a close, because the icon's `mouseleave` fires the instant the
pointer crosses into the bubble's box. The 100ms delay in `#scheduleHide`
is what makes that crossing survivable; the bubble's own `mouseenter`
cancels the pending hide once the pointer actually lands on it.

## Delta 2: a popover that's ":popover-open" but invisible

This is the one gotcha worth remembering by name, because every signal
you'd normally check says the tooltip is working:

**The mistake:** copying a menu's `.visible` class-gating pattern (seen in
`status-select.ts`: `.menu[popover] { display: none; } .menu.visible[popover]
{ display: block; }`) without also copying the state (a Signal-backed
`#open` boolean toggled in lockstep with `showPopover()`) that pattern
depends on to add the `.visible` class. A hover tooltip driven purely by
imperative `showPopover()`/`hidePopover()` calls (no Signal, no Lit
re-render involved in opening/closing) never gets the `.visible` class
added — so `showPopover()` succeeds, `:popover-open` matches, but
`display` stays `none` and nothing paints.

**How this actually presents:**

- `bubble.matches(':popover-open')` → `true`
- `getComputedStyle(bubble).display` → `"none"`
- `getBoundingClientRect()` → all-zero rect
- No console error, no thrown exception — it just never appears

**The fix:** don't gate visibility on a class at all when there's no
Signal/Lit-state driving it. Key `display` directly off the
`:popover-open` pseudo-class the browser already maintains for you:

```css
.bubble[popover] { display: none; }
.bubble:popover-open { display: block; }
```

If you ever do need a class-gated variant (e.g. a fade transition), the
class must be toggled from the same code path that calls
`showPopover()`/`hidePopover()` — not left dangling from a copy-pasted
menu pattern. Verify with the same computed-style/rect check above, not
just `:popover-open`, since that pseudo-class alone doesn't prove
anything painted.

## Delta 3: a configurable preferred side, not just "flip if it overflows"

A dropdown always opens from a fixed edge (below the trigger, flipping up
only on overflow). A tooltip attached to a small inline icon can
reasonably be asked to open in any of the four directions by default
— e.g. a field label's help icon wants to open **above** the label by
default (so it doesn't cover the input below it), not below like a menu.

`position-try-fallbacks` accepts a comma-separated list and tries them in
order, so the fix is to build that list from a `placement` property
instead of hardcoding it — the requested side first, the other three as
fallbacks in a fixed order:

```js
const ALL_PLACEMENTS = ['top', 'bottom', 'left', 'right'];

const PRIMARY_POSITION = {
  top:    'top: auto; bottom: anchor(top); left: anchor(center); right: auto; translate: -50% 0; margin-bottom: 6px;',
  bottom: 'top: anchor(bottom); bottom: auto; left: anchor(center); right: auto; translate: -50% 0; margin-top: 6px;',
  left:   'top: anchor(center); bottom: auto; left: auto; right: anchor(left); translate: 0 -50%; margin-right: 6px;',
  right:  'top: anchor(center); bottom: auto; left: anchor(right); right: auto; translate: 0 -50%; margin-left: 6px;',
};

get #fallbackNames() {
  const rest = ALL_PLACEMENTS.filter((p) => p !== this.placement);
  return [this.placement, ...rest].map((p) => `--bubble-${p}`).join(', ');
}
```

with one `@position-try --bubble-<side>` block per side declared once in
`static styles` (all four, always — CSS can't conditionally include a
`@position-try` block, so declare all of them and just vary which ones a
given instance's fallback list references):

```css
@position-try --bubble-top {
  top: auto; bottom: anchor(top); left: anchor(center); right: auto;
  translate: -50% 0; margin: 0 0 6px;
}
@position-try --bubble-bottom {
  top: anchor(bottom); bottom: auto; left: anchor(center); right: auto;
  translate: -50% 0; margin: 6px 0 0;
}
@position-try --bubble-left {
  top: anchor(center); bottom: auto; left: auto; right: anchor(left);
  translate: 0 -50%; margin: 0 6px 0 0;
}
@position-try --bubble-right {
  top: anchor(center); bottom: auto; left: anchor(right); right: auto;
  translate: 0 -50%; margin: 0 0 0 6px;
}
```

Then set both the primary position and the fallback list inline, per
instance, from the property:

```js
style=${`position-anchor: ${this.#anchorName}; position-try-fallbacks: ${this.#fallbackNames}; ${PRIMARY_POSITION[this.placement]}`}
```

Declare `placement` as a plain reactive property (default `'top'`) —
callers set it same as any other Lit property:
`<help-tooltip .text=${...} .placement=${'right'}></help-tooltip>`.

**Why per-side named `@position-try` blocks instead of the `flip-block`/
`flip-inline` keywords:** those keywords only remap along one axis each
(block *or* inline), and only in the two directions of that axis. A
configurable-4-side tooltip needs to go from "prefer left" to "try top,
bottom, or right" — a fallback chain that crosses both axes — which the
keyword shorthands can't express. Named blocks are the only way to list
an arbitrary order across both axes, and they're also what makes a
*non-default* preferred side possible at all: `flip-block`/`flip-inline`
have no notion of "which side did the caller ask for," they just react to
overflow from whatever the base `top`/`left` declarations already said.

## Checklist before shipping a new hover tooltip

- [ ] Same checklist as [[making-dropdowns]] applies first (per-instance
      anchor names, no `z-index`, no manual outside-click handler,
      `connectedCallback()` not the constructor for anything imperative).
- [ ] Trigger is `mouseenter`/`mouseleave` (+ `focus`/`blur`), not click —
      and both the icon *and* the bubble have their own
      `mouseenter`/`mouseleave` handlers, with a short (~100ms) hide delay,
      so crossing from icon to bubble doesn't flicker-close it.
- [ ] `popover="manual"`, not bare `popover`/`popover="auto"` — hover has
      no light-dismiss semantics to inherit.
- [ ] Visibility is keyed off `:popover-open` directly
      (`.bubble[popover] { display: none; } .bubble:popover-open { display:
      block; }`), not a manually-toggled `.visible` class — unless
      something actually toggles that class from the same code path that
      calls `showPopover()`. Verify by checking computed `display` and
      `getBoundingClientRect()` on hover, not just `:popover-open` — a
      stale class-gate passes the pseudo-class check while staying
      invisible.
- [ ] If the component takes a configurable preferred side, all four
      `@position-try --bubble-<side>` blocks are declared unconditionally
      in `static styles`, and the primary position + `position-try-fallbacks`
      list are built from the `placement` property and set inline per
      instance — not hardcoded to one direction.
