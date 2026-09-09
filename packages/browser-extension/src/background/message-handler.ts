import type { ExtensionRuntimeMessage, ConnectActiveTabResult, ActiveTabStatus, ActionResult } from '../shared/types.js';
import { injectConnectSnippet, changeChannel, renameConnection, disconnectTab, tabAlreadyConnected } from './connect-tab.js';
import { getKnownOrigin, setKnownOrigin, deleteKnownOrigin } from './storage.js';
import { markTabConnected } from './auto-reconnect.js';
import { lookupPersistentScriptsForUrl } from './script-injection.js';
import { refreshBadgeForActiveTab } from './connection-badge.js';
import { recordConnectedTab, forgetConnectedTab } from './connected-tabs.js';
import { JSBRIDGE_HOST } from '../shared/constants.js';

// Structural subset of mcp-tenant-lib's DashboardChannel (dashboard.ts) - see
// popup.ts's own former copy of this comment (now folded into the shared
// lookupToolCount helper below, the only remaining caller).
interface DashboardChannel {
  channel: string;
  connections: { label: string | null; toolCount: number }[];
}

// Matches this tab's known channel+label against a fresh /api/dashboard
// snapshot to find its own current tool count - the tab itself has no way
// to know this locally, since tool count is server-side connection state,
// not something window.__mcpLeaveChannel or any other page-side marker
// exposes. Best-effort: returns undefined on any fetch failure or on no
// match (label collision, or the page connected via its own snippet under a
// label this extension never recorded), never throws.
async function lookupToolCount(channel: string, appLabel: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${JSBRIDGE_HOST}/api/dashboard`);
    if (!res.ok) return undefined;
    const channels: DashboardChannel[] = await res.json();
    const match = channels.find((c) => c.channel === channel)?.connections.find((c) => c.label === appLabel);
    return match?.toolCount;
  } catch {
    return undefined;
  }
}

// Content-script -> background messages (console capture relay, persistent
// script lookup) - a separate family from ExtensionRuntimeMessage (popup ->
// background), handled in the same listener since chrome.runtime.onMessage
// has one listener registry per extension.
interface ConsoleCaptureMessage {
  type: 'mcp-console-capture';
  level: string;
  args: string[];
}
interface PersistentScriptLookupMessage {
  type: 'mcp-persistent-script-lookup';
  url: string;
}
type ContentScriptMessage = ConsoleCaptureMessage | PersistentScriptLookupMessage;

function isContentScriptMessage(message: unknown): message is ContentScriptMessage {
  const type = (message as any)?.type;
  return type === 'mcp-console-capture' || type === 'mcp-persistent-script-lookup';
}

export function startMessageHandler(onConsoleCapture: (tabId: number, level: string, args: string[]) => void): void {
  chrome.runtime.onMessage.addListener((message: ExtensionRuntimeMessage | ContentScriptMessage, sender, sendResponse) => {
    if (isContentScriptMessage(message)) {
      if (message.type === 'mcp-console-capture' && sender.tab?.id !== undefined) {
        onConsoleCapture(sender.tab.id, message.level, message.args);
      }
      if (message.type === 'mcp-persistent-script-lookup') {
        sendResponse({ codes: lookupPersistentScriptsForUrl(message.url) });
      }
      return false;
    }

    if (message.type === 'connect-active-tab') {
      handleConnectActiveTab(message.channel, message.appLabel)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies ConnectActiveTabResult));
      return true; // keeps the message channel open for the async sendResponse above
    }

    if (message.type === 'get-active-tab-status') {
      handleGetActiveTabStatus()
        .then(sendResponse)
        .catch(() => sendResponse({ connectable: false, connected: false } satisfies ActiveTabStatus));
      return true;
    }

    if (message.type === 'rename-active-tab') {
      handleRenameActiveTab(message.appLabel)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies ActionResult));
      return true;
    }

    if (message.type === 'change-channel-active-tab') {
      handleChangeChannelActiveTab(message.channel)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies ActionResult));
      return true;
    }

    if (message.type === 'disconnect-active-tab') {
      handleDisconnectActiveTab()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies ActionResult));
      return true;
    }
    return false;
  });
}

async function handleGetActiveTabStatus(): Promise<ActiveTabStatus> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return { connectable: false, connected: false };

  let origin: string;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return { connectable: false, connected: false };
  }
  if (!/^https?:$/.test(new URL(tab.url).protocol)) {
    return { connectable: false, connected: false };
  }

  const [connected, known] = await Promise.all([tabAlreadyConnected(tab.id), getKnownOrigin(origin)]);
  const toolCount = connected && known?.channel && known?.appLabel
    ? await lookupToolCount(known.channel, known.appLabel)
    : undefined;
  return { connectable: true, connected, knownChannel: known?.channel, knownAppLabel: known?.appLabel, toolCount };
}

async function handleConnectActiveTab(channel: string, appLabel?: string): Promise<ConnectActiveTabResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    return { ok: false, error: 'No active tab found.' };
  }
  let origin: string;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return { ok: false, error: `Active tab has no connectable URL (${tab.url}).` };
  }

  // Defaults to the hostname when the popup didn't specify one - stable and
  // readable without asking a human, and (critically) set on window BEFORE
  // main.js imports, which is what suppresses main.ts's own naming prompt.
  // Persisted alongside the channel so auto-reconnect.ts reuses the SAME
  // label on every future silent reconnect of this origin, not a fresh
  // hostname-derived one each time (keeps stash/replay's appLabel-equality
  // matching working across reconnects).
  const resolvedLabel = appLabel || new URL(tab.url).hostname;
  // If already connected, treat this as a channel switch (leaves the
  // current channel first) rather than opening a second, redundant socket -
  // see connect-tab.ts's changeChannel.
  if (await tabAlreadyConnected(tab.id)) {
    await changeChannel(tab.id, channel, resolvedLabel);
  } else {
    await injectConnectSnippet(tab.id, channel, resolvedLabel);
  }
  await setKnownOrigin({ origin, channel, appLabel: resolvedLabel, lastConnectedAt: Date.now() });
  markTabConnected(tab.id);
  recordConnectedTab(tab.id, channel, resolvedLabel);
  await refreshBadgeForActiveTab();

  return { ok: true };
}

async function handleRenameActiveTab(appLabel: string): Promise<ActionResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return { ok: false, error: 'No active tab found.' };
  if (!(await tabAlreadyConnected(tab.id))) {
    return { ok: false, error: 'This tab is not currently connected.' };
  }
  await renameConnection(tab.id, appLabel);
  const origin = new URL(tab.url).origin;
  const known = await getKnownOrigin(origin);
  if (known) {
    await setKnownOrigin({ ...known, appLabel });
    recordConnectedTab(tab.id, known.channel, appLabel);
  }
  await refreshBadgeForActiveTab();
  return { ok: true };
}

async function handleChangeChannelActiveTab(channel: string): Promise<ActionResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return { ok: false, error: 'No active tab found.' };
  let origin: string;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return { ok: false, error: `Active tab has no connectable URL (${tab.url}).` };
  }
  const known = await getKnownOrigin(origin);
  const label = known?.appLabel || new URL(tab.url).hostname;
  await changeChannel(tab.id, channel, label);
  await setKnownOrigin({ origin, channel, appLabel: label, lastConnectedAt: Date.now() });
  markTabConnected(tab.id);
  recordConnectedTab(tab.id, channel, label);
  await refreshBadgeForActiveTab();
  return { ok: true };
}

// Closes the live connection AND forgets this origin's known-origin entry -
// a page reload after Disconnect must NOT silently reconnect (that's the
// whole point of a human clicking Disconnect); auto-reconnect.ts only ever
// fires for an origin getKnownOrigin() can find, so deleting the entry is
// what actually stops it. A later manual Connect writes a fresh entry and
// re-arms auto-reconnect for this origin, same as connecting it for the
// first time.
async function handleDisconnectActiveTab(): Promise<ActionResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return { ok: false, error: 'No active tab found.' };
  await disconnectTab(tab.id);
  forgetConnectedTab(tab.id);
  try {
    const origin = new URL(tab.url).origin;
    await deleteKnownOrigin(origin);
  } catch {
    // tab.url wasn't a parseable URL - nothing to forget
  }
  await refreshBadgeForActiveTab();
  return { ok: true };
}
