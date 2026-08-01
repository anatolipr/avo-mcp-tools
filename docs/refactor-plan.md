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
