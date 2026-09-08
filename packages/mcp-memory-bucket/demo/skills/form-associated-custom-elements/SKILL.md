---
name: form-associated-custom-elements
description: >-
  Build a custom element (Lit or vanilla) that behaves like a real form control
  — participates in native form submission/reset/FormData, gets
  :invalid/:required/:disabled styling and label-for association via
  ElementInternals, and exposes custom UI states (checked, indeterminate,
  invalid) to CSS via :state() instead of attribute/class selectors. Covers
  static formAssociated = true, attachInternals(), setFormValue(),
  setValidity(), CustomStateSet (internals.states.add/delete), and the ::part()
  + :state() combo for styling a shadow-DOM-internal part off host state. Use
  whenever building a custom checkbox/toggle/switch/rating/slider that should
  submit inside a form, or whenever a component needs CSS-visible custom states
  (loading, invalid, checked) without an attribute or class that JS has to keep
  in sync.
tags:
  - custom-elements
  - web-components
  - attachInternals
  - elementinternals
  - state-pseudo-class
  - forms
  - accessibility
  - frontend
trigger_phrases:
  - attachInternals
  - ElementInternals
  - form-associated custom element
  - custom checkbox
  - custom toggle
  - ':state()'
  - CustomStateSet
  - custom form control
  - make a checkbox
metadata:
  owner: null
  status: unreviewed
  extends: null
  group: anatoli
