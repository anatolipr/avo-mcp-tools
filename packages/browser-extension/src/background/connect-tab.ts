// Shared "inject the connect snippet into this tab" helper - used by both
// the popup's manual connect flow (a human picks a channel) and
// auto-reconnect.ts (a known origin reconnecting after a navigation). Keeps
// the actual chrome.scripting.executeScript call in one place rather than
// duplicated across both call sites.
import { JSBRIDGE_HOST } from '../shared/constants.js';

// Read-only introspection of the marker main.ts already sets on a successful
// connect (window.__mcpLeaveChannel) - lets callers skip injecting into a
// tab that already has its own hand-authored <script> snippet actively
// connected, avoiding a double-connect. This is checking whether a
// connection already happened, not requiring pages to opt in via a special
// marker - the opposite direction from an auto-detection requirement.
// func callbacks below run in the TARGET PAGE's context (which has
// `window`/`document`), not this file's own service-worker context - cast
// through `Function` since this file compiles under tsconfig.background.json
// (webworker lib, no DOM lib), which doesn't know about `window` even though
// it's valid at the injection site.
export async function tabAlreadyConnected(tabId: number): Promise<boolean> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (function () {
        return typeof (globalThis as any).window?.__mcpLeaveChannel === 'function';
      }) as () => boolean,
    });
    return Boolean(results[0]?.result);
  } catch {
    // Page not scriptable (chrome:// URL, PDF viewer, etc.) - treat as "not
    // connected" so callers skip injection rather than throwing.
    return false;
  }
}

// Renames an ALREADY-connected page's connection in place via
// window.__mcpRename (main.ts) - sends rename_connection over the existing
// live socket, no reconnect/re-import needed. Throws if the page isn't
// actually connected (no __mcpRename global) - callers should check
// tabAlreadyConnected first for a clearer error than "not a function".
export async function renameConnection(tabId: number, appLabel: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (function (label: string) {
      const rename = (globalThis as any).window.__mcpRename;
      if (typeof rename !== 'function') throw new Error('This tab has no active js-bridge-mcp connection to rename.');
      rename(label);
    }) as (label: string) => void,
    args: [appLabel],
  });
}

// Tells an already-connected page's CURRENT socket to leave its channel
// (main.ts's window.__mcpLeaveChannel) before switching to a different one -
// lets the server drop the old tenant promptly rather than only after the
// old socket times out, same reasoning as main.ts's own onMove handler and
// connect.js's connectToChannel. A no-op if the page isn't connected (no
// __mcpLeaveChannel global) - swallowed, not thrown, since callers switching
// channels only need this as a best-effort cleanup, not a hard prerequisite.
async function leaveCurrentChannel(tabId: number): Promise<void> {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (function () {
        (globalThis as any).window.__mcpLeaveChannel?.();
      }) as () => void,
    })
    .catch(() => undefined);
}

export async function changeChannel(tabId: number, channel: string, appLabel: string): Promise<void> {
  await leaveCurrentChannel(tabId);
  await injectConnectSnippet(tabId, channel, appLabel);
}

// Fully closes an already-connected page's socket via window.__mcpDisconnect
// (main.ts) - distinct from leaveCurrentChannel/changeChannel, which only
// tell the server this socket is leaving ahead of a FRESH import opening a
// new one; __mcpDisconnect stops the OLD socket's own reconnect loop for
// real, with no follow-up connect. Throws if the page isn't connected, same
// clear-error convention as renameConnection.
export async function disconnectTab(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (function () {
      const disconnect = (globalThis as any).window.__mcpDisconnect;
      if (typeof disconnect !== 'function') throw new Error('This tab has no active js-bridge-mcp connection to disconnect.');
      disconnect();
    }) as () => void,
  });
}

export async function injectConnectSnippet(tabId: number, channel: string, appLabel: string): Promise<void> {
  // world: 'MAIN' - the default ISOLATED world runs in a separate JS realm
  // from the page's actual window (shares the DOM, but not module/global
  // state), and Chrome suppresses window.prompt()/alert()/confirm() calls
  // originating from that isolated realm (a spam-prevention measure for
  // content-script-injected code) - main.ts's labelForFirstRegister() prompt
  // silently never appeared because of this. MAIN world makes the injected
  // import() behave exactly like a human pasting the same snippet into
  // DevTools (which always runs in the page's own main-world context).
  //
  // Setting window.__mcpAppName BEFORE the import is what makes this a
  // silent connect: main.ts's labelForFirstRegister() only prompts when the
  // host page hasn't already set that global (see main.ts's own
  // hostProvidedLabel check) - the same mechanism connect.js already uses to
  // avoid its own prompt. Required for unattended automation: a page reload
  // triggered by browser automation (not a human sitting at the keyboard)
  // must never block on a native dialog waiting for a click that will never
  // come.
  // BUG FIX (found during manual testing): the injected function must AWAIT
  // the dynamic import, not fire-and-forget it - chrome.scripting.executeScript's
  // returned promise resolves once the injected function itself returns, so
  // a bare `void import(url)` let this call's promise resolve before main.js's
  // module body (including its window.__mcpLeaveChannel assignment) had
  // actually run. Callers that immediately check tabAlreadyConnected() or
  // refresh the toolbar badge right after awaiting injectConnectSnippet were
  // racing that module evaluation and could read stale "not connected" state
  // until an unrelated event (e.g. switching tabs) triggered a recheck.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (function (host: string, tenant: string, label: string) {
      (globalThis as any).window.__mcpAppName = label;
      const url = `${host}/main.js?server=${encodeURIComponent(host)}&tenant=${encodeURIComponent(tenant)}&_=${Date.now()}`;
      return import(/* webpackIgnore: true */ url).then(() => undefined);
    }) as (host: string, tenant: string, label: string) => Promise<void>,
    args: [JSBRIDGE_HOST, channel, appLabel],
  });
}
