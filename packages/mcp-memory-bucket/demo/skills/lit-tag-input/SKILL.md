---
name: lit-tag-input
description: >-
  Builds a multi-select tag/chip input in Lit — an autocomplete combobox (per
  lit-autocomplete-combobox) that commits picks as removable chips instead of
  replacing the input's text. Covers filtering out already-selected options,
  chip rendering with per-chip remove, keyboard affordances (comma to commit,
  Backspace-on-empty pops the last chip), why every handled keydown must
  stopPropagation (else Enter bubbles into a parent dialog's submit/run
  handler), not opening an empty suggestions menu, previewing the first N
  options on focus, and an inline "doesn't exist, add it?" create-new-tag row.
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
  - create new tag
  - doesn't exist add it
metadata:
  owner: personal
  status: stable
  extends: null
  group: anatoli
created_at: '2026-08-19T14:38:23.302Z'
body: >-
  ## Tag input in Lit


  This extends [[lit-autocomplete-combobox]]: same anchor-input +

  `popover="manual"` menu, same `position-anchor`/`flip-block` positioning

  from [[making-dropdowns]], same manual light-dismiss (`document`

  click listener) and blur-commit handling. Read those first — this only

  covers what changes when the combobox becomes **multi-select with

  removable chips** instead of single-select-replaces-text.


  Four deltas from the base combobox:


  ### Delta 1: state is an array of values, not one, and selected options drop
  out of the filtered list


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


  ### Delta 2: adding/removing a tag clears the query and re-opens the menu, it
  never "fills" the input


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


  ### Delta 3: extra keydown affordances — comma commits, Backspace-on-empty
  pops the last chip, and every handled key must stop propagation


  ```js

  _onKeydown(e) {
    const items = this._filtered;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      this._openMenu();
      if (items.length) this._highlighted.set((this._highlighted.value + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      this._openMenu();
      if (items.length) this._highlighted.set((this._highlighted.value - 1 + items.length) % items.length);
    } else if (e.key === ',' && this._query.value.trim()) {
      e.preventDefault();
      e.stopPropagation();
      this._commitHighlighted();
    } else if (e.key === 'Enter' && (this._highlighted.value >= 0 || this._query.value.trim())) {
      // Only intercept Enter when there's actually something to commit — a
      // highlighted option or typed text. A tag input very often lives
      // inside a larger form/dialog whose own keydown handler treats Enter
      // as "submit" (see the parent-dialog note below); an unconditional
      // e.preventDefault()/stopPropagation() here would silently eat that
      // submit whenever the user tabs into an empty tag field and hits
      // Enter, which reads as a broken dialog, not a tag-input nicety.
      e.preventDefault();
      e.stopPropagation();
      this._commitHighlighted();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      this._closeMenu();
    } else if (e.key === 'Backspace' && this._query.value === '') {
      e.stopPropagation();
      this._removeLastTag();
    }
  }

  ```


  The `this._query.value === ''` guard on Backspace matters: without it,

  Backspace would eat the last chip *while the user is still editing

  text* in the input, instead of just deleting a character.


  **`e.stopPropagation()` on every branch that fires is not optional.**

  A tag input is almost always a field inside a bigger dialog, and that

  dialog's own `@keydown` handler commonly maps Enter to "confirm/save"

  or even "run this action right now." Without `stopPropagation()`,

  picking a highlighted suggestion with Enter also bubbles the same

  keydown up to the dialog, which then immediately submits/runs whatever

  the dialog does — from the user's perspective, selecting a tag

  suggestion appears to randomly trigger the parent action. This is easy

  to miss in isolated testing (a tag input with no parent dialog has

  nothing to leak into) and only shows up once it's embedded in a real

  form — test it inside its actual parent dialog, not standalone.


  ### Delta 4: don't show an empty menu, and offer to create the tag when
  nothing matches


  Two related UX gaps if you stop at delta 1–3: focusing an empty input

  opens a popover with *nothing in it* (every option got excluded because

  it's already selected, or the field simply has no candidates yet) —

  which reads as a rendering bug, not "no suggestions." And typing a

  query that matches nothing gives no way to actually add that value as a

  new tag, even though tag inputs are almost always meant to accept

  arbitrary free-form values, not just picks from a fixed list.


  ```js

  get _canCreate() {
    const q = this._query.value.trim();
    if (!q) return false;
    const selected = new Set(this._selected.value);
    if (selected.has(q)) return false;
    return !this.options.some((o) => o.label.toLowerCase() === q.toLowerCase());
  }


  _openMenu() {
    // Guard at the open call site, not just in render — otherwise focusing
    // an input with nothing to offer still flashes an empty popover open
    // for one frame before a later render decides to close it again.
    if (this._filtered.length === 0 && !this._canCreate) return;
    this._open.set(true);
    this.updateComplete.then(() => {
      this.renderRoot.querySelector('.menu')?.showPopover();
    });
  }


  _commitHighlighted() {
    const items = this._filtered;
    const highlighted = this._highlighted.value;
    if (highlighted >= 0 && items[highlighted]) {
      this._addTag(items[highlighted]);
    } else if (this._query.value.trim()) {
      // No option highlighted but there's typed text — commit it as a new
      // tag (covers both "user typed a novel value and hit Enter" and
      // clicking the create row below, which passes the raw query the
      // same way).
      this._addTag({ value: this._query.value.trim(), label: this._query.value.trim() });
    }
  }

  ```


  Render: still close a menu that's open but has become empty (e.g. the

  user kept typing past the last matching character and the value isn't

  creatable for some reason), and append a distinctly-styled "create" row

  when `_canCreate` is true — treat it as one more item in the same

  highlight index space as the real options (`items.length` is its index):


  ```js

  render() {
    const items = this._filtered;
    const canCreate = this._canCreate;
    if (this._open.value && items.length === 0 && !canCreate) this._closeMenu();
    // ...
    return html`
      <!-- ...field markup unchanged... -->
      <ul class="menu" popover="manual" style=${`position-anchor: ${this._anchorName}`}>
        ${items.map((o, i) => html`
          <li class=${i === highlighted ? 'option highlighted' : 'option'}
              @mousedown=${(e) => e.preventDefault()}
              @click=${() => this._addTag(o)}
          >${o.label}</li>
        `)}
        ${canCreate ? html`
          <li class=${`option create-option ${items.length === highlighted ? 'highlighted' : ''}`}
              @mousedown=${(e) => e.preventDefault()}
              @click=${() => this._addTag({ value: this._query.value.trim(), label: this._query.value.trim() })}
          >"${this._query.value.trim()}" doesn't exist. Add it?</li>
        ` : ''}
      </ul>
    `;
  }

  ```


  And on the empty-query side: don't return `[]` for `_filtered` when the

  query is blank — return the first N unselected options instead, so

  focusing the field previews what's available rather than showing

  nothing until the user starts typing:


  ```js

  const MAX_SUGGESTIONS = 8;


  get _filtered() {
    const selected = new Set(this._selected.value);
    const available = this.options.filter((o) => !selected.has(o.value));
    const q = this._query.value.trim().toLowerCase();
    const matched = q ? available.filter((o) => o.label.toLowerCase().includes(q)) : available;
    return matched.slice(0, MAX_SUGGESTIONS);
  }

  ```


  ### Chip markup: rendered inline before the input, inside the same anchor
  container


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

  .create-option {
    font-style: italic;
  }

  ```


  Everything else — `.menu` popover positioning, `position-try-fallbacks:

  flip-block`, the document-click light-dismiss, the ARIA

  listbox/option roles on the menu items — is identical to

  [[lit-autocomplete-combobox]] and isn't repeated here.
status: stable
owner: personal
extends: null
group: anatoli
---
## Tag input in Lit

This extends [[lit-autocomplete-combobox]]: same anchor-input +
`popover="manual"` menu, same `position-anchor`/`flip-block` positioning
from [[making-dropdowns]], same manual light-dismiss (`document`
click listener) and blur-commit handling. Read those first — this only
covers what changes when the combobox becomes **multi-select with
removable chips** instead of single-select-replaces-text.

Four deltas from the base combobox:

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

### Delta 3: extra keydown affordances — comma commits, Backspace-on-empty pops the last chip, and every handled key must stop propagation

```js
_onKeydown(e) {
  const items = this._filtered;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    this._openMenu();
    if (items.length) this._highlighted.set((this._highlighted.value + 1) % items.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    this._openMenu();
    if (items.length) this._highlighted.set((this._highlighted.value - 1 + items.length) % items.length);
  } else if (e.key === ',' && this._query.value.trim()) {
    e.preventDefault();
    e.stopPropagation();
    this._commitHighlighted();
  } else if (e.key === 'Enter' && (this._highlighted.value >= 0 || this._query.value.trim())) {
    // Only intercept Enter when there's actually something to commit — a
    // highlighted option or typed text. A tag input very often lives
    // inside a larger form/dialog whose own keydown handler treats Enter
    // as "submit" (see the parent-dialog note below); an unconditional
    // e.preventDefault()/stopPropagation() here would silently eat that
    // submit whenever the user tabs into an empty tag field and hits
    // Enter, which reads as a broken dialog, not a tag-input nicety.
    e.preventDefault();
    e.stopPropagation();
    this._commitHighlighted();
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    this._closeMenu();
  } else if (e.key === 'Backspace' && this._query.value === '') {
    e.stopPropagation();
    this._removeLastTag();
  }
}
```

The `this._query.value === ''` guard on Backspace matters: without it,
Backspace would eat the last chip *while the user is still editing
text* in the input, instead of just deleting a character.

**`e.stopPropagation()` on every branch that fires is not optional.**
A tag input is almost always a field inside a bigger dialog, and that
dialog's own `@keydown` handler commonly maps Enter to "confirm/save"
or even "run this action right now." Without `stopPropagation()`,
picking a highlighted suggestion with Enter also bubbles the same
keydown up to the dialog, which then immediately submits/runs whatever
the dialog does — from the user's perspective, selecting a tag
suggestion appears to randomly trigger the parent action. This is easy
to miss in isolated testing (a tag input with no parent dialog has
nothing to leak into) and only shows up once it's embedded in a real
form — test it inside its actual parent dialog, not standalone.

### Delta 4: don't show an empty menu, and offer to create the tag when nothing matches

Two related UX gaps if you stop at delta 1–3: focusing an empty input
opens a popover with *nothing in it* (every option got excluded because
it's already selected, or the field simply has no candidates yet) —
which reads as a rendering bug, not "no suggestions." And typing a
query that matches nothing gives no way to actually add that value as a
new tag, even though tag inputs are almost always meant to accept
arbitrary free-form values, not just picks from a fixed list.

```js
get _canCreate() {
  const q = this._query.value.trim();
  if (!q) return false;
  const selected = new Set(this._selected.value);
  if (selected.has(q)) return false;
  return !this.options.some((o) => o.label.toLowerCase() === q.toLowerCase());
}

