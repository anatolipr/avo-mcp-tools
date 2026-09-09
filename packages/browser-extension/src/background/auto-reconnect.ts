// Auto-reconnect: when a tab navigates to an origin the popup previously
// connected at least once (see storage.ts's KnownOriginEntry), re-inject the
// connect snippet without any human interaction - this is what makes a
// server-rendered page's form-POST reload (or any full navigation) "just
// keep working" instead of requiring a manual snippet re-paste.
//
// Never auto-injects into an origin nobody explicitly connected via the
// popup first (per the "human-initiated first connect" decision) - this
// listener only replays a connection a human already asked for once.
import { getKnownOrigin } from './storage.js';
import { injectConnectSnippet, tabAlreadyConnected } from './connect-tab.js';
import { refreshBadgeForActiveTab } from './connection-badge.js';
import { recordConnectedTab, forgetConnectedTab } from './connected-tabs.js';

// In-memory "this tab has a live page-side WS, as far as we know" set.
// Marked true by message-handler.ts's connect-active-tab handler and by this
// module's own onCompleted (after either finding an existing connection via
// tabAlreadyConnected or injecting a new one) - cleared on chrome.tabs.onRemoved
// (tab closed) AND on onBeforeNavigate (see startAutoReconnect below - a
// reload/navigation kills the OLD page's WS, so the tab must not stay marked
// "connected" across it). Chosen over querying the server's /api/dashboard
// snapshot on every single navigation: avoids request latency on every page
// load, and avoids depending on label-matching being unambiguous (two tabs
// sharing a label is an edge case tenant.ts already treats as "ambiguous,
// skip").
const connectedTabs = new Set<number>();

export function markTabConnected(tabId: number): void {
  connectedTabs.add(tabId);
}

export function startAutoReconnect(): void {
  // BUG FIX (found during manual testing): connectedTabs previously only got
  // cleared on chrome.tabs.onRemoved (tab closed) - a plain page reload or
  // navigation left the tab's id marked "connected" forever after its FIRST
  // successful connect, even though that reload killed the old page's WS.
  // onCompleted's guard (`if (connectedTabs.has(tabId)) return`) then skipped
  // re-injecting on every subsequent navigation, so auto-reconnect silently
  // never fired again after the first manual connect. Clearing on
  // onBeforeNavigate (right before the NEW page starts loading) makes
  // onCompleted's tabAlreadyConnected() DOM check the real source of truth
  // again for every navigation, not just the first one.
  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId !== 0) return;
    connectedTabs.delete(details.tabId);
    forgetConnectedTab(details.tabId);
  });

  chrome.webNavigation.onCompleted.addListener(async (details) => {
    if (details.frameId !== 0) return; // top-level frames only, not iframes

    let origin: string;
    try {
      origin = new URL(details.url).origin;
    } catch {
      return; // non-http(s) URL (chrome://, about:, etc.) - nothing to do
    }

    const known = await getKnownOrigin(origin);
    if (!known) return; // never explicitly connected via the popup - do nothing

    if (connectedTabs.has(details.tabId)) return; // already tracked as live

    // Guard against double-connecting a page that already has its own
    // hand-authored snippet baked into the HTML (get_embed_snippet's
    // documented "paste before </body>" option) - read-only check of the
    // marker main.ts already sets on success, not a new opt-in requirement.
    if (await tabAlreadyConnected(details.tabId)) {
      connectedTabs.add(details.tabId);
      recordConnectedTab(details.tabId, known.channel, known.appLabel || origin.replace(/^https?:\/\//, ''));
      await refreshBadgeForActiveTab();
      return;
    }

    // Reuses the SAME appLabel stored from the original manual connect
    // (message-handler.ts) rather than re-deriving one - required both for
    // stash/replay's appLabel-equality matching (tenant.ts) to recognize
    // this as the same connection reconnecting, and for silence: setting
    // window.__mcpAppName before the import is what suppresses main.ts's own
    // naming prompt, so unattended automation reloading this page never
    // blocks on a dialog nobody is present to answer. Falls back to the
    // origin's hostname for entries stored before appLabel existed.
    const label = known.appLabel || origin.replace(/^https?:\/\//, '');
    await injectConnectSnippet(details.tabId, known.channel, label);
    connectedTabs.add(details.tabId);
    recordConnectedTab(details.tabId, known.channel, label);
    // BUG FIX (found during manual testing): connection-badge.ts's own
    // tabs.onUpdated listener fires independently of webNavigation.onCompleted
    // (this listener) with no ordering guarantee between them - the badge's
    // own check could run (and read stale "not connected" state) before
    // injectConnectSnippet above had actually finished. Explicit refresh here
    // makes this the authoritative trigger for this event, same as
    // message-handler.ts's manual-connect path already does.
    await refreshBadgeForActiveTab();
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    connectedTabs.delete(tabId);
    forgetConnectedTab(tabId);
  });
}
