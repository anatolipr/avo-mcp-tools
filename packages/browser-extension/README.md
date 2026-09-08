# browser-extension

Chrome/Firefox WebExtension (Manifest V3) for `js-bridge-mcp`. Solves the manual
"copy the connect snippet, paste it into DevTools again" problem that happens every
time a connected page navigates or reloads (e.g. a form POST) — the extension
re-injects the connection automatically. It also maintains its own persistent
connection to `js-bridge-mcp` ("the extension becomes a channel"), so an agent can
register/unregister dynamic tools against the extension itself, not just a page —
using the exact same `register_page_tool_by_code` / `register_page_tool_by_path` /
`unregister_page_tool` MCP tools that already work against pages today.

## What's implemented (Phases 0–6 — full plan)

- **Phase 0** — package scaffold: dual Chrome/Firefox build from one source tree.
- **Phase 1** — auto-reconnect: popup channel picker (reads the running
  `js-bridge-mcp` server's `/api/dashboard`), manual "connect this tab," and a
  `webNavigation`-driven listener that re-injects the connect snippet on any
  future navigation of an origin you've connected before.
- **Phase 2** — extension-as-channel: the extension's background service worker
  opens its own always-on WebSocket connection to `js-bridge-mcp`, registers under
  a stable per-install label, and implements the three reserved-call handlers
  (`register_page_tool_by_code`/`_by_path`/`unregister_page_tool`) so an agent can
  create/remove tools that run with `chrome`/`browser` API access, not just
  `window`/`document`.
- **Phase 3** — built-in privileged tools, registered as `source: 'host'` (never
  remotely unregisterable, unlike agent-created dynamic tools) at service-worker
  startup: `get_network_log` (read-only `chrome.webRequest` capture, ring-buffered
  per tab), `get_console_log` (a `document_start` content-script pair patches the
  page's own `console.*` and relays it back), `inject_script` (one-shot
  `chrome.scripting.executeScript`), and `inject_persistent_script` /
  `unregister_persistent_script` (re-runs on every matching future navigation via
  `chrome.scripting.registerContentScripts`, until unregistered).

- **Phase 4** — `chrome.debugger`-gated tools (Chrome-only; feature-detected and
  skipped on Firefox). `debugger` is declared as a required permission in the Chrome
  manifest — Chrome rejects it in `optional_permissions` outright ("Permission
  'debugger' cannot be listed as optional"), so lazy `chrome.permissions.request`
  isn't an option for this specific permission. The meaningful opt-in moment instead
  sits at *attach* time: `enable_debugger_tools` (always present when
  `chrome.debugger` exists) shows a `chrome.notifications` approval prompt with an
  "Approve" button before ever calling `chrome.debugger.attach` — since attaching is
  what triggers Chrome's own intrusive "extension is debugging this browser" banner
  on the target tab. Once approved and attached, `read_response_body` and
  `modify_request` (CDP `Network`/`Fetch` domains) are added to the manifest via a
  resend; they're removed again automatically on `chrome.debugger.onDetach`.
- **Phase 5** — `request_reconnect` MCP tool: a new reserved call
  (`REMOTE_REQUEST_RECONNECT_CALL`) added to `mcp-tenant-lib`, alongside the
  existing three. Against a page connection it's a no-op ack (a page's own socket
  dying is exactly the case it can't act on). Against the extension connection, it
  resolves a tab by `targetTabId` or by querying open tabs for `targetOrigin`, looks
  up that origin's previously-connected channel, and re-injects the connect
  snippet — an agent-triggered version of the popup's manual flow. This changed
  `mcp-tenant-lib` (bumped `0.5.3` → `0.5.4`) and `js-bridge-mcp`'s `main.ts` (bumped
  `0.4.5` → `0.4.6`), so both consumer ranges were updated per the repo's
  "bump consumer dependency ranges" rule.

- **Phase 6** — packaging: `npx browser-extension [outDir] [--zip] [--rebuild]`
  (`bin/browser-extension.js` → `scripts/package-dist.mjs`) builds (only if `dist/`
  is missing a target, or `--rebuild` is passed) and copies or zips both targets
  into a plain output folder for a non-developer end user, printing load-unpacked
  instructions for both browsers. `.github/workflows/browser-extension-release.yml`
  runs the same `scripts/package-dist.mjs --zip` logic on a `browser-extension-v*`
  tag push (or manual dispatch) and attaches the resulting zips to a GitHub Release —
  a separate workflow from `publish.yml`, since this package is `"private": true`
  and never npm-published, and its release artifact is a zip, not an npm version.
  Zipping uses `archiver` (Node has no built-in zip-container format, only raw
  deflate/gzip via `zlib`).

Chrome Web Store / Firefox AMO store submission automation remains explicitly out
of scope (per the original requirements) — this stops at "zip is attached to a
release."

## TODO / future idea (not started)

Extension-as-js-bridge-server: bundle `js-bridge-mcp`'s server role into the
extension itself, so it can act as the server when nothing is already listening on
`localhost:8766`, removing the need to separately run `npm run start:mcp -w
js-bridge-mcp`. Not designed yet — revisit as its own planning pass.

## Build

```sh
npm run build -w mcp-tenant-lib   # dependency — build first
npm run build -w browser-extension
```

Produces `dist/chrome/` and `dist/firefox/`, each a complete unpacked-extension
folder.

## Load unpacked

- **Chrome**: `chrome://extensions` → enable Developer mode → "Load unpacked" →
  select `dist/chrome/`.
- **Firefox**: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" →
  select any file inside `dist/firefox/` (e.g. `manifest.json`).

## For non-developers: `npx browser-extension`

```sh
npx browser-extension                  # -> ./avo-browser-extension/{chrome,firefox}/
npx browser-extension ./my-folder      # custom output location
npx browser-extension --zip            # chrome.zip / firefox.zip instead of folders
npx browser-extension --rebuild        # force a fresh build first
```

Prints load-unpacked instructions for both browsers once done. In the common case
(installed from a published npm package) this just packages the already-built
`dist/`, shipped via `prepublishOnly` — no build step at run time.

## Manual test checklist

1. Start `js-bridge-mcp` locally (`npm run start:mcp -w js-bridge-mcp`, port 8766)
   and the static test page (`npm run start:static -w js-bridge-mcp`, port 8080,
   serves `legacy-page/hello-world.html`).
2. Load both `dist/chrome/` and `dist/firefox/` unpacked.
3. Open `hello-world.html`, click the extension's toolbar icon, pick/create a
   channel, click Connect. Confirm a new connection row appears on the
   `js-bridge-mcp` dashboard (`http://localhost:8766`).
4. Reload the page (or submit its form). Confirm it reconnects under the same
   channel/label automatically, with no popup interaction.
5. Confirm the extension itself shows as a separate connection on the dashboard
   (distinct label, `extension-xxxxxxxx`). From an MCP client, call
   `describe_tools`, find that connection's `id`, and call
   `register_page_tool_by_code` against it with a trivial snippet (e.g.
   `return chrome.runtime.id`). Confirm it registers, is callable, and
   `unregister_page_tool` removes it again.
6. Still via an MCP client, call the extension connection's built-in tools directly:
   `inject_script` with `{ code: "document.title = 'hi'; return document.title" }`
   against a test tab (confirm the tab's title changes); `get_console_log` after the
   page logs something via `console.log`; `get_network_log` while the page makes a
   `fetch` call; `inject_persistent_script` with a `matchOrigin` covering the test
   page, then reload the page and confirm the script re-runs, then
   `unregister_persistent_script` and reload again to confirm it stops. Confirm
   `unregister_page_tool` REFUSES to remove any of these five (they're `source:
   'host'`, not `'dynamic'`).
7. Chrome only: call `enable_debugger_tools`. Confirm a browser notification with
   "Approve"/"Dismiss" buttons appears; click Approve; confirm Chrome's "extension is
   debugging this browser" banner appears on the target tab, and that
   `describe_tools` now lists `read_response_body`/`modify_request`. Call
   `get_network_log`, grab a `requestId`, call `read_response_body` with it, confirm
   the body comes back. Close the debugger banner manually (or call
   `chrome.debugger.detach` via `inject_script` against the extension's own tab
   context isn't applicable — just click the banner's "Cancel"/close in-browser) and
   confirm `read_response_body`/`modify_request` disappear from `describe_tools`
   again.
8. Open two tabs on the same known origin (or reuse one from step 3). Manually close
   the page's connection (e.g. reload without the extension's auto-reconnect firing,
   or wait for it — either way, ensure no live connection exists for that tab), then
   call `request_reconnect` with `targetOrigin` set to that origin. Confirm the tab
   reconnects with no popup interaction, and that calling it with an origin that was
   never connected via the popup returns a clear tool error instead of silently
   doing nothing.

## Keep the Chrome and Firefox builds in sync

See `CLAUDE.md` in this package.
