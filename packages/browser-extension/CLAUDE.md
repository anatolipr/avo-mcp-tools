# browser-extension

## Keep the Chrome and Firefox builds in sync

This package builds TWO extension targets (`dist/chrome/`, `dist/firefox/`) from ONE shared source
tree (`src/`), via `BUILD_TARGET=chrome|firefox` (see `build/vite.background.config.ts`/
`vite.popup.config.ts`). Unlike `mcp-tenant-lib`'s consumer-version-bump rule (root CLAUDE.md), there
is no separate package/dependency-range to bump here — the risk instead is silent DRIFT: editing
shared code (`src/background/`, `src/popup/`, `src/shared/`) and only manually testing the Chrome
build, leaving the Firefox build broken or behaviorally different without any build-time signal.

When you change anything under `src/` (not `manifests/chrome.manifest.json` or
`manifests/firefox.manifest.json` themselves, which are already inherently per-target):

- Run `npm run build` (builds BOTH targets — do not run only `npm run build:chrome`) and confirm both
  succeed with no new errors/warnings.
- Load-unpack-test BOTH `dist/chrome/` (chrome://extensions → Load unpacked) and `dist/firefox/`
  (about:debugging → Load Temporary Add-on) against a locally running `js-bridge-mcp` server before
  considering the change done — see this package's README's "Manual test checklist" for the concrete
  steps.
- Pay particular attention to any `chrome.*`-namespaced API call you touch: confirm it's either
  guarded by a feature check or has a genuine Firefox equivalent reachable via the same code path.
  (This package currently uses raw `chrome.*` throughout — no `webextension-polyfill` yet. Firefox
  MV3 supports the `chrome.*` namespace as an alias for `browser.*`, so this works today, but if a
  future change needs `browser.*`-only promise semantics, add `webextension-polyfill` rather than
  hand-branching per call site.)

## Never use top-level `await` in `src/background/index.ts` (or any module it evaluates at import time)

Chrome's MV3 service worker environment does NOT reliably support top-level `await`, even with
`"type": "module"` declared in the manifest's `background` entry. Using it produces "Service worker
registration failed. Status code: 3" — with no stack trace anywhere (not even an Inspect-views link
on the extension's `chrome://extensions` card), which makes it easy to burn a lot of time
misdiagnosing as a manifest/permissions problem instead. If `chrome://extensions` shows this exact
error after a change, check for a `await` at module top level FIRST, before permissions or anything
else. Fix: wrap the async setup in a function and invoke it without awaiting at module scope, e.g.
`async function init() { await thing(); } void init();`.
