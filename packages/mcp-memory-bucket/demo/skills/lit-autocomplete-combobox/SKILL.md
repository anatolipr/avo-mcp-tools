---
name: lit-autocomplete-combobox
description: >-
  Builds an autocomplete/combobox dropdown in Lit that takes an options array
  shaped [{label, value}], filters as the user types, and is positioned with the
  native Popover API + CSS anchor positioning (per making-dropdowns). Covers the
  input-as-anchor sharp edges that pattern doesn't: the popover="auto"
  light-dismiss race that closes the menu immediately after opening on
  focus/click when the anchor is a text input (not a popovertarget-eligible
  button), separating displayed text from the active filter so reopening after a
  selection shows the full list instead of one filtered result, and the full
  ARIA APG combobox pattern (role=combobox,
  aria-expanded/aria-controls/aria-activedescendant, role=listbox/option). Use
  whenever building a searchable select, autocomplete field, or combobox in Lit
  — including a WebAwesome-combobox-style version with a clear button and
  chevron toggle.
tags:
  - lit
  - combobox
  - autocomplete
  - dropdown
  - popover
  - aria
  - frontend
  - web-components
trigger_phrases:
  - autocomplete dropdown
  - combobox
  - searchable select
  - filter dropdown
  - select component
  - lit combobox
metadata:
  owner: personal
  status: stable
  extends: null