_openMenu() {
  // Guard at the open call site, not just in render — otherwise focusing
  // an input with nothing to offer still flashes an empty popover open
  // for one frame before a later render decides to close it again.
  if (this._filtered.length === 0 && !this._canCreate) return;
  this._open.set(true);
  this.updateComplete.then(() => {
    this.renderRoot.querySelector('.menu')?.showPopover();
  });
}

_commitHighlighted() {
  const items = this._filtered;
  const highlighted = this._highlighted.value;
  if (highlighted >= 0 && items[highlighted]) {
    this._addTag(items[highlighted]);
  } else if (this._query.value.trim()) {
    // No option highlighted but there's typed text — commit it as a new
    // tag (covers both "user typed a novel value and hit Enter" and
    // clicking the create row below, which passes the raw query the
    // same way).
    this._addTag({ value: this._query.value.trim(), label: this._query.value.trim() });
  }
}
```

Render: still close a menu that's open but has become empty (e.g. the
user kept typing past the last matching character and the value isn't
creatable for some reason), and append a distinctly-styled "create" row
when `_canCreate` is true — treat it as one more item in the same
highlight index space as the real options (`items.length` is its index):

```js
render() {
  const items = this._filtered;
  const canCreate = this._canCreate;
  if (this._open.value && items.length === 0 && !canCreate) this._closeMenu();
  // ...
  return html`
    <!-- ...field markup unchanged... -->
    <ul class="menu" popover="manual" style=${`position-anchor: ${this._anchorName}`}>
      ${items.map((o, i) => html`
        <li class=${i === highlighted ? 'option highlighted' : 'option'}
            @mousedown=${(e) => e.preventDefault()}
            @click=${() => this._addTag(o)}
        >${o.label}</li>
      `)}
      ${canCreate ? html`
        <li class=${`option create-option ${items.length === highlighted ? 'highlighted' : ''}`}
            @mousedown=${(e) => e.preventDefault()}
            @click=${() => this._addTag({ value: this._query.value.trim(), label: this._query.value.trim() })}
        >"${this._query.value.trim()}" doesn't exist. Add it?</li>
      ` : ''}
    </ul>
  `;
}
```

And on the empty-query side: don't return `[]` for `_filtered` when the
query is blank — return the first N unselected options instead, so
focusing the field previews what's available rather than showing
nothing until the user starts typing:

```js
const MAX_SUGGESTIONS = 8;

get _filtered() {
  const selected = new Set(this._selected.value);
  const available = this.options.filter((o) => !selected.has(o.value));
  const q = this._query.value.trim().toLowerCase();
  const matched = q ? available.filter((o) => o.label.toLowerCase().includes(q)) : available;
  return matched.slice(0, MAX_SUGGESTIONS);
}
```

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
.create-option {
  font-style: italic;
}
```

Everything else — `.menu` popover positioning, `position-try-fallbacks:
flip-block`, the document-click light-dismiss, the ARIA
listbox/option roles on the menu items — is identical to
[[lit-autocomplete-combobox]] and isn't repeated here.
