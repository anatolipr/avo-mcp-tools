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
  | { type: 'start-relay-bridge'; chatTabId: number; appTabId: number; recipeId: string }
  // Sent by the chat tab's OWN injected relay-bus-isolated.ts script, never
  // by the popup - the background never initiates this, only responds. See
  // relay-chat-loop.ts's header comment: this is opaque transport, the
  // background never inspects `code`'s contents.
  | { type: 'relay-bus-forward'; targetTabId: number; code: string }
  // Popup-initiated, one-shot read of window.__mcpRelayStats from the given
  // tab (see relay-chat-loop.ts) - does NOT involve any background state,
  // just a direct injectScriptOnce read, same mechanism as relay-bus-forward
  // but for a human checking status rather than the loop relaying a call.
  | { type: 'relay-check-status'; chatTabId: number };

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
