---
name: lit-avosignals-reactivity
description: >-
  Builds a Lit component with fine-grained reactivity using avosignals
  (Signal/Computed/effect + the SignalWatcher mixin), instead of Lit's default
  whole-render-on-any-property-change model. Use whenever building or updating a
  Lit web component that needs per-field/per-value reactive state — no backend,
  tenant server, or MCP-specific setup required.
tags:
  - lit
  - avosignals
  - frontend
  - reactive-state
  - web-components
trigger_phrases:
  - lit component
  - reactive lit state
  - avosignals
  - signal watcher
metadata:
  owner: personal
  status: stable
  extends: null
body: |-
  ## When to use

  Building or updating any Lit web component where you want fine-grained,
  per-value reactivity instead of Lit's default "re-render on any
  `@property`/`@state` change" model. Works standalone, with no backend,
  server, or MCP tooling involved.

  ## Where things live

  `avosignals` — an npm package (`avosignals`, e.g. `^1.0.16`), not
  workspace-local code. Source: `github.com/anatolipr/avos`, package dir
  `packages/avosignals`. It's a small reactive-state library (`Signal`,
  `Computed`, `effect`) with a Lit integration (`SignalWatcher`). Import it
  as:

  ```ts
  import { Signal, SignalWatcher } from 'avosignals';
  ```

  See `node_modules/avosignals/README.md` for the full API (`Signal.get()`/
  `.set()`/`.update()`/`.value`, `Computed`, `effect`).

  ## Pattern

  1. Install `avosignals` as a normal dependency (`npm install avosignals`,
     or pull it from a CDN — see below).
  2. In your `LitElement` subclass, call `new SignalWatcher(this)` once in
     the constructor. This makes the component re-render automatically
     whenever any `Signal` it reads during `render()` changes — no manual
     `requestUpdate()` needed.
  3. Create one `Signal` per piece of reactive state, seeded with an
     initial value: `new Signal(initialValue)`.
  4. Read signals in `render()` via `.value` or `.get()` — `SignalWatcher`
     tracks which signals were read and re-renders only when those change.
  5. On user input or any state change, call `.set()` (or `.update()`) on
     the signal directly. No `@property`/`@state` decorators or manual
     diffing needed for signal-driven fields.
  6. Use `Computed` for derived values that depend on one or more signals,
     and `effect` for side effects that should re-run when their dependency
     signals change (e.g. logging, syncing to `localStorage`, calling an
     external API).

  ```ts
  import { LitElement, html } from 'lit';
  import { Signal, SignalWatcher } from 'avosignals';

  class MyCounter extends LitElement {
    #count = new Signal(0);

    constructor() {
      super();
      new SignalWatcher(this);
    }

    render() {
      return html`
        <button @click=${() => this.#count.update(n => n + 1)}>
          Count: ${this.#count.value}
        </button>
      `;
    }
  }
  ```

  ## No-build / CDN variant

  For a quick demo or prototype, skip the package install and load `lit`
  and `avosignals` straight from a CDN as ES modules in a single HTML
  file — no `package.json`, no bundler:

  ```html
  <script type="module">
    // esm.sh — resolves bare specifiers and transpiles on the fly
    import { LitElement, html, css } from 'https://esm.sh/lit@3';
    import { Signal, SignalWatcher } from 'https://esm.sh/avosignals@1';

    // or jsdelivr's ESM build:
    // import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';
    // import { Signal, SignalWatcher } from 'https://cdn.jsdelivr.net/npm/avosignals@1/+esm';
  </script>
  ```

  Both host pre-built ESM and satisfy nested bare-specifier imports (e.g.
  Lit's internal `lit-html`/`lit-element`/`@lit/reactive-element` deps)
  without a resolver. Notes:

  - Pin a major version (`lit@3`, `avosignals@1`) so a CDN update can't
    silently change behavior.
  - esm.sh tends to have snappier cold-start transpilation and more
    granular per-export chunks; jsdelivr's `+esm` endpoint is a simpler
    single-file bundle. Either is fine for a demo — pick one and stay
    consistent within a file.
  - Once a prototype built this way needs to ship for real, promote it
    into a proper package with `avosignals` as a normal dependency.

  ## Syncing signals with an external source (optional)

  If a component's signals need to mirror state from somewhere else (a
  server, WebSocket, localStorage, another tab), the pattern is the
  same regardless of transport: on receiving an external update, call
  `.set()` on the matching signal; on local user input, call `.set()` and
  then push the new value out over whatever channel you're using. This
  skill only covers the Lit/avosignals half — the transport itself (WS
  server, polling, storage events, etc.) is a separate concern and not
  prescribed here.

  ## Why

  `avosignals` gives fine-grained per-value reactivity without diffing an
  entire component's properties on every change — useful for forms, large
  component trees, or anything with many independently-changing pieces of
  state. `SignalWatcher` is the only integration point needed to make a
  plain `LitElement` reactive to signals; everything else is standard Lit.
---
## When to use

Building or updating any Lit web component where you want fine-grained,
per-value reactivity instead of Lit's default "re-render on any
`@property`/`@state` change" model. Works standalone, with no backend,
server, or MCP tooling involved.

## Where things live

`avosignals` — an npm package (`avosignals`, e.g. `^1.0.16`), not
workspace-local code. Source: `github.com/anatolipr/avos`, package dir
`packages/avosignals`. It's a small reactive-state library (`Signal`,
`Computed`, `effect`) with a Lit integration (`SignalWatcher`). Import it
as:

```ts
import { Signal, SignalWatcher } from 'avosignals';
```

See `node_modules/avosignals/README.md` for the full API (`Signal.get()`/
`.set()`/`.update()`/`.value`, `Computed`, `effect`).

## Pattern

1. Install `avosignals` as a normal dependency (`npm install avosignals`,
   or pull it from a CDN — see below).
2. In your `LitElement` subclass, call `new SignalWatcher(this)` once in
   the constructor. This makes the component re-render automatically
   whenever any `Signal` it reads during `render()` changes — no manual
   `requestUpdate()` needed.
3. Create one `Signal` per piece of reactive state, seeded with an
   initial value: `new Signal(initialValue)`.
4. Read signals in `render()` via `.value` or `.get()` — `SignalWatcher`
   tracks which signals were read and re-renders only when those change.
5. On user input or any state change, call `.set()` (or `.update()`) on
   the signal directly. No `@property`/`@state` decorators or manual
   diffing needed for signal-driven fields.
6. Use `Computed` for derived values that depend on one or more signals,
   and `effect` for side effects that should re-run when their dependency
   signals change (e.g. logging, syncing to `localStorage`, calling an
   external API).

```ts
import { LitElement, html } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';

class MyCounter extends LitElement {
  #count = new Signal(0);

  constructor() {
    super();
    new SignalWatcher(this);
  }

  render() {
    return html`
      <button @click=${() => this.#count.update(n => n + 1)}>
        Count: ${this.#count.value}
      </button>
    `;
  }
}
```

## No-build / CDN variant

For a quick demo or prototype, skip the package install and load `lit`
and `avosignals` straight from a CDN as ES modules in a single HTML
file — no `package.json`, no bundler:

```html
<script type="module">
  // esm.sh — resolves bare specifiers and transpiles on the fly
  import { LitElement, html, css } from 'https://esm.sh/lit@3';
  import { Signal, SignalWatcher } from 'https://esm.sh/avosignals@1';

  // or jsdelivr's ESM build:
  // import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';
  // import { Signal, SignalWatcher } from 'https://cdn.jsdelivr.net/npm/avosignals@1/+esm';
</script>
```

Both host pre-built ESM and satisfy nested bare-specifier imports (e.g.
Lit's internal `lit-html`/`lit-element`/`@lit/reactive-element` deps)
without a resolver. Notes:

- Pin a major version (`lit@3`, `avosignals@1`) so a CDN update can't
  silently change behavior.
- esm.sh tends to have snappier cold-start transpilation and more
  granular per-export chunks; jsdelivr's `+esm` endpoint is a simpler
  single-file bundle. Either is fine for a demo — pick one and stay
  consistent within a file.
- Once a prototype built this way needs to ship for real, promote it
  into a proper package with `avosignals` as a normal dependency.

## Syncing signals with an external source (optional)

If a component's signals need to mirror state from somewhere else (a
server, WebSocket, localStorage, another tab), the pattern is the
same regardless of transport: on receiving an external update, call
`.set()` on the matching signal; on local user input, call `.set()` and
then push the new value out over whatever channel you're using. This
skill only covers the Lit/avosignals half — the transport itself (WS
server, polling, storage events, etc.) is a separate concern and not
prescribed here.

## Why

`avosignals` gives fine-grained per-value reactivity without diffing an
entire component's properties on every change — useful for forms, large
component trees, or anything with many independently-changing pieces of
state. `SignalWatcher` is the only integration point needed to make a
plain `LitElement` reactive to signals; everything else is standard Lit.