created_at: '2026-09-08T14:45:34.658Z'
body: >-
  ## Two separate mechanisms, usually used together


  - **`ElementInternals` / form association** — makes a custom element behave
  like a real `<input>`/`<select>` for `<form>` purposes: it participates in
  `FormData` on submit, native `reset()`, `:required`/`:disabled` inheritance,
  and `<label for="...">` click-to-focus. Opt in with `static formAssociated =
  true` + `this._internals = this.attachInternals()`.

  - **`:state()` / `CustomStateSet`** — lets *any* autonomous custom element
  (form-associated or not) expose custom boolean-ish states to CSS, both from
  outside (`my-el:state(checked) { ... }`) and from an internal shadow part
  (`my-el::part(box):state(checked) { ... }`). It's the standards-based
  replacement for toggling a class or a `checked` attribute just so CSS can
  react to it — no attribute reflection code, and it's invisible to
  `element.checked`/JS unless you also expose a property.


  A component can use `:state()` without form association (a non-form widget
  like a tab or accordion item that just needs CSS-visible open/active state),
  and it can use form association without custom `:state()` (a plain text-like
  input that just needs `setFormValue()`). But a real custom form control —
  checkbox, toggle, star rating — almost always wants both: form association so
  it submits, `:state()` so `:checked`-equivalent styling works without a stray
  attribute.


  ## `attachInternals()` and form participation


  ```js

  class MyToggle extends HTMLElement {
    static formAssociated = true; // opts into ElementInternals + form lifecycle callbacks

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `<div part="box"></div>`;
      this._internals = this.attachInternals(); // MUST be called after super(), fine in the constructor
      this._checked = false;
    }

    connectedCallback() {
      this.addEventListener('click', () => this.toggle());
    }

    get checked() { return this._checked; }
    set checked(v) { this._setChecked(!!v); }

    toggle() { this._setChecked(!this._checked); }

    _setChecked(value) {
      this._checked = value;
      // setFormValue is what makes this element show up in FormData/submit.
      // Pass null to submit nothing (like an unchecked native checkbox).
      this._internals.setFormValue(value ? 'on' : null);
      this._internals.states[value ? 'add' : 'delete']('checked'); // see :state() below
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Native form lifecycle callbacks ElementInternals wires up for you —
    // implement whichever apply, the platform calls them automatically:
    formResetCallback() { this._setChecked(false); }
    formDisabledCallback(disabled) { this.toggleAttribute('disabled', disabled); }
    formStateRestoreCallback(state) { this._setChecked(state === 'on'); } // bfcache / autofill restore
  }

  customElements.define('my-toggle', MyToggle);

  ```


  Key points:


  - `static formAssociated = true` is what makes `attachInternals()` return a
  real `ElementInternals` instead of throwing — without it the element is just a
  normal (non-form-participating) custom element.

  - `setFormValue(value)` is the actual "this is my current value for
  `FormData`" call — nothing submits without it, no matter how the UI looks.
  Pass a `File`/`FormData` for complex values, a string for simple ones, or
  `null` to submit nothing (unchecked-checkbox behavior).

  - `setValidity(flags, message, anchor)` opts into the constraint-validation
  API (`:invalid`, `:required` styling, native `reportValidity()` bubble) — only
  add this if the control genuinely has a valid/invalid distinction; skip it for
  something like a toggle that's always "valid."

  - `ElementInternals` also gives you `internals.form`, `internals.labels` (the
  `<label for>`s pointing at this element — clicking one calls the element's
  `click()`), `internals.role`/ARIA reflection properties (`ariaChecked`, etc. —
  set these alongside `:state()` so assistive tech and CSS agree), and
  `internals.willValidate`.

  - **Attribute vs. property vs. form value are three different things** — don't
  conflate them. `checked` as a JS property is for programmatic access;
  `setFormValue()` is what the browser actually submits; neither one is what
  `:state()` exposes to CSS (that's a third, separate call). A control can have
  any one of these without the others.


  ## `:state()` and `CustomStateSet`


  `internals.states` (an `ElementInternals` created via `attachInternals()`,
  form-associated or not) is a `CustomStateSet` — a `Set`-like API for custom
  states:


  ```js

  this._internals.states.add('checked');     // now matches :state(checked)

  this._internals.states.delete('checked');  // no longer matches

  this._internals.states.has('checked');     // read it back

  ```


  Match it from outside the component, same specificity tier as a pseudo-class:


  ```css

  my-toggle:state(checked) { /* host-level styling when checked */ }

  ```


  Match it on an **internal shadow part** by chaining after `::part()` — this is
  the combination from the demo HTML in this conversation, and the reason it's
  easy to miss: `:state()` normally only applies to the *host* element (only the
  host has an `ElementInternals`), so styling a part *by* a host state requires
  the `::part(name):state(...)` chain, not a bare `:state()` inside the part's
  own shadow stylesheet:


  ```css

  my-custom-toggle::part(box):state(checked) {
    background-color: #007bff;
    border-color: #0056b3;
  }

  my-custom-toggle::part(box):state(checked)::after {
    content: '✓';
  }

  ```


  State names are plain identifiers (no leading `--`, unlike older custom-state
  proposals) and are scoped per-element-instance — they don't leak into global
  CSS custom-state namespaces and don't collide between unrelated components
  using the same name.


  **Why `:state()` over a reflected attribute/class**, and when a plain
  attribute is still fine:


  - No reflection boilerplate: a class-based approach needs
  `classList.toggle('checked', value)` kept in sync by hand on every mutation
  path (click, `formResetCallback`, `formStateRestoreCallback`, external
  `.checked = ...` setter) — miss one path and CSS silently drifts from actual
  state. `internals.states.add/delete` is just as manual to call, but it's the
  one call sites already need to make for form participation to work, so there's
  no *separate* sync step.

  - Not attribute-observable, which is a feature here: `:state()` can't be set
  or read from outside via `setAttribute`/`getAttribute`, so it can't be spoofed
  or interfered with by consumer code the way `[checked]` can — the only way to
  enter a custom state is the component's own method calling
  `internals.states.add`.

  - Reach for a plain reflected boolean attribute instead when consumer code
  genuinely needs to read or set the state via the DOM/HTML (e.g. `<my-el
  disabled>` in markup, or `el.hasAttribute('open')` from outside) — `:state()`
  alone gives you CSS matching, not an HTML-settable attribute or a JS-readable
  property, so a component often exposes **both**: an attribute/property for the
  public API, `:state()` purely for CSS.


  ## Worked example: a checkbox-like toggle, end to end


  This ties both mechanisms together on one component — form association makes
  it submit, `:state()` makes `::part(box)` react to checked without a class:


  ```js

  class MyToggle extends HTMLElement {
    static formAssociated = true;

    constructor() {
      super();
      const shadow = this.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { display: inline-block; cursor: pointer; }
          [part="box"] { width: 30px; height: 30px; border: 2px solid #ccc; border-radius: 6px; }
          [part="box"]:state(checked) { background: #007bff; } /* only works INSIDE the shadow root as :host-relative; from outside use ::part(box):state(checked) */
        </style>
        <div part="box"></div>
      `;
      this._internals = this.attachInternals();
      this._internals.role = 'checkbox'; // ARIA: pairs with ariaChecked below so a11y matches the visual state
      this.tabIndex = 0;
      this.addEventListener('click', () => this.toggle());
      this.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.toggle(); }
      });
    }

    get checked() { return this._internals.states.has('checked'); }
    set checked(v) { this._setChecked(!!v); }

    toggle() { this._setChecked(!this.checked); }

    _setChecked(value) {
      this._internals.states[value ? 'add' : 'delete']('checked');
      this._internals.ariaChecked = String(value);
      this._internals.setFormValue(value ? 'on' : null);
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }

    formResetCallback() { this._setChecked(false); }
    formStateRestoreCallback(state) { this._setChecked(state === 'on'); }
  }

  customElements.define('my-toggle', MyToggle);

  ```


  Note the internal `[part="box"]:state(checked)` rule inside the shadow
  stylesheet above — `:state()` used *bare* (not chained after `::part()`)
  inside the component's own shadow root matches `:host`'s states directly on
  any selector, since the element's own `ElementInternals` states are implicitly
  available there; it's only from **outside** the shadow root that you need the
  `::part(name):state(...)` chain shown in the previous section.


  ## Checklist


  - [ ] `static formAssociated = true` is set if this control should participate
  in `<form>` submission, `reset()`, or `:required`/`:disabled` — omit it for a
  non-form widget (tabs, accordion) that only needs `:state()`.

  - [ ] `attachInternals()` is called once, stored on `this`, not re-called on
  every render/update.

  - [ ] `setFormValue()` is called on every state change that should affect what
  gets submitted — a control that only updates its visual state without calling
  this will look right but submit nothing (or a stale value).

  - [ ] `formResetCallback`/`formStateRestoreCallback` are implemented if the
  control has meaningful reset/bfcache-restore behavior — without them, a native
  `<form>` reset silently leaves this control's visual state stuck.

  - [ ] ARIA (`internals.role`, `internals.ariaChecked`/`ariaExpanded`/etc.) is
  set alongside the matching `:state()` call, not instead of it — `:state()` is
  CSS-only and invisible to assistive tech.

  - [ ] Styling a shadow-internal `part` by host state uses
  `::part(name):state(...)` from outside the shadow root; a bare `:state(...)`
  selector only works on `:host`-relative selectors written *inside* the
  component's own shadow stylesheet.

  - [ ] If both a reflected attribute/property and a `:state()` exist for the
  same concept (e.g. a public `disabled` property plus an internal
  `:state(disabled)`), consumer-facing markup/JS uses the attribute/property;
  `:state()` is there purely so CSS doesn't need a class to react.


  ## Related gap in this project's existing input components


  [[lit-tag-input]] and [[lit-autocomplete-combobox]] both build custom-element
  form-like inputs (a `value` getter/property, a `change` event) but neither
  calls `attachInternals()` — so neither participates in native `<form>`
  submission/`FormData`, gets `:invalid`/`:disabled` styling for free, or
  supports `<label for="...">` click-to-focus. This is a known, accepted gap for
  now (not scheduled for a retrofit) — if a future consumer needs one of those
  two components to behave like a first-class form control (native submit, label
  association), that's the point to revisit form association on it, using this
  skill's pattern.
---
## Two separate mechanisms, usually used together

- **`ElementInternals` / form association** — makes a custom element behave like a real `<input>`/`<select>` for `<form>` purposes: it participates in `FormData` on submit, native `reset()`, `:required`/`:disabled` inheritance, and `<label for="...">` click-to-focus. Opt in with `static formAssociated = true` + `this._internals = this.attachInternals()`.
- **`:state()` / `CustomStateSet`** — lets *any* autonomous custom element (form-associated or not) expose custom boolean-ish states to CSS, both from outside (`my-el:state(checked) { ... }`) and from an internal shadow part (`my-el::part(box):state(checked) { ... }`). It's the standards-based replacement for toggling a class or a `checked` attribute just so CSS can react to it — no attribute reflection code, and it's invisible to `element.checked`/JS unless you also expose a property.

A component can use `:state()` without form association (a non-form widget like a tab or accordion item that just needs CSS-visible open/active state), and it can use form association without custom `:state()` (a plain text-like input that just needs `setFormValue()`). But a real custom form control — checkbox, toggle, star rating — almost always wants both: form association so it submits, `:state()` so `:checked`-equivalent styling works without a stray attribute.

## `attachInternals()` and form participation

```js
class MyToggle extends HTMLElement {
  static formAssociated = true; // opts into ElementInternals + form lifecycle callbacks

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<div part="box"></div>`;
    this._internals = this.attachInternals(); // MUST be called after super(), fine in the constructor
    this._checked = false;
  }

  connectedCallback() {
    this.addEventListener('click', () => this.toggle());
  }

  get checked() { return this._checked; }
  set checked(v) { this._setChecked(!!v); }

  toggle() { this._setChecked(!this._checked); }

  _setChecked(value) {
    this._checked = value;
    // setFormValue is what makes this element show up in FormData/submit.
    // Pass null to submit nothing (like an unchecked native checkbox).
    this._internals.setFormValue(value ? 'on' : null);
    this._internals.states[value ? 'add' : 'delete']('checked'); // see :state() below
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Native form lifecycle callbacks ElementInternals wires up for you —
  // implement whichever apply, the platform calls them automatically:
  formResetCallback() { this._setChecked(false); }
  formDisabledCallback(disabled) { this.toggleAttribute('disabled', disabled); }
  formStateRestoreCallback(state) { this._setChecked(state === 'on'); } // bfcache / autofill restore
}
customElements.define('my-toggle', MyToggle);
```

Key points:

- `static formAssociated = true` is what makes `attachInternals()` return a real `ElementInternals` instead of throwing — without it the element is just a normal (non-form-participating) custom element.
- `setFormValue(value)` is the actual "this is my current value for `FormData`" call — nothing submits without it, no matter how the UI looks. Pass a `File`/`FormData` for complex values, a string for simple ones, or `null` to submit nothing (unchecked-checkbox behavior).
- `setValidity(flags, message, anchor)` opts into the constraint-validation API (`:invalid`, `:required` styling, native `reportValidity()` bubble) — only add this if the control genuinely has a valid/invalid distinction; skip it for something like a toggle that's always "valid."
- `ElementInternals` also gives you `internals.form`, `internals.labels` (the `<label for>`s pointing at this element — clicking one calls the element's `click()`), `internals.role`/ARIA reflection properties (`ariaChecked`, etc. — set these alongside `:state()` so assistive tech and CSS agree), and `internals.willValidate`.
- **Attribute vs. property vs. form value are three different things** — don't conflate them. `checked` as a JS property is for programmatic access; `setFormValue()` is what the browser actually submits; neither one is what `:state()` exposes to CSS (that's a third, separate call). A control can have any one of these without the others.

## `:state()` and `CustomStateSet`

`internals.states` (an `ElementInternals` created via `attachInternals()`, form-associated or not) is a `CustomStateSet` — a `Set`-like API for custom states:

```js
this._internals.states.add('checked');     // now matches :state(checked)
this._internals.states.delete('checked');  // no longer matches
this._internals.states.has('checked');     // read it back
```

Match it from outside the component, same specificity tier as a pseudo-class:

```css
my-toggle:state(checked) { /* host-level styling when checked */ }
```

Match it on an **internal shadow part** by chaining after `::part()` — this is the combination from the demo HTML in this conversation, and the reason it's easy to miss: `:state()` normally only applies to the *host* element (only the host has an `ElementInternals`), so styling a part *by* a host state requires the `::part(name):state(...)` chain, not a bare `:state()` inside the part's own shadow stylesheet:

```css
my-custom-toggle::part(box):state(checked) {
  background-color: #007bff;
  border-color: #0056b3;
}
my-custom-toggle::part(box):state(checked)::after {
  content: '✓';
}
```

State names are plain identifiers (no leading `--`, unlike older custom-state proposals) and are scoped per-element-instance — they don't leak into global CSS custom-state namespaces and don't collide between unrelated components using the same name.

**Why `:state()` over a reflected attribute/class**, and when a plain attribute is still fine:

- No reflection boilerplate: a class-based approach needs `classList.toggle('checked', value)` kept in sync by hand on every mutation path (click, `formResetCallback`, `formStateRestoreCallback`, external `.checked = ...` setter) — miss one path and CSS silently drifts from actual state. `internals.states.add/delete` is just as manual to call, but it's the one call sites already need to make for form participation to work, so there's no *separate* sync step.
- Not attribute-observable, which is a feature here: `:state()` can't be set or read from outside via `setAttribute`/`getAttribute`, so it can't be spoofed or interfered with by consumer code the way `[checked]` can — the only way to enter a custom state is the component's own method calling `internals.states.add`.
- Reach for a plain reflected boolean attribute instead when consumer code genuinely needs to read or set the state via the DOM/HTML (e.g. `<my-el disabled>` in markup, or `el.hasAttribute('open')` from outside) — `:state()` alone gives you CSS matching, not an HTML-settable attribute or a JS-readable property, so a component often exposes **both**: an attribute/property for the public API, `:state()` purely for CSS.

## Worked example: a checkbox-like toggle, end to end

This ties both mechanisms together on one component — form association makes it submit, `:state()` makes `::part(box)` react to checked without a class:

```js
class MyToggle extends HTMLElement {
  static formAssociated = true;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { display: inline-block; cursor: pointer; }
        [part="box"] { width: 30px; height: 30px; border: 2px solid #ccc; border-radius: 6px; }
        [part="box"]:state(checked) { background: #007bff; } /* only works INSIDE the shadow root as :host-relative; from outside use ::part(box):state(checked) */
      </style>
      <div part="box"></div>
    `;
    this._internals = this.attachInternals();
    this._internals.role = 'checkbox'; // ARIA: pairs with ariaChecked below so a11y matches the visual state
    this.tabIndex = 0;
    this.addEventListener('click', () => this.toggle());
    this.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.toggle(); }
    });
  }

  get checked() { return this._internals.states.has('checked'); }
  set checked(v) { this._setChecked(!!v); }

  toggle() { this._setChecked(!this.checked); }

  _setChecked(value) {
    this._internals.states[value ? 'add' : 'delete']('checked');
    this._internals.ariaChecked = String(value);
    this._internals.setFormValue(value ? 'on' : null);
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }

  formResetCallback() { this._setChecked(false); }
  formStateRestoreCallback(state) { this._setChecked(state === 'on'); }
}
customElements.define('my-toggle', MyToggle);
```

Note the internal `[part="box"]:state(checked)` rule inside the shadow stylesheet above — `:state()` used *bare* (not chained after `::part()`) inside the component's own shadow root matches `:host`'s states directly on any selector, since the element's own `ElementInternals` states are implicitly available there; it's only from **outside** the shadow root that you need the `::part(name):state(...)` chain shown in the previous section.

## Checklist

- [ ] `static formAssociated = true` is set if this control should participate in `<form>` submission, `reset()`, or `:required`/`:disabled` — omit it for a non-form widget (tabs, accordion) that only needs `:state()`.
- [ ] `attachInternals()` is called once, stored on `this`, not re-called on every render/update.
- [ ] `setFormValue()` is called on every state change that should affect what gets submitted — a control that only updates its visual state without calling this will look right but submit nothing (or a stale value).
- [ ] `formResetCallback`/`formStateRestoreCallback` are implemented if the control has meaningful reset/bfcache-restore behavior — without them, a native `<form>` reset silently leaves this control's visual state stuck.
- [ ] ARIA (`internals.role`, `internals.ariaChecked`/`ariaExpanded`/etc.) is set alongside the matching `:state()` call, not instead of it — `:state()` is CSS-only and invisible to assistive tech.
- [ ] Styling a shadow-internal `part` by host state uses `::part(name):state(...)` from outside the shadow root; a bare `:state(...)` selector only works on `:host`-relative selectors written *inside* the component's own shadow stylesheet.
- [ ] If both a reflected attribute/property and a `:state()` exist for the same concept (e.g. a public `disabled` property plus an internal `:state(disabled)`), consumer-facing markup/JS uses the attribute/property; `:state()` is there purely so CSS doesn't need a class to react.

## Related gap in this project's existing input components

[[lit-tag-input]] and [[lit-autocomplete-combobox]] both build custom-element form-like inputs (a `value` getter/property, a `change` event) but neither calls `attachInternals()` — so neither participates in native `<form>` submission/`FormData`, gets `:invalid`/`:disabled` styling for free, or supports `<label for="...">` click-to-focus. This is a known, accepted gap for now (not scheduled for a retrofit) — if a future consumer needs one of those two components to behave like a first-class form control (native submit, label association), that's the point to revisit form association on it, using this skill's pattern.