body: >-
  ## Autocomplete combobox in Lit


  This extends [[making-dropdowns]]'s "Pattern A" (anchor + popover in the

  same shadow root, positioned via the native Popover API + CSS anchor

  positioning) for the specific case where the anchor is a **text input**,

  not a button. That substitution introduces three sharp edges that Pattern

  A alone doesn't cover. Read this after making-dropdowns, not instead of

  it — the base positioning approach (`anchor-name`/`position-anchor`,

  `position-try-fallbacks: flip-block`, no z-index, no manual

  `getBoundingClientRect()`) is unchanged.


  ### Edge 1: `popover="auto"` closes itself immediately when the anchor is a
  text input


  `popover="auto"` light-dismiss exempts an element from "outside click"

  handling only if it's registered as the popover's **invoker** via the

  `popovertarget` attribute — and `popovertarget` only works on

  button-type elements. A text `<input>` can't be a popovertarget invoker.

  So calling `showPopover()` from the input's `focus`/`click` handler opens

  the menu, but the browser's own light-dismiss algorithm then sees that

  same click as landing outside the popover and closes it on the next tick

  — the menu flashes open and immediately shuts.


  **Fix:** use `popover="manual"` instead of `popover="auto"` on the menu.

  Manual popovers have no built-in light-dismiss or Escape-to-close, so

  replicate both yourself:


  ```js

  constructor() {
    super();
    this._onDocumentClick = this._onDocumentClick.bind(this);
  }


  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('click', this._onDocumentClick);
  }


  disconnectedCallback() {
    document.removeEventListener('click', this._onDocumentClick);
    super.disconnectedCallback();
  }


  // The input itself must stay exempt — composedPath().includes(this)

  // covers the whole host, input included, since it's all one shadow root.

  _onDocumentClick(e) {
    if (!e.composedPath().includes(this)) this._closeMenu();
  }


  _onKeydown(e) {
    if (e.key === 'Escape') this._closeMenu();
    // ...ArrowDown/ArrowUp/Enter, see edge 3
  }

  ```


  ```html

  <ul class="menu" popover="manual" style=${`position-anchor:
  ${this._anchorName}`}>

  ```


  ### Edge 2: displayed text vs. active filter must be two separate fields


  If the input's value and the filter query are the same state field, then

  after a user selects "Brazil", `_query` becomes `"Brazil"` — so reopening

  the menu (focus/click) re-filters against `"Brazil"` and shows only that

  one row instead of the full list the user expects when browsing to change

  their selection.


  **Fix:** keep `_query` (what's rendered in the `<input>`) and

  `_filterQuery` (what `_filtered` actually matches against) as separate

  reactive fields. They stay in lockstep while typing, but reopening after

  a selection resets only `_filterQuery`, leaving the visible text alone:


  ```js

  get _filtered() {
    const q = this._filterQuery.trim().toLowerCase();
    if (!q) return this.options;
    return this.options.filter((o) => o.label.toLowerCase().includes(q));
  }


  _onInput(e) {
    this._query = e.target.value;
    this._filterQuery = e.target.value;   // typing re-links filter to text
    this._highlighted = -1;
    this._openMenu();
  }


  _onFocus() {
    if (this.value) {
      this._filterQuery = '';             // full list underneath...
      this._highlighted = -1;
    }
    this._openMenu();                     // ...while _query keeps showing the label
  }


  _selectOption(option) {
    this.value = option.value;
    this._query = option.label;
    this._filterQuery = option.label;
    this._closeMenu();
    this.dispatchEvent(new CustomEvent('change', {
      detail: { option }, bubbles: true, composed: true,
    }));
  }

  ```


  Also wire `@click=${this._onFocus}` in addition to `@focus`, so clicking

  an already-focused input (e.g. right after picking an option) reopens the

  menu — a second click doesn't refire the native `focus` event.


  ### Edge 3: full ARIA APG combobox pattern


  Beyond the base positioning CSS, wire real accessibility state, not just

  visual highlighting:


  ```html

  <input
    role="combobox"
    aria-autocomplete="list"
    aria-expanded=${this._open}
    aria-controls=${this._listboxId}
    aria-activedescendant=${this._highlighted >= 0 ? `${this._listboxId}-opt-${this._highlighted}` : ''}
    .value=${this._query}
    @input=${this._onInput}
    @focus=${this._onFocus}
    @click=${this._onFocus}
    @keydown=${this._onKeydown}
  />

  <ul id=${this._listboxId} class="menu" role="listbox" popover="manual" ...>
    ${items.map((o, i) => html`
      <li id=${`${this._listboxId}-opt-${i}`} role="option"
          aria-selected=${o.value === this.value}
          class=${i === this._highlighted ? 'option highlighted' : 'option'}
          @mousedown=${(e) => e.preventDefault()}
          @click=${() => this._selectOption(o)}
      >${o.label}</li>
    `)}
  </ul>

  ```


  `_open` is a plain reactive boolean set in `_openMenu()`/`_closeMenu()`

  alongside the actual `showPopover()`/`hidePopover()` calls — it drives

  `aria-expanded` and any chevron-rotation styling. `@mousedown` on each

  option calls `preventDefault()` so the input doesn't lose focus (and thus

  fire a premature blur/close) before the option's `click` handler runs.


  Full ArrowDown/ArrowUp/Enter keyboard nav:


  ```js

  _onKeydown(e) {
    const items = this._filtered;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._openMenu();
      if (items.length) this._highlighted = (this._highlighted + 1) % items.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._openMenu();
      if (items.length) this._highlighted = (this._highlighted - 1 + items.length) % items.length;
    } else if (e.key === 'Enter') {
      if (this._highlighted >= 0 && this._highlighted < items.length) {
        e.preventDefault();
        this._selectOption(items[this._highlighted]);
      }
    } else if (e.key === 'Escape') {
      this._closeMenu();
    }
  }

  ```


  ### Optional: clear button + chevron toggle (WebAwesome-combobox style)


  A minimal `×` clear button (shown only when `this.value` is set; fully

  deselects and dispatches `change` with `detail: { option: null }`) and a

  chevron button that calls `_toggleMenu()` round out a combobox that feels

  like a native form control. Both need `tabindex="-1"` (they're pointer

  affordances, not separate tab stops — the input is the single focusable

  control) and `@mousedown=${(e) => e.preventDefault()}` for the same

  focus-preservation reason as the option `<li>`s.


  ```js

  _toggleMenu() {
    if (this._open) {
      this._closeMenu();
    } else {
      this._onFocus();
      this.renderRoot.querySelector('.input')?.focus();
    }
  }


  _clear(e) {
    e.stopPropagation();
    this.value = '';
    this._query = '';
    this._filterQuery = '';
    this._highlighted = -1;
    this.renderRoot.querySelector('.input')?.focus();
    this._openMenu();
    this.dispatchEvent(new CustomEvent('change', {
      detail: { option: null }, bubbles: true, composed: true,
    }));
  }

  ```


  Any consumer listening for `change` must handle `detail.option === null`

  (a clear), not just the populated-selection case.


  ## Checklist (in addition to making-dropdowns' own checklist)


  - [ ] Menu uses `popover="manual"`, not `"auto"` — anchor is a text input.

  - [ ] Outside-click and Escape are handled manually (manual popovers get
        neither for free).
  - [ ] `_query` (display) and `_filterQuery` (matching) are separate state
        fields; only `_filterQuery` resets on reopen-after-selection.
  - [ ] `@click` as well as `@focus` opens the menu, so reclicking an
        already-focused input works.
  - [ ] `role="combobox"` + `aria-expanded`/`aria-controls`/
        `aria-activedescendant` on the input; `role="listbox"`/`"option"` +
        `aria-selected` on the menu/items.
  - [ ] Every option (and clear/chevron button, if present) has
        `@mousedown=${(e) => e.preventDefault()}` to stop focus loss before
        the click handler runs.
  - [ ] `change` event consumers handle a `null` option (from the clear
        button), not just a populated selection.
