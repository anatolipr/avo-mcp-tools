// js-bridge-mcp has no production deployment - it only ever runs locally
// (see connect.js's own header comment in packages/js-bridge-mcp), so this
// always targets localhost regardless of what page the extension is acting
// on. Kept here (not re-derived per call site) so background/popup code
// agrees on one value.
export const JSBRIDGE_HOST = 'http://localhost:8766';

// Must match js-bridge-mcp's own VALID_CHANNEL_NAME (connect.js) /
// isValidChannelName (mcp-tenant-lib/src/tenant.ts) exactly - channel names
// become the WS `?tenant=` query param, and the server rejects anything
// outside this set with a 4404 close before a Tenant is ever created.
export const VALID_CHANNEL_NAME = /^[a-zA-Z0-9_-]+$/;

// chrome.storage.local key prefix for known-origin auto-reconnect entries
// (see src/background/storage.ts).
export const KNOWN_ORIGIN_KEY_PREFIX = 'known-origin:';

// chrome.storage.local key for this install's stable appLabel (see
// src/background/extension-connection.ts) and its chosen extension-channel
// name.
export const EXTENSION_LABEL_STORAGE_KEY = 'extension-app-label';
export const EXTENSION_CHANNEL_STORAGE_KEY = 'extension-channel';

// chrome.storage.local key prefix for chat-relay recipes (see
// src/background/relay-recipes-storage.ts, src/shared/recipe-types.ts).
export const RELAY_RECIPE_KEY_PREFIX = 'relay-recipe:';

// Reserved "app tab id" meaning "the extension's own host tools" (see
// host-tool-relay.ts), used wherever a real chrome.tabs.Tab.id is otherwise
// expected in the chat-relay bridging flow (relay-panel.ts's app-tab
// pickers, message-handler.ts's start-relay-bridge/add-app-tab/relay-bus-
// forward handlers, relay-chat-loop.ts's forwardToAppTab). Real tab ids are
// always positive, so -1 can never collide with one.
export const EXTENSION_APP_TAB_SENTINEL = -1;
