# Refactor plan: module split (Phase 1) toward reusable tenant/MCP server (Phase 2)

## Goal

Split `src/server.ts` (currently one 674-line file) into clearly separated
modules — generic tenant/session/transport plumbing vs. project-specific
MCP tools/schemas — **without changing package structure yet**. This phase
stays inside the current single-package repo (no workspaces, no new
`package.json` files). Once this is done, working, and tested, a follow-up
pass will physically move the generic half into its own package
(`packages/mcp-tenant-server`) per the design agreed below.

This document also records the design Q&A that produced these decisions,
so the reasoning survives independent of chat history.

---

## Design Q&A record

### Round 1 — module split mechanics

| Question | Answer |
|---|---|
| How should tools be registered? | **Data objects** (name/description/schema/handler) looped over by a registrar |
| File granularity for tools | **Grouped by concern**: `form-tools.ts` + `field-tools.ts` |
| Where should zod field-def schemas live? | **Colocated** with `define_form`'s tool file (only that tool uses them) |
| How should tool handlers access tenant state? | Keep current **closure pattern** — pass a `tenant()` getter into each registrar |
| Is unit-testing tool logic independent of MCP a goal? | **No** — purely file organization/readability |
| Scope for this pass | Also split **HTTP request handling** (static files, `/upload`, `/mcp` routing) into its own module |
| Other notes | End goal: extract a universal, tool-agnostic server module reusable for a second project (mock-UI-builder instead of forms) — server becomes a dependency, tools stay project-specific |

### Round 2 — architecture for eventual reusable server