owner: personal
---
## Autocomplete combobox in Lit

This extends [[making-dropdowns]]'s "Pattern A" (anchor + popover in the
same shadow root, positioned via the native Popover API + CSS anchor
positioning) for the specific case where the anchor is a **text input**,
not a button. That substitution introduces three sharp edges that Pattern
A alone doesn't cover. Read this after making-dropdowns, not instead of
it — the base positioning approach (`anchor-name`/`position-anchor`,
`position-try-fallbacks: flip-block`, no z-index, no manual
`getBoundingClientRect()`) is unchanged.

### Edge 1: `popover="auto"` closes itself immediately when the anchor is a text input

`popover="auto"` light-dismiss exempts an element from "outside click"
handling only if it's registered as the popover's **invoker** via the
`popovertarget` attribute — and `popovertarget` only works on
button-type elements. A text `<input>` can't be a popovertarget invoker.
So calling `showPopover()` from the input's `focus`/`click` handler opens
the menu, but the browser's own light-dismiss algorithm then sees that
same click as landing outside the popover and closes it on the next tick
— the menu flashes open and immediately shuts.

**Fix:** use `popover="manual"` instead of `popover="auto"` on the menu.
Manual popovers have no built-in light-dismiss or Escape-to-close, so
replicate both yourself:

```js
constructor() {
  super();
  this._onDocumentClick = this._onDocumentClick.bind(this);
}

connectedCallback() {
  super.connectedCallback();
  document.addEventListener('click', this._onDocumentClick);
}

disconnectedCallback() {
  document.removeEventListener('click', this._onDocumentClick);
  super.disconnectedCallback();
}

// The input itself must stay exempt — composedPath().includes(this)
// covers the whole host, input included, since it's all one shadow root.
_onDocumentClick(e) {
  if (!e.composedPath().includes(this)) this._closeMenu();
}

_onKeydown(e) {
  if (e.key === 'Escape') this._closeMenu();
  // ...ArrowDown/ArrowUp/Enter, see edge 3
}
```

```html
<ul class="menu" popover="manual" style=${`position-anchor: ${this._anchorName}`}>
```

### Edge 2: displayed text vs. active filter must be two separate fields

If the input's value and the filter query are the same state field, then
after a user selects "Brazil", `_query` becomes `"Brazil"` — so reopening
the menu (focus/click) re-filters against `"Brazil"` and shows only that
one row instead of the full list the user expects when browsing to change
their selection.

