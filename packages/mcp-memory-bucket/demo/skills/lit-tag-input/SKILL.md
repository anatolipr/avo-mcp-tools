---
name: lit-tag-input
description: >-
  Builds a multi-select tag/chip input in Lit — an autocomplete combobox (per
  lit-autocomplete-combobox) that commits picks as removable chips instead of
  replacing the input's text. Covers the three deltas from a single-select
  combobox: filtering out already-selected options, rendering chips inline
  before the input with a per-chip remove button, and the extra keyboard
  affordances (comma to commit, Backspace-on-empty-input to pop the last chip).
  Use whenever building a tag picker, multi-select field, or "add items as
  chips" input in Lit.
tags:
  - lit
  - tag-input
  - chips
  - multi-select
  - combobox
  - popover
  - aria
  - frontend
  - web-components
trigger_phrases:
  - tag input
  - chip input
  - multi-select combobox
  - tag picker
  - add tags
  - lit tag input
metadata:
  owner: personal
  status: stable
  extends: null
deprecated: false
created_at: '2026-08-19T14:38:23.302Z'
---
## Tag input in Lit

This extends [[lit-autocomplete-combobox]]: same anchor-input +
`popover="manual"` menu, same `position-anchor`/`flip-block` positioning
from [[making-dropdowns]], same manual light-dismiss (`document`
click listener) and blur-commit handling. Read those first — this only
covers what changes when the combobox becomes **multi-select with
removable chips** instead of single-select-replaces-text.

Three deltas from the base combobox:

### Delta 1: state is an array of values, not one, and selected options drop out of the filtered list

```js
constructor() {
  super();
  this._selected = new Signal([]);   // array of option.value (string[])
  this._query = new Signal('');
  this._filterQuery = new Signal('');
  this._highlighted = new Signal(-1);
}

get value() { return this._selected.value; }

_optionByValue(v) { return this.options.find((o) => o.value === v); }

// Options not already selected, filtered by the active query.
get _filtered() {
  const selected = new Set(this._selected.value);
  const q = this._filterQuery.value.trim().toLowerCase();
  return this.options
    .filter((o) => !selected.has(o.value))
    .filter((o) => !q || o.label.toLowerCase().includes(q));
}
```

Excluding already-selected options from `_filtered` is what makes the
combobox behave like a picker instead of a plain autocomplete — without
it, picking the same option twice adds a duplicate chip.

### Delta 2: adding/removing a tag clears the query and re-opens the menu, it never "fills" the input

Unlike single-select (which writes the picked label into the input),
`_addTag` always resets the input back to empty so the user can keep
typing to add the next tag:

```js
_addTag(option) {
  this._selected.update((v) => [...v, option.value]);
  this._query.set('');
  this._filterQuery.set('');
  this._highlighted.set(-1);
  this._openMenu();          // stays open, now showing the remaining options
  this._emitChange();
}

_removeTag(value) {
  this._selected.update((v) => v.filter((x) => x !== value));
  this.renderRoot.querySelector('.input')?.focus();
  this._emitChange();
}

_removeLastTag() {
  if (!this._selected.value.length) return;
  this._selected.update((v) => v.slice(0, -1));
  this._emitChange();
}

_emitChange() {
  this.dispatchEvent(new CustomEvent('change', {
    detail: { value: this._selected.value },
    bubbles: true,
    composed: true,
  }));
}
```

`_commitHighlighted()` (shared by Enter/comma keydown and blur, same
pattern as the base combobox) just calls `_addTag(items[highlighted])`
when something is highlighted.

### Delta 3: extra keydown affordances — comma commits, Backspace-on-empty pops the last chip

```js
_onKeydown(e) {
  const items = this._filtered;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    this._openMenu();
    if (items.length) this._highlighted.set((this._highlighted.value + 1) % items.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    this._openMenu();
    if (items.length) this._highlighted.set((this._highlighted.value - 1 + items.length) % items.length);
  } else if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    this._commitHighlighted();
  } else if (e.key === 'Escape') {
    this._closeMenu();
  } else if (e.key === 'Backspace' && this._query.value === '') {
    this._removeLastTag();
  }
}
```

The `this._query.value === ''` guard matters: without it, Backspace
would eat the last chip *while the user is still editing text* in the
input, instead of just deleting a character.

### Chip markup: rendered inline before the input, inside the same anchor container

Chips and the `<input>` live in one flex container that carries the
`anchor-name` — the popover still anchors to this wrapper, not to the
bare input, so the menu's width/position track the whole field as it
grows with chips, not just the input's own box:

```js
render() {
  const items = this._filtered;
  const { value: open } = this._open;
  const { value: highlighted } = this._highlighted;
  const { value: selected } = this._selected;

  return html`
    <div class="field" style=${`anchor-name: ${this._anchorName}`}>
      ${selected.map((v) => {
        const opt = this._optionByValue(v);
        return html`
          <span class="chip">
            ${opt ? opt.label : v}
            <button class="chip-remove" tabindex="-1"
              @mousedown=${(e) => e.preventDefault()}
              @click=${() => this._removeTag(v)}
            >✕</button>
          </span>
        `;
      })}
      <input
        class="input"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded=${open}
        aria-controls=${this._listboxId}
        aria-activedescendant=${highlighted >= 0 ? `${this._listboxId}-opt-${highlighted}` : ''}
        placeholder=${selected.length ? '' : 'Add tags…'}
        .value=${this._query.value}
        @input=${this._onInput}
        @focus=${this._onFocus}
        @click=${this._onFocus}
        @keydown=${this._onKeydown}
        @blur=${this._onBlur}
      />
    </div>
    <!-- .menu / listbox markup is unchanged from lit-autocomplete-combobox -->
  `;
}
```

`tabindex="-1"` + `@mousedown=${(e) => e.preventDefault()}` on
`.chip-remove` matters for the same reason it does on options in the
base combobox: without preventing mousedown, the input blurs before the
click handler fires, and the blur-commit logic can interfere with the
removal.

### CSS delta: the field wraps, chips are flex children ahead of the input

```css
.field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  border: 1px solid #ccc;
  border-radius: 6px;
  padding: 4px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #eef2ff;
  border-radius: 4px;
  padding: 0.15rem 0.3rem 0.15rem 0.5rem;
}
.chip-remove {
  border: none;
  background: transparent;
  cursor: pointer;
}
.input {
  flex: 1;
  min-width: 80px;
  border: none;
  outline: none;
  background: transparent;
}
```

Everything else — `.menu` popover positioning, `position-try-fallbacks:
flip-block`, the document-click light-dismiss, the ARIA
listbox/option roles on the menu items — is identical to
[[lit-autocomplete-combobox]] and isn't repeated here.

