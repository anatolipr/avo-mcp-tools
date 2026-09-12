import type {
  ExtensionRuntimeMessage,
  ConnectActiveTabResult,
  ActiveTabStatus,
  ActionResult,
  ListRecipesResult,
  SaveRecipeResult,
  StartRelayBridgeResult,
  RelayBusForwardResult,
  RelayCheckStatusResult,
  RelayPingTabResult,
  RelayListAppTabsResult,
  AddAppTabResult,
  RunHostToolCallResult,
  GetRelayPrimerResult,
  SetExtensionSessionNameResult,
} from '../shared/types.js';
import { injectConnectSnippet, changeChannel, renameConnection, disconnectTab, tabAlreadyConnected } from './connect-tab.js';
import { getKnownOrigin, setKnownOrigin, deleteKnownOrigin } from './storage.js';
import { markTabConnected } from './auto-reconnect.js';
import { lookupPersistentScriptsForUrl, injectScriptOnce } from './script-injection.js';
import { refreshBadgeForActiveTab } from './connection-badge.js';
import { recordConnectedTab, forgetConnectedTab } from './connected-tabs.js';
import { JSBRIDGE_HOST, EXTENSION_APP_TAB_SENTINEL } from '../shared/constants.js';
import { listRecipes, saveRecipe, deleteRecipe, listRecipeIds, getRecipe } from './relay-recipes-storage.js';
import { validateRecipe } from '../shared/recipe-validator.js';
import { buildChatLoopConfig, chatLoopMainFunction } from './relay-chat-loop.js';
import { relayBusIsolatedFunction } from './relay-bus-isolated.js';
import { runCallAgainstHostTools, buildExtensionPrimer, getExtensionSessionName, setExtensionSessionName } from './host-tool-relay.js';

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
    // /api/dashboard now returns { channels, root } (see mcp-tenant-lib's
    // dashboard.ts) — root connections (a bare, colon-less channel name
    // this extension itself might use) live in `root`, flattened one row
    // per connection, not nested under `.connections` the way a real
    // channel is.
    const { channels, root }: { channels: DashboardChannel[]; root: { name: string; label: string | null; toolCount: number }[] } = await res.json();
    const channelMatch = channels.find((c) => c.channel === channel)?.connections.find((c) => c.label === appLabel);
    if (channelMatch) return channelMatch.toolCount;
    const rootMatch = root.find((r) => r.name === channel || r.label === appLabel);
    return rootMatch?.toolCount;
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

    if (message.type === 'list-recipes') {
      listRecipes()
        .then((recipes) => sendResponse({ recipes } satisfies ListRecipesResult))
        .catch((err) => sendResponse({ recipes: [], error: String(err?.message ?? err) }));
      return true;
    }

    if (message.type === 'save-recipe') {
      handleSaveRecipe(message.recipe)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, errors: [String(err?.message ?? err)] } satisfies SaveRecipeResult));
      return true;
    }

    if (message.type === 'delete-recipe') {
      deleteRecipe(message.id)
        .then(() => sendResponse({ ok: true } satisfies ActionResult))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies ActionResult));
      return true;
    }

    if (message.type === 'start-relay-bridge') {
      handleStartRelayBridge(message.chatTabId, message.appTabId, message.recipeId, message.assignTag)
        .then((result) => sendResponse(result satisfies StartRelayBridgeResult))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies StartRelayBridgeResult));
      return true;
    }

    if (message.type === 'relay-bus-forward') {
      // OPAQUE transport for a real tab target - `message.code` is never
      // inspected or parsed here, only forwarded via injectScriptOnce. See
      // relay-chat-loop.ts's header comment: this handler has no idea it's
      // carrying a HUMAN-MCP CALL/RESULT, and that's by design.
      //
      // The one deliberate exception: EXTENSION_APP_TAB_SENTINEL means
      // there's no tab to inject into at all - relay-chat-loop.ts's
      // forwardToAppTab sends the RAW HUMAN-MCP CALL text as `code` in this
      // case (not an injectable JS snippet), so it can go straight to
      // runCallAgainstHostTools instead.
      if (message.targetTabId === EXTENSION_APP_TAB_SENTINEL) {
        runCallAgainstHostTools(message.code, getExtensionSessionName())
          .then((result) => sendResponse({ ok: true, result } satisfies RelayBusForwardResult))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies RelayBusForwardResult));
        return true;
      }
      injectScriptOnce(message.targetTabId, message.code)
        .then((result) => sendResponse({ ok: true, result: typeof result === 'string' ? result : String(result) } satisfies RelayBusForwardResult))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies RelayBusForwardResult));
      return true;
    }

    if (message.type === 'relay-check-status') {
      handleRelayCheckStatus(message.chatTabId)
        .then((result) => sendResponse(result satisfies RelayCheckStatusResult))
        .catch((err) => sendResponse({ active: false, error: String(err?.message ?? err) } satisfies RelayCheckStatusResult));
      return true;
    }

    if (message.type === 'relay-ping-tab') {
      handleRelayPingTab(message.tabId)
        .then((result) => sendResponse(result satisfies RelayPingTabResult))
        .catch(() => sendResponse({ ok: false } satisfies RelayPingTabResult));
      return true;
    }

    if (message.type === 'relay-list-app-tabs') {
      handleRelayListAppTabs(message.chatTabId)
        .then((result) => sendResponse(result satisfies RelayListAppTabsResult))
        .catch((err) => sendResponse({ active: false, appTabs: {}, error: String(err?.message ?? err) } satisfies RelayListAppTabsResult));
      return true;
    }

    if (message.type === 'add-app-tab') {
      handleAddAppTab(message.chatTabId, message.appTabId, message.assignTag)
        .then((result) => sendResponse(result satisfies AddAppTabResult))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies AddAppTabResult));
      return true;
    }

    if (message.type === 'run-host-tool-call') {
      runCallAgainstHostTools(message.callText, message.sessionName)
        .then((resultText) => sendResponse({ ok: true, resultText } satisfies RunHostToolCallResult))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies RunHostToolCallResult));
      return true;
    }

    if (message.type === 'get-relay-primer') {
      try {
        sendResponse({ ok: true, primer: buildExtensionPrimer(message.sessionName) } satisfies GetRelayPrimerResult);
      } catch (err) {
        sendResponse({ ok: false, error: String((err as Error)?.message ?? err) } satisfies GetRelayPrimerResult);
      }
      return false;
    }

    if (message.type === 'set-extension-session-name') {
      setExtensionSessionName(message.tag);
      sendResponse({ ok: true } satisfies SetExtensionSessionNameResult);
      return false;
    }

    return false;
  });
}