**Fix:** keep `_query` (what's rendered in the `<input>`) and
`_filterQuery` (what `_filtered` actually matches against) as separate
reactive fields. They stay in lockstep while typing, but reopening after
a selection resets only `_filterQuery`, leaving the visible text alone:

```js
get _filtered() {
  const q = this._filterQuery.trim().toLowerCase();
  if (!q) return this.options;
  return this.options.filter((o) => o.label.toLowerCase().includes(q));
}

_onInput(e) {
  this._query = e.target.value;
  this._filterQuery = e.target.value;   // typing re-links filter to text
  this._highlighted = -1;
  this._openMenu();
}

_onFocus() {
  if (this.value) {
    this._filterQuery = '';             // full list underneath...
    this._highlighted = -1;
  }
  this._openMenu();                     // ...while _query keeps showing the label
}

_selectOption(option) {
  this.value = option.value;
  this._query = option.label;
  this._filterQuery = option.label;
  this._closeMenu();
  this.dispatchEvent(new CustomEvent('change', {
    detail: { option }, bubbles: true, composed: true,
  }));
}
```

Also wire `@click=${this._onFocus}` in addition to `@focus`, so clicking
an already-focused input (e.g. right after picking an option) reopens the
menu — a second click doesn't refire the native `focus` event.

### Edge 3: full ARIA APG combobox pattern

Beyond the base positioning CSS, wire real accessibility state, not just
visual highlighting:

```html
<input
  role="combobox"
  aria-autocomplete="list"
  aria-expanded=${this._open}
  aria-controls=${this._listboxId}
  aria-activedescendant=${this._highlighted >= 0 ? `${this._listboxId}-opt-${this._highlighted}` : ''}
  .value=${this._query}
  @input=${this._onInput}
  @focus=${this._onFocus}
  @click=${this._onFocus}
  @keydown=${this._onKeydown}
/>
<ul id=${this._listboxId} class="menu" role="listbox" popover="manual" ...>
  ${items.map((o, i) => html`
    <li id=${`${this._listboxId}-opt-${i}`} role="option"
        aria-selected=${o.value === this.value}
        class=${i === this._highlighted ? 'option highlighted' : 'option'}
        @mousedown=${(e) => e.preventDefault()}
        @click=${() => this._selectOption(o)}
    >${o.label}</li>
  `)}
</ul>
```

`_open` is a plain reactive boolean set in `_openMenu()`/`_closeMenu()`
alongside the actual `showPopover()`/`hidePopover()` calls — it drives
`aria-expanded` and any chevron-rotation styling. `@mousedown` on each
option calls `preventDefault()` so the input doesn't lose focus (and thus
fire a premature blur/close) before the option's `click` handler runs.

Full ArrowDown/ArrowUp/Enter keyboard nav:

```js
_onKeydown(e) {
  const items = this._filtered;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    this._openMenu();
    if (items.length) this._highlighted = (this._highlighted + 1) % items.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    this._openMenu();
    if (items.length) this._highlighted = (this._highlighted - 1 + items.length) % items.length;
  } else if (e.key === 'Enter') {
    if (this._highlighted >= 0 && this._highlighted < items.length) {
      e.preventDefault();
      this._selectOption(items[this._highlighted]);
    }
  } else if (e.key === 'Escape') {
    this._closeMenu();
  }
}
```

### Optional: clear button + chevron toggle (WebAwesome-combobox style)

A minimal `×` clear button (shown only when `this.value` is set; fully
deselects and dispatches `change` with `detail: { option: null }`) and a
chevron button that calls `_toggleMenu()` round out a combobox that feels
like a native form control. Both need `tabindex="-1"` (they're pointer
affordances, not separate tab stops — the input is the single focusable
control) and `@mousedown=${(e) => e.preventDefault()}` for the same
focus-preservation reason as the option `<li>`s.

```js
_toggleMenu() {
  if (this._open) {
    this._closeMenu();
  } else {
    this._onFocus();
    this.renderRoot.querySelector('.input')?.focus();
  }
}

_clear(e) {
  e.stopPropagation();
  this.value = '';
  this._query = '';
  this._filterQuery = '';
  this._highlighted = -1;
  this.renderRoot.querySelector('.input')?.focus();
  this._openMenu();
  this.dispatchEvent(new CustomEvent('change', {
    detail: { option: null }, bubbles: true, composed: true,
  }));
}
```

Any consumer listening for `change` must handle `detail.option === null`
(a clear), not just the populated-selection case.

## Checklist (in addition to making-dropdowns' own checklist)

- [ ] Menu uses `popover="manual"`, not `"auto"` — anchor is a text input.
- [ ] Outside-click and Escape are handled manually (manual popovers get
      neither for free).
- [ ] `_query` (display) and `_filterQuery` (matching) are separate state
      fields; only `_filterQuery` resets on reopen-after-selection.
- [ ] `@click` as well as `@focus` opens the menu, so reclicking an
      already-focused input works.
- [ ] `role="combobox"` + `aria-expanded`/`aria-controls`/
      `aria-activedescendant` on the input; `role="listbox"`/`"option"` +
      `aria-selected` on the menu/items.
- [ ] Every option (and clear/chevron button, if present) has
      `@mousedown=${(e) => e.preventDefault()}` to stop focus loss before
      the click handler runs.
- [ ] `change` event consumers handle a `null` option (from the clear
      button), not just a populated selection.
