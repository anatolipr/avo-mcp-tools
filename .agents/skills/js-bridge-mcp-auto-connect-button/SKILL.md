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

1. Confirm `window.__mcpTools` is already set up (a page-owned module, loaded before anything else here) —
   this skill only adds the *connection*, not the tool contract itself.
2. Add a connector module (`mcp-connect.ts`/`.mjs`) with: a hardcoded `JSBRIDGE_HOST` (always
   `http://localhost:8766` — js-bridge-mcp has no production deployment), a channel name persisted in
   `localStorage` (default a short app-specific string), a `HEAD /main.js` reachability probe, and
   `connectToChannel()` that dynamically `import()`s `${JSBRIDGE_HOST}/main.js?server=...&tenant=<channel>&_=<cachebust>`
   on success.
3. Call the module's `init`/connect function unconditionally at app boot (after `window.__mcpTools` is set),
   no dev-mode gate — js-bridge-mcp only ever runs locally regardless of where the host app is served from.
4. Track state (`disconnected`/`connecting`/`connected`) in whatever the app's own reactive primitive is
   (a signal/store, not ad-hoc DOM writes) so a status indicator can render off it.
5. Add a small toolbar button bound to that state: ⚪/🟡/🟢 + channel name, click-to-(re)connect or
   click-to-rename-channel-once-connected.

See the README section for the full commented `mcp-connect.ts` source (copy-adapt, don't rewrite from
scratch) and the exact `main.ts`/toolbar wiring.

## Common mistakes

- Gating the auto-connect behind `NODE_ENV`/dev checks — unnecessary, since `JSBRIDGE_HOST` is always
  localhost and a failed probe already degrades silently to `disconnected`.
- Using a random/session UUID as the channel instead of a fixed name — defeats the point of "any MCP client
  can `join_channel("<name>")` and land on the same live connection" across reloads.
- Forgetting the reachability probe and importing `main.js` unconditionally — an unreachable js-bridge-mcp
  then throws instead of leaving the button in a clean `disconnected` state.
- Loading the connector module before `window.__mcpTools` is defined — `main.js` reads it once, synchronously,
  at import time (see README's "Common mistakes" list).
