// Messages sent between popup/content-script contexts and the background
// service worker via chrome.runtime.sendMessage - distinct from
// mcp-tenant-lib's own ClientMessage/ServerMessage (the WS wire protocol
// to the js-bridge-mcp server), which only the background script speaks.
export type ExtensionRuntimeMessage =
  | { type: 'connect-active-tab'; channel: string; appLabel?: string }
  | { type: 'get-active-tab-status' }
  | { type: 'rename-active-tab'; appLabel: string }
  | { type: 'change-channel-active-tab'; channel: string }
  | { type: 'disconnect-active-tab' }
  | { type: 'list-recipes' }
  | { type: 'save-recipe'; recipe: unknown }
  | { type: 'delete-recipe'; id: string }
  // `assignTag`, if given, is written into the app tab's own human-mcp-relay
  // via setSessionName BEFORE bridging - lets the human name the first app
  // up front (see relay-panel.ts's "Session name" field under Start
  // bridging) instead of only discovering it was left untagged later, when
  // a second "Add app tab" needs a name to disambiguate against it. Optional
  // here (unlike add-app-tab's assignTag, which becomes required once a
  // second app tab is untagged) since a lone app tab has nothing to collide
  // with yet.
  | { type: 'start-relay-bridge'; chatTabId: number; appTabId: number; recipeId: string; assignTag?: string }
  // Sent by the chat tab's OWN injected relay-bus-isolated.ts script, never
  // by the popup - the background never initiates this, only responds. See
  // relay-chat-loop.ts's header comment: this is opaque transport, the
  // background never inspects `code`'s contents.
  | { type: 'relay-bus-forward'; targetTabId: number; code: string }
  // Popup-initiated, one-shot read of window.__mcpRelayStats from the given
  // tab (see relay-chat-loop.ts) - does NOT involve any background state,
  // just a direct injectScriptOnce read, same mechanism as relay-bus-forward
  // but for a human checking status rather than the loop relaying a call.
  | { type: 'relay-check-status'; chatTabId: number }
  // Popup-initiated vetting probe: one-shot inject-and-call of
  // window.__humanMcpRelay.ping() on a candidate tab, used to decide
  // whether it's offered as an "Add app tab" option at all. Distinct from
  // relay-check-status (which reads a CHAT tab's loop state) - this probes
  // an APP tab for human-mcp-relay's mere presence/readiness.
  | { type: 'relay-ping-tab'; tabId: number }
  // Popup-initiated read of the chat tab's own win.__mcpRelayAppTabs map
  // (see relay-chat-loop.ts) - lets the popup show which app tabs are
  // already bridged, so it can exclude them from the "Add app tab" list.
  // Same one-shot injectScriptOnce mechanism as relay-check-status.
  | { type: 'relay-list-app-tabs'; chatTabId: number }
  // Popup-initiated: adds a second (or further) app tab to an ALREADY
  // running bridge on chatTabId, keyed by that app tab's human-mcp-relay
  // session name/tag. Fetches the new app's primer server-side (same
  // best-effort injectScriptOnce read start-relay-bridge already does) and
  // hands it to the chat tab's own win.__mcpRelayAddAppTab, which enqueues
  // it as a chat message and registers the tag -> tab id mapping - all
  // still inside that one page's realm, not the background. `assignTag`,
  // if given, is written into the app tab's own human-mcp-relay via
  // setSessionName BEFORE anything else - required when that tab's
  // sessionName is empty (two untagged app tabs can never be routed to or
  // addressed by the LLM distinctly), and the popup is expected to have
  // already prompted for it in that case (see relay-panel.ts).
  | { type: 'add-app-tab'; chatTabId: number; appTabId: number; assignTag?: string };

export interface ConnectActiveTabResult {
  ok: boolean;
  error?: string;
}

// Response to 'get-active-tab-status' - lets the popup show "Connected to
// <channel>" instead of always presenting the same blank picker, even on a
// tab that's already live.
export interface ActiveTabStatus {
  // false when there's no active tab, or it's not a connectable http(s) URL
  // (chrome://, about:, a PDF viewer, etc.) - see connect-tab.ts's own
  // scriptable-page assumption.
  connectable: boolean;
  // True result of querying the page itself (window.__mcpLeaveChannel) -
  // the same check auto-reconnect.ts's tabAlreadyConnected() performs.
  connected: boolean;
  // The channel/appLabel this origin was last connected to, if ever - may be
  // present even when `connected` is false (e.g. the page hasn't loaded the
  // snippet yet, or the connection dropped), used to pre-fill the picker.
  knownChannel?: string;
  knownAppLabel?: string;
  // Number of MCP tools this tab's own connection is currently exposing -
  // looked up server-side from /api/dashboard by matching knownChannel +
  // knownAppLabel against that channel's connections. Undefined when not
  // connected, or when this tab's connection can't be matched there (label
  // collision, or the page connected via its own snippet with a label this
  // extension never recorded).
  toolCount?: number;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

// Mirrors src/background/storage.ts's KnownOriginEntry shape.
export interface KnownOriginEntry {
  origin: string;
  channel: string;
  appLabel?: string;
  lastConnectedAt: number;
}

// Response to 'list-recipes'.
export interface ListRecipesResult {
  recipes: import('./recipe-types.js').Recipe[];
}

// Response to 'save-recipe' - errors is populated (and ok is false) when
// validateRecipe rejected the uploaded JSON; see recipe-validator.ts.
export interface SaveRecipeResult {
  ok: boolean;
  errors?: string[];
}

// Response to 'start-relay-bridge'.
export interface StartRelayBridgeResult {
  ok: boolean;
  error?: string;
}

// Response to 'relay-bus-forward' - result is the injected script's return
// value (expected to be a string, the HUMAN-MCP RESULT text, but this type
// doesn't enforce that - the background never inspects it either way).
export interface RelayBusForwardResult {
  ok: boolean;
  result?: string;
  error?: string;
}

// Response to 'relay-check-status' - mirrors relay-chat-loop.ts's
// window.__mcpRelayStats shape. `active` is false (with everything else
// undefined) when the tab has no loop running at all - either it was never
// started, or the tab was reloaded/closed since (which clears the flag
// along with the whole JS realm).
export interface RelayCheckStatusResult {
  active: boolean;
  startedAt?: number;
  pollCount?: number;
  lastPollAt?: number;
  roundsCompleted?: number;
  lastError?: string;
  error?: string;
}

// Response to 'relay-ping-tab' - mirrors human-mcp-relay's own
// window.__humanMcpRelay.ping() return shape. `ok: false` (with no
// version/sessionName) covers both "no human-mcp-relay on this tab at all"
// and "couldn't be reached" (e.g. a chrome://, PDF viewer, or otherwise
// unscriptable tab) - the popup treats either the same way: don't offer it.
export interface RelayPingTabResult {
  ok: boolean;
  version?: string;
  sessionName?: string;
}

// Response to 'relay-list-app-tabs' - mirrors relay-chat-loop.ts's own
// win.__mcpRelayAppTabs shape (tag -> app tab id; '' key = untagged).
// `active: false` means the chat tab has no bridge loop running at all
// (never started, or reloaded/closed since), matching
// RelayCheckStatusResult's own `active` semantics.
export interface RelayListAppTabsResult {
  active: boolean;
  appTabs: Record<string, number>;
  error?: string;
}

// Response to 'add-app-tab'.
export interface AddAppTabResult {
  ok: boolean;
  error?: string;
}
