// Messages sent between popup/content-script contexts and the background
// service worker via chrome.runtime.sendMessage - distinct from
// mcp-tenant-lib's own ClientMessage/ServerMessage (the WS wire protocol
// to the js-bridge-mcp server), which only the background script speaks.
export type ExtensionRuntimeMessage =
  | { type: 'connect-active-tab'; channel: string; appLabel?: string }
  | { type: 'get-active-tab-status' }
  | { type: 'rename-active-tab'; appLabel: string }
  | { type: 'change-channel-active-tab'; channel: string }
  | { type: 'disconnect-active-tab' };

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
