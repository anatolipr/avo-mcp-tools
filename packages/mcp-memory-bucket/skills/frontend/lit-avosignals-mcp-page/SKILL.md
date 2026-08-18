---
name: lit-avosignals-mcp-page
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
  owner: company
  status: stable
  extends: null
body: |-
  ## When to use

  Building a browser page whose content/state should be readable and
  writable live by an MCP-connected agent, in this workspace
  (`avo-mcp-tools-workspace`). Worked example: `packages/mcp-form`.

  ## Where things actually live

  - **`avosignals`** — an npm package (`avosignals`, currently `^1.0.16` in
    this workspace), not workspace-local code. Source:
    `github.com/anatolipr/avos`, package dir `packages/avosignals`. It's a
    small reactive-state library (`Signal`, `Computed`, `effect`) with a
    Lit integration (`SignalWatcher`). Import it as
    `import { Signal, SignalWatcher } from 'avosignals';` — see
    `packages/mcp-form/src/client/mcp-form.ts:1-2` for the real import, and
    `node_modules/avosignals/README.md` for the full API (`Signal.get()`/
    `.set()`/`.update()`/`.value`, `Computed`, `effect`).
  - **`@avo-mcp-tools/mcp-tenant-server`** — workspace-local, at
    `packages/mcp-tenant-server/`. Owns tenant bookkeeping, the HTTP+WS
    server, static file serving, and the client-side WS bridge. See its
    `AGENTS.md` for the full Pattern A/B walkthrough this skill summarizes.
    `avosignals` is NOT wired into `mcp-tenant-server` itself — the two are
    independent. `mcp-tenant-server`'s `tenant().store.set(field, value)`
    broadcasts a `{type: 'update', field, value}` WS message; it's the
    **client** code that chooses to mirror incoming field updates into
    `avosignals` `Signal`s for reactive Lit rendering. You could swap in
    plain Lit reactive properties instead — `avosignals` is a rendering
    choice, not a requirement of the WS protocol.

  ## Pattern

  Follow `packages/mcp-tenant-server/AGENTS.md` Pattern A; concretely, per
  the working `mcp-form` example:

  1. Scaffold `packages/<name>/` copying `packages/mcp-form` as a template
     (`package.json`, `tsconfig.*.json`, `vite.config.ts`, `public/index.html`).
  2. Define state shape in `src/types.ts` — `{ TSchema, TValues }`.
  3. Define `ToolDef[]` in `src/tools/*.ts` (see
     `packages/mcp-form/src/tools/field-tools.ts`,
     `packages/mcp-form/src/tools/form-tools.ts`) — plain
     `{ name, description, schema, handler }` objects where `handler` calls
     `tenant().store.set(field, value)` to both mutate state and broadcast
     the change.
  4. Register tools via `registerXTools(mcp, tenant, port)`
     (`packages/mcp-form/src/tools/register.ts`).
  5. Wire `src/server.ts` with `createHttpServer` + `attachWebSocketServer`
     from `@avo-mcp-tools/mcp-tenant-server` (copy
     `packages/mcp-form/src/server.ts`).
  6. Client entry (`src/client/main.ts` / the root `LitElement`, e.g.
     `packages/mcp-form/src/client/mcp-form.ts`):
     - Open the WS connection by hand (`new WebSocket(...)`, tenant-scoped
       path `/ws?tenant=<id>` derived from `location.pathname`) — see
       `mcp-form.ts:431-468` `_connect()` for the exact reconnect-on-close
       pattern used today, or use `connectStateSocket` from
       `@avo-mcp-tools/mcp-tenant-server/client` for the same thing
       pre-wired (per `mcp-tenant-server/AGENTS.md` step 6).
     - Call `new SignalWatcher(this)` once in the component constructor —
       this makes the Lit component re-render automatically whenever any
       `Signal` it reads during `render()` changes (`mcp-form.ts:422`).
     - On the WS `init`/`reinit` message, create one `Signal` per field
       seeded from server state (`mcp-form.ts:474-488`,
       `_applyFormDef()`): `new Signal(state[f.name] ?? f.default ?? '')`.
     - On the WS `update` message, find the matching `Signal` and call
       `.set(msg.value)` (`mcp-form.ts:463-466`) — `SignalWatcher` picks
       this up and re-renders automatically, no manual `requestUpdate()`
       needed for signal-driven fields.
     - On local user input, call `.set()` on the signal AND send a
       `{type: 'set', field, value}` message back over the WS
       (`mcp-form.ts:490-492`, `_onInput()`) so the server-side state and
       other connected clients stay in sync too.

  ## No-build / standalone variant (CDN via esm.sh or jsdelivr)

  For a quick demo, prototype, or anywhere a Vite build step is overkill,
  skip the package scaffold and load `lit` (and `avosignals`, if a real
  backend is wired up) straight from a CDN as ES modules in a single HTML
  file — no `package.json`, no bundler:

  ```html
  <script type="module">
    // esm.sh — resolves bare specifiers and transpiles on the fly
    import { LitElement, html, css } from 'https://esm.sh/lit@3';
    // or jsdelivr's ESM build:
    // import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

    // avosignals the same way, when pairing with a real mcp-tenant-server backend:
    // import { Signal, SignalWatcher } from 'https://esm.sh/avosignals@1';
    // import { Signal, SignalWatcher } from 'https://cdn.jsdelivr.net/npm/avosignals@1/+esm';
  </script>
  ```

  Both host pre-built ESM and satisfy nested bare-specifier imports (e.g.
  Lit's internal `lit-html`/`lit-element`/`@lit/reactive-element` deps)
  without a resolver, so either works as a drop-in for local iteration.
  Notes:

  - Pin a major version (`lit@3`, `avosignals@1`) so a CDN update can't
    silently change behavior.
  - esm.sh tends to have snappier cold-start transpilation and more
    granular per-export chunks; jsdelivr's `+esm` endpoint is a simpler
    single-file bundle. Either is fine for a demo — pick one and stay
    consistent within a file.
  - This variant has no real WebSocket to an `mcp-tenant-server` tenant
    unless you stand one up separately; for a fully offline demo, simulate
    server pushes locally (e.g. a `setInterval` calling `.set()` on a
    `Signal`) in place of the WS `update` handler described above.
  - Once a prototype built this way needs real MCP tool control, promote
    it into a proper `packages/<name>/` following the Pattern section
    above — the CDN variant is for iteration, not the checked-in shape.

  ## Why

  `mcp-tenant-server` already handles tenant bookkeeping, WS broadcast, and
  static file serving — don't hand-roll a new HTTP/WS layer per package.
  `avosignals` gives fine-grained per-field reactivity without diffing the
  whole form on every WS message. Only reach for this combination when the
  package needs a live, agent-editable browser page; a plain MCP tool
  server with no UI (see `mcp-memory-bucket` itself) should skip both and
  use `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`
  directly instead.
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