| Question | Answer |
|---|---|
| Boundary between generic server and project tools | Server owns **even less** than first proposed: just tenant/session bookkeeping + raw MCP wiring. HTTP/WS/static-file serving stays per-project since UI differs (form vs. mock UI) — **this got refined further in the UI-delivery follow-up below, which pulls page-shell serving back into the server** |
| Store shape | **Generic `Store<T>`** holding any JSON-serializable state; project code defines the shape (not hardcoded flat string map) |
| How far to go toward reusable package this pass | "Go further" was picked (stub second project's shape too) — **superseded by the user's explicit sequencing decision below: module split first, package split later** |
| Static UI delivery | Two designs should both be supported long-term: (1) per-module **root element** definition that the server loads and injects into a server-owned shell; (2) server/backend **injected into a pre-existing page** to "AI-enable" it (opposite direction — project owns the page, server is a bolted-on capability) |
| Tool plugin shape | Server exports **`buildMcpServer(tenantId, registerFn)`** — project passes a function that registers its own tools |

### Round 3 — follow-ups

| Question | Answer |
|---|---|
| Near-term default for THIS repo (forms) between the two UI-delivery options | **Option 1** — server-owned shell, project supplies a root component (matches current Lit custom-element setup) |
| How to validate the boundary against a second (mock-UI) project | Create a **throwaway sibling folder** in this repo with a minimal fake mock-UI tool module, proving the server module works unmodified against it |
| Should the generic server become its own package.json folder now? | Originally: yes, treat as a real package from day one. **Overridden by user's final sequencing call**: do the in-repo module split first, prove it works, *then* do the package split as a separate follow-up phase |

### Final sequencing decision (explicit user instruction, supersedes "go further" answers above)

> "I think that it might make sense to split in different packages after the
> module split — we should split code here first — make sure it all works…
> then once done — we can proceed to next stage."

This plan therefore covers **Phase 1 only**: in-repo module split, all still
under one `package.json`, one `tsconfig` set, one `dist/`. Phase 2 (package
extraction, npm workspace, mock-UI stub as a real sibling package) is
out of scope here and just sketched at the end for continuity.

---

## Target file layout (Phase 1 — still one package)

```
src/
  server/
    tenant.ts          Tenant class, tenant registry (Map), getOrCreateTenant,
                        disposeTenant, idle-sweep interval. No MCP/HTTP imports.
    store.ts            Generic Store<T> (currently Store is string-only;
                        keep it string-only for THIS phase since fields.json
                        drives it — genericizing to Store<T> is a Phase 2
                        concern once the mock-UI shape actually exists).
                        NOTE: resolve this against "generic Store<T>" answer
                        above — see Open Question 1.
    http.ts             httpServer creation, static file serving, /upload
                        handler, /mcp session routing (POST/GET/DELETE),
                        mounts the WS server. Depends on tenant.ts + mcp.ts.
    ws.ts               WebSocketServer wiring: connection handling,
                        tenant lookup by ?tenant=, message dispatch
                        (set/submit/interrupt), broadcast helpers used by
                        Tenant (or move broadcast* methods here and have
                        Tenant call them — see Open Question 2).
    mcp.ts              buildMcpServer(tenantId, registerFn) — generic
                        McpServer construction + connect, delegates tool
                        registration to registerFn instead of hardcoding
                        the six mcp-form tools.
  tools/
    schemas.ts          fieldTypeEnum, subFieldTypeEnum, validationSchema,
                        subFieldDefSchema, fieldDefSchema.
                        (Per Q&A this was going to colocate with
                        form-tools.ts, but fieldDefSchema is also used by
                        field-tools.ts's list_fields output shape — see
                        Open Question 3 for final placement call.)
    form-tools.ts       get_form_url, define_form, wait_for_submit
                        (+ fieldDefSchema/subFieldDefSchema import)
    field-tools.ts      list_fields, get_field, set_field
    register.ts         registerFormTools(mcp, tenant, port) — the
                        registerFn passed into buildMcpServer, calls into
                        form-tools.ts + field-tools.ts.
  shared/
    types.ts            unchanged
  client/                unchanged
  server.ts              shrinks to: read config/fields.json, wire
                        tenant.ts + http.ts + mcp.ts + register.ts together,
                        start listening. Roughly 30-50 lines.
```

---

## Open questions to resolve before/during implementation

These are places where the Q&A answers don't fully determine an
unambiguous file boundary. Flag decisions inline in code review rather
than blocking — but listing them here so they're deliberate, not accidental.

1. **Store genericity now vs. later.** The Q&A says the *eventual* server
   should have `Store<T>`, but Phase 1 has no second project consuming it
   yet, and the mock-UI stub is explicitly deferred to Phase 2. Recommend:
   keep `Store` string-keyed/string-valued in Phase 1 (matches current
   behavior exactly, zero risk), and generalize the type parameter in
   Phase 2 when the mock-UI stub actually needs a different shape. Flag
   this explicitly rather than guessing generic shape now.

2. **Where do `broadcastUpdate`/`broadcastReinit` live?** Currently
   methods on `Tenant`, but they format WebSocket-protocol messages
   (`{type: 'update', ...}`) which are transport concerns, not tenant
   bookkeeping. Recommend: keep them on `Tenant` for Phase 1 (behavior
   parity, low risk) since `ws.ts` and `tenant.ts` would otherwise need a
   circular import; readdress in Phase 2 when Tenant genuinely needs to be
   transport-agnostic for the mock-UI project.

3. **Schema file placement.** Original answer said colocate schemas with
   `define_form`'s tool file. But `field-tools.ts`'s `list_fields` handler
   returns field metadata shaped by `fieldDefSchema`'s sibling type
   (`FieldDef` from `shared/types.ts`), not the zod schema itself — so
   there's actually no cross-file zod dependency. Confirmed: `schemas.ts`
   content folds into `form-tools.ts` as originally answered, no separate
   schemas file needed in Phase 1.

4. **`/upload` handler placement.** Not form-specific (accepts any
   multipart file, tenant-agnostic beyond directory naming), so per the
   Round 2 "server owns even less... HTTP/WS stays per-project" answer,
   this is ambiguous. For Phase 1 (single package, no second project yet)
   it simply stays in `server/http.ts` since there's nowhere else for it to
   go without inventing Phase 2 structure prematurely.

---

## TODOs (Phase 1 — this pass)

1. Create `src/server/tenant.ts`
   - Move `Store` class, `Tenant` class, `tenants` Map, `getOrCreateTenant`,
     `disposeTenant`, idle-sweep `setInterval` block, `envMs` helper.
   - Export: `Store`, `Tenant`, `tenants`, `getOrCreateTenant`,
     `disposeTenant`.
2. Create `src/server/mcp.ts`
   - Move `buildMcpServer`, changed to accept a `registerFn: (mcp: McpServer, tenant: () => Tenant, port: number) => void` parameter instead of inlining the six `mcp.tool(...)` calls.
   - No more direct dependency on form-specific schemas.
3. Create `src/tools/form-tools.ts`
   - Move `fieldTypeEnum`, `subFieldTypeEnum`, `validationSchema`,
     `subFieldDefSchema`, `fieldDefSchema` (per Open Question 3 resolution).
   - Move `get_form_url`, `define_form`, `wait_for_submit` tool
     registrations, expressed as data objects per the registration-style
     answer: `{ name, description, schema, handler }`.
4. Create `src/tools/field-tools.ts`
   - Move `list_fields`, `get_field`, `set_field` as the same data-object
     shape.
5. Create `src/tools/register.ts`
   - `registerFormTools(mcp, tenant, port)` — iterates the tool arrays from
     `form-tools.ts` + `field-tools.ts` and calls `mcp.tool(t.name, t.description, t.schema, t.handler)` for each.
6. Create `src/server/http.ts`
   - Move: `httpServer` creation, static file serving block, `/upload`
     multipart handler, `/mcp` session routing (POST/GET/DELETE branches),
     `sessions` Map, `STATIC_DIR`/`mime` constants.
   - Takes `buildMcpServer` (from `mcp.ts`) and `registerFormTools` (from
     `tools/register.ts`) as dependencies to wire the `/mcp` POST branch.
7. Create `src/server/ws.ts`
   - Move `WebSocketServer` construction and `connection`/`message`/`close`
     handlers.
   - Depends on `tenant.ts` for `getOrCreateTenant`/`tenants`.
8. Shrink `src/server.ts`
   - Read `config/fields.json` into `initialConfig`.
   - Import and call the pieces from steps 1–7 to assemble the running
     server (HTTP listen, WS mount, default tenant creation, sweep timer
     start).
   - Should end up roughly 30-50 lines: config load + wiring only.
9. Fix all cross-module imports (`.js` extension convention per existing
   ESM setup — check current imports use `.js` suffixes on relative TS
   imports, matching `src/server.ts`'s existing style).
10. Verification pass
    - `npm run typecheck` clean.
    - `npm run build` succeeds.
    - `npm test` passes unchanged (check `test/**/*.test.ts` doesn't import
      internals from `src/server.ts` directly — if it does, update those
      import paths to the new module locations).
    - Manual smoke test: `npm start`, open the form UI, confirm
      `define_form`/`set_field`/`wait_for_submit` still work end-to-end via
      an MCP client (or via the existing test suite if it covers this).
11. Update `README.md` if it references `server.js`/file layout directly
    (it currently says "Edit `config/fields.json`... Restart the server" —
    check for stale internal file-path references worth correcting).

---

## Explicitly out of scope for this pass (Phase 2 preview only)

Recorded for continuity, not to be started now:

- Moving `src/server/*` into `packages/mcp-tenant-server/` with its own
  `package.json`.
- Turning `Store` into a generic `Store<T>`.
- Building the `examples/mock-ui-stub/` throwaway sibling to validate the
  boundary against a second project.
- Designing the "inject server into a pre-existing page" (Option 2)
  AI-enablement API — deferred indefinitely, not needed for forms.
- npm workspaces root `package.json` setup.

---

# Stage 2: package extraction + project-independent tool authoring

## Goal (revised from Phase 2 preview above)

Phase 1 is done and verified (typecheck clean, `src/server.ts` ~40 lines,
`src/server/*` + `src/tools/*` in place). Stage 2 is **not** just "move
`src/server/*` into a folder with a `package.json`" — the actual goal,
per the brainstorm below, is to make the generic server **pluggable into
unrelated, non-AI-enabled projects** with minimum effort. Concretely: an
AI agent should be able to take an existing app (worked example used
throughout: a plain TODO app with no AI features) and, in a short guided
session, produce (a) a handful of new MCP tool definitions
(`add_todo`, `mark_todo_complete`, `get_progress`), (b) server-side
registration via the extracted package, and (c) a client-side bridge that
wires those tools to the TODO app's existing code — either plain global
`window` functions (no-build-step apps) or pre-build-step wiring
(bundled apps) — without touching the generic server package itself.

This reframes the deliverable: package extraction is necessary but not
sufficient. The differentiator is the **tool-authoring contract** and a
recipe doc an agent can follow unassisted.

## Design Q&A record (Stage 2 brainstorm, via form)

| Question | Answer |
|---|---|
| Which out-of-scope Phase 2 items are actually in Stage 2? | **All five**: package extraction, `Store<T>`, mock-UI-stub validation, "inject into existing page" API design, npm workspaces |
| Mock-UI-stub timing | **After** — extract the package first assuming the Phase 1 boundary is correct, then use the stub as a regression check (not a pre-extraction validator) |
| Workspace tooling | **npm workspaces** — matches existing `npm-run-all`/npm scripts, least new tooling |
| Store<T> concrete second shape | Explicitly **not** speculating a second shape — "don't want too much work done for the mock-UI" this stage; genericize the type mechanically but don't design around a hypothetical shape |
| Breaking changes to import paths | **Yes, break freely** — pre-1.0, no external consumers yet |
| Client-side bridge scope this stage | **Design + stub only** — a design doc plus a minimal working example (against the mock-UI stub or a tiny fake TODO page), not a polished published client package |
| AI-agent-facing docs format | **Single `AGENT_GUIDE.md` recipe doc** in the new package — numbered steps (define schema → write handler → register → client wiring options A/B) plus one fully worked example |
| Timeline pressure | None stated; open to a suggested sequencing (see below) |

### Key requirement surfaced in free-text answer (drives most of the design below)

> "The main goal of this stage of the refactor is to have the server
> package become 'pluggable' in other packages later... I would like to
> be able with minimum effort to use AI to define several tools... and
> then use the reusable server to 'expose' the new tools, and also
> expose a JS module which I can just include in the existing UI —
> assuming that when included the tools for the TODO app will (on the
> client side) call existing functions which are global in the window
> object... Also there will be other scenarios where vs using global
> functions the mcp tools are wired in the code prior to a build step...
> we want the server / mcp functionality and tool wiring to become
> project independent with extremely easy to follow (by AI agents) guide."

This means the tool-registration contract (`RegisterToolsFn` in
`src/server/mcp.ts` today) needs a client-side counterpart: a symmetric,
declarative way to say "tool X on the server maps to client action Y,"
where Y is resolvable two ways (global function lookup, or
build-time-wired handler map) without the generic package caring which.

## Target package layout (Stage 2)

```
package.json                 npm workspaces root (private, no version)
packages/
  mcp-tenant-server/          extracted from src/server/*
    package.json              real package: name, version, exports map
    src/
      tenant.ts                (moved, Store genericized to Store<T>)
      mcp.ts                   buildMcpServer(...) — unchanged shape,
                                registerFn contract now documented as
                                the public extension point
      http.ts                  createHttpServer(...) — /upload handler
                                reviewed: still project-agnostic enough
                                to keep here (Open Question 4 resolved:
                                yes, generic enough)
      ws.ts                    attachWebSocketServer(...)
      client-bridge.ts          NEW — see "Client bridge design" below.
                                Declarative tool→action resolver, no
                                DOM/UI assumptions. Design + stub only.
    AGENT_GUIDE.md             NEW — the recipe doc, see below
    README.md                  human-facing package overview
    dist/                       build output
  mcp-form-demo/                current app, becomes the first consumer
    (existing src/tools/, src/client/, config/, etc. move here or stay
    at repo root — see Open Question A)
examples/
  mock-ui-stub/                 built AFTER extraction, as a regression
                                 check per the "after" answer above
  todo-app-stub/                NEW — minimal fake TODO app (plain HTML +
                                 window globals, no build step) proving
                                 the client-bridge design against the
                                 "global window functions" wiring mode.
                                 This is the worked example AGENT_GUIDE.md
                                 walks through.
```

## Client bridge design (design + stub only this stage)

Server side already has the right shape: `registerFn(mcp, tenant, port)`
registers `{name, description, schema, handler}` tool objects. The client
bridge needs a **mirror-shape, declarative mapping** so the same tool
definition can drive both server registration and client dispatch
without duplicating tool metadata:

```ts
// packages/mcp-tenant-server/src/client-bridge.ts (sketch)
export interface ClientAction {
  name: string;                 // matches the MCP tool name
  resolve: 'window' | ((args: any) => unknown | Promise<unknown>);
  // 'window' mode: looks up window[name] and calls it with args
  // function mode: pre-build-step wiring, caller supplies the handler directly
}

export function createClientBridge(actions: ClientAction[]): {
  dispatch(name: string, args: unknown): Promise<unknown>;
};
```

- **Global-function mode** (`resolve: 'window'`): bridge calls
  `window[name](args)`. Zero build step required — this is what makes
  the TODO-app scenario "minimum effort": the agent defines
  `add_todo` server-side, declares `{name: 'add_todo', resolve: 'window'}`
  client-side, and the existing `window.add_todo` function (if the TODO
  app already exposes one) just works. If it doesn't exist yet, the
  guide tells the agent to add a thin global wrapper around the app's
  existing internal function — smallest possible touch to legacy code.
- **Pre-wired mode** (`resolve: fn`): for bundled apps where globals
  aren't idiomatic; caller passes real function references at
  bridge-construction time, resolved at build time, not runtime lookup.
- Bridge stays UI-framework-agnostic (no Lit/React assumptions) —
  matches the Round 2 "UI differs per project" finding from Phase 1.
- **This stage**: implement `client-bridge.ts` + prove it against
  `examples/todo-app-stub/` using global-function mode only.
  Pre-wired/build-time mode gets the same interface designed and typed
  now, but its own worked example can wait — flagged as Open Question B.

## AGENT_GUIDE.md contents (the actual differentiator deliverable)

Numbered, copy-pasteable recipe an agent follows with no prior context:

1. Install `@you/mcp-tenant-server` (workspace-local for now).
2. Define your tool schemas (zod) — one file, plain data objects.
3. Write handlers — pure functions of `(args, tenant, port)`.
4. Call `buildMcpServer(tenantId, getTenant, port, registerFn)` where
   `registerFn` loops your tool array and calls `mcp.tool(...)`.
5. Client wiring decision tree: "Does your existing app have a build
   step?" → No: expose functions on `window`, use
   `createClientBridge(actions, {mode: 'window'})`. → Yes: pass handler
   references directly.
6. Worked example inline: the full `add_todo` / `mark_todo_complete` /
   `get_progress` tool set, server + client, against
   `examples/todo-app-stub/`.
7. Checklist: typecheck, smoke test via an MCP client, confirm client
   bridge dispatches correctly.

## Open questions to resolve before/during implementation

**A. Repo layout for `mcp-form-demo` itself.** Does the current app's
code (`src/tools/`, `src/client/`, `config/`) move into
`packages/mcp-form-demo/`, or stay at repo root as the workspace root
package that depends on `packages/mcp-tenant-server`? Recommend: move it
into `packages/mcp-form-demo/` for symmetry — makes it obvious the demo
app is "just another consumer," which is the whole point of this stage.
Repo root becomes workspace-config-only.

**B. Pre-wired/build-time client bridge mode — worked example or not?**
Design + types land this stage per the form answer, but building a
second stub app (a bundled one) to prove it is not explicitly requested.
Recommend: skip a second stub this stage; note it as Stage 3 candidate
if a real bundled-app use case shows up.

**C. `Store<T>` genericization without a concrete second shape.** The
form answer says don't design around a hypothetical shape. Recommend:
genericize mechanically (`Store<T = string>` defaulting to today's
string behavior, `mcp-form-demo`'s usage stays unchanged), and let the
mock-UI-stub (built after extraction, per the "after" answer) be the
first real test of a non-string `T` — don't pre-design its shape now.

**D. Where does `/upload` live post-extraction?** Phase 1 left it in
`server/http.ts` provisionally. It's still project-agnostic (accepts any
multipart file), so it can stay in `mcp-tenant-server`'s `http.ts`
unchanged. Flagging only because Phase 1's Open Question 4 deferred this
and Stage 2 is where it'd need to move if the answer were different —
confirmed no change needed.

## Suggested sequencing (since no deadline was given)

1. npm workspaces root + `packages/mcp-tenant-server/` + `packages/mcp-form-demo/`
   scaffolding, move files, fix imports, get `typecheck`/`build`/`test`
   green again before any new functionality.
2. Genericize `Store<T>` (mechanical, per Open Question C).
3. Write `client-bridge.ts` (window mode only) + `examples/todo-app-stub/`.
4. Write `AGENT_GUIDE.md`, validating every step against the todo-app
   stub as it's written (not after) so the recipe is proven, not
   aspirational.
5. Build `examples/mock-ui-stub/` as the regression check against the
   now-extracted package (per "after" answer).
6. `README.md` pass on both packages.

## Explicitly out of scope for Stage 2

- Publishing either package to a real npm registry.
- Pre-wired/build-time client bridge worked example (Open Question B).
- The "inject server into a pre-existing page" Option 2 API beyond what
  the client bridge already covers — if `client-bridge.ts` turns out to
  satisfy this, revisit whether it's still a separate concern; don't
  build a second mechanism speculatively.
- Any UI/design work on `examples/todo-app-stub/` beyond the minimum
  needed to demonstrate global-function wiring.
