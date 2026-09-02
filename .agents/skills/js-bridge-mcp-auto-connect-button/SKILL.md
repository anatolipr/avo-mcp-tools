---
name: js-bridge-mcp-auto-connect-button
description: Use when a page already defines window.__mcpTools (js-bridge-mcp's page-side contract) and needs to auto-connect to a local js-bridge-mcp server on page load, instead of a human pasting the get_embed_snippet import into DevTools every session
---

# js-bridge-mcp auto-connect button

## Overview

`get_embed_snippet`'s normal workflow is manual: an MCP client calls it, a human pastes the returned
`import("...main.js?...")` line into DevTools, once, per tab, per session. This skill replaces that with a
small connector module the page loads itself — it probes `js-bridge-mcp` on `localhost:8766`, dynamically
imports `main.js` with a fixed, human-readable **channel** name (not a session-minted tenant UUID) baked in,
and exposes connect state so the page can show a status button. No DevTools paste, ever.

Full recipe and worked reference implementation: `packages/js-bridge-mcp/README.md`, "Auto-connect on page
load" section. That section is the source of truth — this skill just tells you when to reach for it and
where the reference lives; read the README before implementing, don't reimplement from memory.

## When to use

- The target page is a real app with its own build (Vite/webpack/etc), not a bare static HTML page — for a
  one-off static page, the plain `get_embed_snippet` DevTools paste is still simpler and is what
  `packages/js-bridge-mcp/README.md`'s main flow documents.
- The page already defines `window.__mcpTools` (its own `mcpbridge.ts`/`.js` module) and you want every load
  of the page to connect on its own.
- Don't use this to replace `get_embed_snippet`'s per-session tenant UUID pattern when you specifically want
  session isolation — auto-connect uses one fixed channel name shared across reloads/reconnects, by design.

## Quick reference

The probe/connect/rename/leave-old-channel-on-switch lifecycle is **not** something to hand-roll per app
anymore — it's shared infrastructure served by js-bridge-mcp itself at `<server>/connect.js`, the same way
`tool-bus.js` already is. Don't recreate `connectToChannel`/`probeJsBridgeMcp`/etc. from scratch; import the
factory instead:

1. Confirm `window.__mcpTools` is already set up (a page-owned module, loaded before anything else here) —
   this skill only adds the *connection*, not the tool contract itself.
2. Add a thin connector module (`mcp-connect.ts`/`.mjs`/`.js`) that imports `createMcpConnect` from
   `http://localhost:8766/connect.js` and calls it once: `createMcpConnect({ appName: 'myapp' })`. That
   returns `{ init, handleConnectClick, onConnectionStateChange, getConnectionState }` — no need to write any
   of the probe/import/localStorage/rename logic yourself.
   - If the host page layers extra tool providers onto `window.__mcpTools` before connecting (e.g. via
     `tool-bus.js` + a folderfoo-style provider), pass `beforeConnect: async () => { ... }` — it runs once,
     before the first `main.js` import.
   - If the host's bundler can't top-level-`await` a dynamic import at its build target (common with Vite's
     default target — check by building; esbuild's error is unambiguous), wrap the import in a synchronous
     stub that starts `'disconnected'` and swaps in the real instance once the import resolves, so a UI
     component reading `getConnectionState()` synchronously at its own module-eval time still works. A native
     ESM page with no bundler can just top-level-`await` it directly.
3. Call the module's `init()` unconditionally at app boot (after `window.__mcpTools` is set), no dev-mode
   gate — js-bridge-mcp only ever runs locally regardless of where the host app is served from.
4. Track state (`disconnected`/`connecting`/`connected`) in whatever the app's own reactive primitive is
   (a signal/store, not ad-hoc DOM writes) so a status indicator can render off `onConnectionStateChange`.
5. Add a small toolbar button bound to that state: ⚪/🟡/🟢 + channel name, click-to-(re)connect or
   click-to-rename-channel-once-connected. The rename prompt accepts `channel:app-name` (e.g.
   `bug123:htmlpaint`) to join a channel shared with other apps under an explicit label — see the README's
   "Channel:app-name" section.

See the README's "Auto-connect on page load" section for the full `createMcpConnect` API and three worked
per-app wrappers (`htmlpaint.com`, `mindfoo`, `bulletino-1` all use it — read one of those as the reference
rather than reinventing the connector).

## Orphaned channels

Switching a tab's channel (or just closing it) no longer leaves a dead tenant behind indefinitely:
`connect.js` sends `leave_channel` on the old socket before opening a new one when a tab explicitly switches
channels, and the server separately disposes any tenant that's had zero connections for more than
`TENANT_EMPTY_TIMEOUT_MS` (default 15s) — independent of, and much shorter than, the general 2-hour idle
sweep. Nothing to wire up for this — it's automatic once the app uses `connect.js`.

## Common mistakes

- Reimplementing the connect lifecycle per app instead of importing `createMcpConnect` from `connect.js` —
  this is exactly the drift this skill/module exists to avoid.
- Gating the auto-connect behind `NODE_ENV`/dev checks — unnecessary, since `JSBRIDGE_HOST` is always
  localhost and a failed probe already degrades silently to `disconnected`.
- Using a random/session UUID as the channel instead of a fixed name — defeats the point of "any MCP client
  can `join_channel("<name>")` and land on the same live connection" across reloads.
- Loading the connector module before `window.__mcpTools` is defined — `main.js` reads it once, synchronously,
  at import time (see README's "Common mistakes" list).
- Forgetting the top-level-await/bundler-target caveat above and shipping a build that throws
  "Top-level await is not available in the configured target environment" at build time.
