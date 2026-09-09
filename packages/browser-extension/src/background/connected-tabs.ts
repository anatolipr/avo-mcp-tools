// In-memory tabId -> {channel, appLabel} registry for tabs THIS EXTENSION
// connected (via the popup's Connect, a channel switch, or auto-reconnect
// silently replaying a known origin) - lets find_tab_by_connection
// (builtin-tools.ts) resolve "the tab connected as X" / "the tab on channel Y"
// to a real chrome tabId, instead of every extension tool defaulting to
// "whichever tab happens to be active" when an agent means a specific one.
//
// Deliberately separate from auto-reconnect.ts's connectedTabs Set (which
// only tracks "is this tab's page-side WS alive right now", used to decide
// whether to re-inject) - this map additionally records WHICH channel/label,
// and is looked up by that channel/label rather than by tabId.
//
// Not persisted (chrome.storage) and not the source of truth for "is this
// connection still live" - a tab can close or navigate away without this
// module hearing about it in every case (e.g. before startAutoReconnect's own
// onRemoved/onBeforeNavigate listeners are wired). find_tab_by_connection
// double-checks liveness via tabAlreadyConnected before returning a match,
// so a stale entry here surfaces as "no live connection", never a false
// positive pointing at the wrong tab.
interface ConnectedTabEntry {
  channel: string;
  appLabel: string;
}

const byTabId = new Map<number, ConnectedTabEntry>();

export function recordConnectedTab(tabId: number, channel: string, appLabel: string): void {
  byTabId.set(tabId, { channel, appLabel });
}

export function forgetConnectedTab(tabId: number): void {
  byTabId.delete(tabId);
}

export interface ConnectedTabMatch {
  tabId: number;
  channel: string;
  appLabel: string;
}

// Matches on EITHER appLabel or channel (case-sensitive, exact) - a human/
// agent referring to "the tab connected as 'example'" usually means the
// label, but "the tab on channel 'bulletino-ideas'" is just as natural, and
// there's no ambiguity in accepting both since labels and channel names live
// in different namespaces in practice.
export function findConnectedTabs(query: string): ConnectedTabMatch[] {
  const out: ConnectedTabMatch[] = [];
  for (const [tabId, entry] of byTabId) {
    if (entry.appLabel === query || entry.channel === query) {
      out.push({ tabId, ...entry });
    }
  }
  return out;
}

export function listConnectedTabs(): ConnectedTabMatch[] {
  return [...byTabId].map(([tabId, entry]) => ({ tabId, ...entry }));
}