// Re-validates server-side too (defense in depth), not just trusting the
// popup's own client-side validateRecipe call - the popup's check exists
// mainly to give a human a fast, DOM-backed selector-syntax check before
// upload; this call is what actually decides whether the recipe is stored.
async function handleSaveRecipe(rawRecipe: unknown): Promise<SaveRecipeResult> {
  const existingIds = await listRecipeIds();
  const result = validateRecipe(rawRecipe, existingIds);
  if (!result.ok) return { ok: false, errors: result.errors };
  await saveRecipe(result.recipe);
  return { ok: true };
}

// Injects relay-chat-loop.ts's MAIN-world loop and relay-bus-isolated.ts's
// ISOLATED-world relay half into the chat tab, once. This is the ENTIRE
// extension-side involvement in a bridging session - after this call
// returns, the background holds no record of the session at all (no
// registry, no session id); the chat tab's own injected code owns
// everything from here, reaching back into the background only via
// relay-bus-forward messages it initiates itself. Stopping a bridge means
// reloading or closing the chat tab, not any message this background sends.
async function handleStartRelayBridge(chatTabId: number, appTabId: number, recipeId: string, assignTag?: string): Promise<StartRelayBridgeResult> {
  const recipe = await getRecipe(recipeId);
  if (!recipe) return { ok: false, error: `No recipe found with id "${recipeId}".` };

  // `assignTag`, if given (see relay-panel.ts's "Session name" field under
  // Start bridging), names this app up front - written into ITS OWN
  // human-mcp-relay before anything else, same helper and reasoning as
  // handleAddAppTab's own assignTag handling below.
  if (assignTag) {
    try {
      await assignSessionNameOnAppTab(appTabId, assignTag);
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  }

  // Best-effort: fetch the current primer from the app tab so the loop can
  // send it as its first message, replacing the human's own "copy primer,
  // paste into chat tab" step. Not fatal if this fails (e.g. the app tab
  // doesn't have human-mcp-relay loaded, or its window.__humanMcpRelay
  // predates the getPrimer addition) - the human is expected to have
  // already pasted a primer manually in that case, same as before this
  // existed, so start-relay-bridge still succeeds either way.
  let initialPrimer: string | undefined;
  if (appTabId === EXTENSION_APP_TAB_SENTINEL) {
    initialPrimer = buildExtensionPrimer();
  } else {
    try {
      const primerCode = "return (typeof window.__humanMcpRelay?.getPrimer === 'function') ? window.__humanMcpRelay.getPrimer() : undefined;";
      const result = await injectScriptOnce(appTabId, primerCode);
      if (typeof result === 'string' && result.length > 0) initialPrimer = result;
    } catch {
      // ignored - see comment above
    }
  }

  // The app's human-mcp-relay session name (possibly '' if unset) becomes
  // this app tab's tag in the chat loop's win.__mcpRelayAppTabs map - see
  // relay-chat-loop.ts. Read via the same ping() used to vet "Add app tab"
  // candidates (handleRelayPingTab below), so a first bridged app and one
  // added later are tagged identically either way.
  const ping = await pingAppTab(appTabId);
  const appTag = ping?.sessionName ?? '';

  const config = buildChatLoopConfig(appTabId, appTag, recipe, initialPrimer);
  await chrome.scripting.executeScript({
    target: { tabId: chatTabId },
    world: 'ISOLATED',
    func: relayBusIsolatedFunction,
  });
  await chrome.scripting.executeScript({
    target: { tabId: chatTabId },
    world: 'MAIN',
    func: chatLoopMainFunction,
    args: [JSON.stringify(config)],
  });

  return { ok: true };
}

// Shared by handleStartRelayBridge and handleAddAppTab - writes a
// human-chosen session name into an app tab's OWN human-mcp-relay via
// window.__humanMcpRelay.setSessionName, BEFORE that tab is pinged/primed,
// so its own popup UI (if later opened) shows the same name the LLM is
// told to address it by - see relay.js's setSessionName comment. Throws
// (callers turn this into an error response) rather than silently ignoring
// failure, unlike this file's other best-effort injectScriptOnce calls -
// unlike a missing primer, a human who explicitly typed a tag expects it to
// actually be set, not silently dropped.
async function assignSessionNameOnAppTab(appTabId: number, tag: string): Promise<void> {
  if (appTabId === EXTENSION_APP_TAB_SENTINEL) {
    setExtensionSessionName(tag);
    return;
  }
  const code =
    "if (typeof window.__humanMcpRelay?.setSessionName !== 'function') { throw new Error('This tab\\'s human-mcp-relay is too old to support setSessionName - reload the tab to pick up the latest version.'); } window.__humanMcpRelay.setSessionName(" +
    JSON.stringify(tag) +
    ');';
  await injectScriptOnce(appTabId, code);
}

// Shared by handleStartRelayBridge (to learn the first app tab's tag) and
// handleRelayPingTab (the popup's own vetting probe) - a one-shot
// injectScriptOnce call of window.__humanMcpRelay.ping(), see relay.js.
// Returns undefined (never throws) on any failure - an unreachable or
// human-mcp-relay-less tab is simply not a valid candidate/tag source.
async function pingAppTab(tabId: number): Promise<{ ok: boolean; version?: string; sessionName?: string } | undefined> {
  if (tabId === EXTENSION_APP_TAB_SENTINEL) {
    // Always ready - there's no real page to reach, so this never fails the
    // way a closed/navigated-away/unscriptable real tab would.
    return { ok: true, version: 'extension', sessionName: getExtensionSessionName() };
  }
  try {
    const code = "return (typeof window.__humanMcpRelay?.ping === 'function') ? JSON.stringify(window.__humanMcpRelay.ping()) : undefined;";
    const result = await injectScriptOnce(tabId, code);
    if (typeof result !== 'string' || result.length === 0) return undefined;
    return JSON.parse(result) as { ok: boolean; version?: string; sessionName?: string };
  } catch {
    return undefined;
  }
}

async function handleRelayPingTab(tabId: number): Promise<RelayPingTabResult> {
  const result = await pingAppTab(tabId);
  return result?.ok ? { ok: true, version: result.version, sessionName: result.sessionName } : { ok: false };
}

// One-shot read of window.__mcpRelayAppTabs (see relay-chat-loop.ts) from
// the given chat tab - purely for the popup to know which app tabs are
// already bridged, so "Add app tab" can exclude them. Same
// injectScriptOnce mechanism and active-flag semantics as
// handleRelayCheckStatus.
async function handleRelayListAppTabs(chatTabId: number): Promise<RelayListAppTabsResult> {
  const code =
    'return window.__mcpRelayAppTabs ? JSON.stringify({ active: !!window.__mcpRelayLoopActive, appTabs: window.__mcpRelayAppTabs }) : JSON.stringify({ active: false, appTabs: {} });';
  const result = await injectScriptOnce(chatTabId, code);
  if (typeof result !== 'string') return { active: false, appTabs: {}, error: 'relay-list-app-tabs: injected script returned no result.' };
  return JSON.parse(result) as RelayListAppTabsResult;
}

// Adds a second (or further) app tab to an already-running bridge, by
// invoking win.__mcpRelayAddAppTab inside the chat tab's own running loop
// (see relay-chat-loop.ts) - the only extension-side involvement in "Add
// app tab" beyond fetching this new app's primer/tag, mirroring
// handleStartRelayBridge's own best-effort primer fetch. Fails if the chat
// tab has no loop running (reloaded/closed since bridging started - see
// this package's "refresh releases the extension from this mode" design),
// the app tab has no human-mcp-relay loaded, or its tag is already bridged
// (checked both here, defense in depth, and by win.__mcpRelayAddAppTab
// itself inside the chat tab).
//
// `assignTag`, if given (see relay-panel.ts's inline prompt), is written
// into the app tab's OWN human-mcp-relay via window.__humanMcpRelay.
// setSessionName BEFORE fetching its primer - two untagged app tabs are
// indistinguishable both to this loop's routing map and to the LLM's own
// sentinel-tag protocol, so a second app tab with no name of its own MUST
// be given one before it can be usefully added; the popup is expected to
// have already confirmed this is needed (via relay-ping-tab's sessionName)
// before sending assignTag, but this also works as a plain rename even when
// not strictly required. Setting it here (not just passing it as this
// call's own tag) keeps that app tab's own popup UI in sync with what the
// LLM is told to call it - see relay.js's setSessionName comment.
async function handleAddAppTab(chatTabId: number, appTabId: number, assignTag?: string): Promise<AddAppTabResult> {
  if (assignTag) {
    try {
      await assignSessionNameOnAppTab(appTabId, assignTag);
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  }

  const ping = await pingAppTab(appTabId);
  if (!ping?.ok) return { ok: false, error: 'The selected tab does not appear to have human-mcp-relay loaded (ping failed).' };
  const appTag = ping.sessionName ?? '';

  let primer: string | undefined;
  if (appTabId === EXTENSION_APP_TAB_SENTINEL) {
    primer = buildExtensionPrimer();
  } else {
    try {
      const primerCode = "return (typeof window.__humanMcpRelay?.getPrimer === 'function') ? window.__humanMcpRelay.getPrimer() : undefined;";
      const result = await injectScriptOnce(appTabId, primerCode);
      if (typeof result === 'string' && result.length > 0) primer = result;
    } catch {
      // Best-effort, same as handleStartRelayBridge - the human can paste it
      // manually if this fails.
    }
  }

  const code =
    "return (async () => { if (!window.__mcpRelayAddAppTab) { throw new Error('No relay bridge is running on this tab - has it been reloaded since bridging started?'); } window.__mcpRelayAddAppTab(" +
    JSON.stringify(appTag) +
    ', ' +
    JSON.stringify(appTabId) +
    ', ' +
    JSON.stringify(primer ?? '') +
    "); return 'ok'; })();";
  try {
    await injectScriptOnce(chatTabId, code);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
  return { ok: true };
}

// One-shot read of window.__mcpRelayStats (see relay-chat-loop.ts) from the
// given tab - purely for a human to check "is this still running, what's it
// doing" from the popup. Uses the same injectScriptOnce every other one-shot
// read in this package uses; involves no background state of any kind.
async function handleRelayCheckStatus(chatTabId: number): Promise<RelayCheckStatusResult> {
  const code = 'return window.__mcpRelayStats ? JSON.stringify({ active: !!window.__mcpRelayLoopActive, ...window.__mcpRelayStats }) : JSON.stringify({ active: false });';
  const result = await injectScriptOnce(chatTabId, code);
  if (typeof result !== 'string') return { active: false, error: 'relay-check-status: injected script returned no result.' };
  return JSON.parse(result) as RelayCheckStatusResult;
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
  // An empty `channel` (the popup's "no channel picked" case) means ROOT,
  // not an error - default the connect string to the same hostname-derived
  // name resolvedLabel already uses, so the tab becomes its own root
  // connection with matching name/label, exactly like connect.js's own
  // `defaultChannel ?? appName` default.
  const connectString = channel || resolvedLabel;
  // If already connected, treat this as a channel switch (leaves the
  // current channel first) rather than opening a second, redundant socket -
  // see connect-tab.ts's changeChannel.
  if (await tabAlreadyConnected(tab.id)) {
    await changeChannel(tab.id, connectString, resolvedLabel);
  } else {
    await injectConnectSnippet(tab.id, connectString, resolvedLabel);
  }
  await setKnownOrigin({ origin, channel: connectString, appLabel: resolvedLabel, lastConnectedAt: Date.now() });
  markTabConnected(tab.id);
  recordConnectedTab(tab.id, connectString, resolvedLabel);
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
