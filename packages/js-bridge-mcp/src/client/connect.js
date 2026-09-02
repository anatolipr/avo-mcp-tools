// Shared connect-lifecycle module for any page auto-connecting to a locally
// running js-bridge-mcp server via a named CHANNEL (not a session-minted
// tenant UUID) - see packages/js-bridge-mcp/README.md's "Auto-connect on
// page load" section for the full design rationale.
//
// This used to be copy-pasted per host app (mindfoo/src/mcp-connect.ts,
// bulletino-1/mcp-connect.mjs, htmlpaint.com/src/mcp-connect.js - all three
// nearly byte-identical). Hoisted here, alongside tool-bus.js, as another
// hand-written vanilla ES module any host page can import by URL:
//   <script type="module" src="http://<js-bridge-mcp host>/connect.js"></script>
// Deliberately NOT part of main.ts's build (see vite.config.ts's
// copy-client-extras plugin), same reasoning as tool-bus.js: this is
// infrastructure shared across host apps/origins, not app-specific code
// bundled with the bridge itself.
//
// Usage from a host app's own thin per-app module:
//
//   import { createMcpConnect } from 'http://localhost:8766/connect.js';
//   export const mcpConnect = createMcpConnect({ appName: 'htmlpaint' });
//   mcpConnect.init();
//
// Channel identity: js-bridge-mcp's channel support (mcp-tenant-lib 0.3.3+)
// makes a channel name the same string-keyed tenant id main.js accepts via
// the `tenant` query param - so a host app can connect with a fixed,
// human-readable name with zero interaction, and any MCP client can attach
// to the exact same live connection via join_channel("<name>").
//
// Channel:app-name syntax: a chosen channel may be typed as "channel:app" -
// e.g. "bug123:htmlpaint" - to explicitly set BOTH the shared channel
// (join_channel target) and this connection's own app label/tool-name
// prefix in one prompt, letting several different apps deliberately join
// the same channel (like inviting several people into one Slack channel)
// while each still gets a distinct, readable tool prefix instead of
// colliding on "channel" as its own label. Omitting the ":app" part keeps
// the app's own default label.

// js-bridge-mcp has no production deployment - it only ever runs locally,
// launched via `npx` (see packages/js-bridge-mcp), so this always targets
// localhost regardless of where the host app is served from.
const JSBRIDGE_HOST = 'http://localhost:8766';

// Must match js-bridge-mcp's own isValidChannelName (mcp-tenant-lib/src/tenant.ts)
// exactly - channel names become the WS `?tenant=` query param, and the
// server rejects anything outside this set with a 4404 close before a
// Tenant is ever created.
const VALID_CHANNEL_NAME = /^[a-zA-Z0-9_-]+$/;

function sanitizeToValidChannelName(raw) {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

/**
 * Splits a user-typed "channel" or "channel:app" string into its parts.
 * A bare name (no colon) is just the channel, with no app-label override.
 */
function parseChannelInput(input) {
  const idx = input.indexOf(':');
  if (idx === -1) return { channel: input, appLabel: undefined };
  const channel = input.slice(0, idx).trim();
  const appLabel = input.slice(idx + 1).trim();
  return { channel, appLabel: appLabel || undefined };
}

/**
 * @param {object} opts
 * @param {string} opts.appName - Short app-specific identifier, e.g.
 *   "htmlpaint", "bulletino", "mindfoo". Used as: the localStorage key
 *   namespace, the default channel name, and (unless a "channel:app" prompt
 *   input overrides it) the connection's window.__mcpAppName label.
 * @param {string} [opts.defaultChannel] - Defaults to opts.appName.
 * @param {(state: 'disconnected'|'connecting'|'connected', channel: string, appLabel: string) => void} [opts.onStateChange]
 *   Optional convenience callback, called on every state transition - an
 *   alternative to onConnectionStateChange() below for a caller that just
 *   wants one function rather than subscribing.
 * @param {() => Promise<void>|void} [opts.beforeConnect]
 *   Optional hook run once, before the very first main.js import - for a
 *   host page that layers extra tool providers onto window.__mcpTools ahead
 *   of connecting (e.g. bulletino-1 loading tool-bus.js + folderfoo's
 *   provider). Not re-run on a later channel switch/rename - main.js reads
 *   window.__mcpTools fresh on every import, so whatever this hook set up
 *   the first time is still in place for subsequent connects.
 */
export function createMcpConnect(opts) {
  const appName = opts.appName;
  const defaultChannel = opts.defaultChannel ?? appName;
  const CHANNEL_STORAGE_KEY = `${appName}_mcp_channel`;
  const APP_LABEL_STORAGE_KEY = `${appName}_mcp_app_label`;

  function getStored(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function setStored(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore - falls back to the default next load
    }
  }

  let state = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
  let currentChannel = getStored(CHANNEL_STORAGE_KEY, defaultChannel);
  let currentAppLabel = getStored(APP_LABEL_STORAGE_KEY, appName);
  // The live socket's own leave() - set each time connectToChannel opens a
  // new one, so a later switch can tell the OLD socket to leave_channel
  // before this module opens the new one. undefined until the first
  // successful import() below.
  let leaveCurrentSocket;
  let beforeConnectRan = false;
  const stateListeners = new Set();

  function setState(next) {
    state = next;
    for (const cb of stateListeners) cb(state, currentChannel, currentAppLabel);
    opts.onStateChange?.(state, currentChannel, currentAppLabel);
  }

  // Lightweight reachability probe via plain HTTP - main.js's own
  // connectStateSocket doesn't expose connect/disconnect events to the
  // importer, so this is the only way to know "is js-bridge-mcp up" before
  // (and independent of) actually importing main.js.
  async function probeJsBridgeMcp() {
    try {
      const res = await fetch(`${JSBRIDGE_HOST}/main.js`, { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function connectToChannel(channelName, appLabel) {
    // Tell whichever channel we were previously on that we're leaving it
    // BEFORE opening the new socket, so the server can drop that tenant the
    // moment it's empty rather than only after this tab's old socket times
    // out - see leave_channel's own doc comment in mcp-tenant-lib/types.ts.
    // Safe to call unconditionally: a no-op if there's no prior socket, or
    // if other connections remain on that channel.
    leaveCurrentSocket?.();
    leaveCurrentSocket = undefined;

    setState('connecting');
    currentChannel = channelName;
    currentAppLabel = appLabel ?? appName;
    window.__mcpAppName = currentAppLabel;
    setStored(CHANNEL_STORAGE_KEY, currentChannel);
    setStored(APP_LABEL_STORAGE_KEY, currentAppLabel);

    const reachable = await probeJsBridgeMcp();
    if (!reachable) {
      setState('disconnected');
      return;
    }

    if (!beforeConnectRan) {
      beforeConnectRan = true;
      await opts.beforeConnect?.();
    }

    // A fresh import (unique URL per channel/tenant, since main.js reads
    // `tenant` once at module-eval time and exposes no way to retarget an
    // existing connection) - main.js has no export, so this is fire-and-
    // forget; connect/disconnect status past this point is inferred from
    // the probe above plus the module having loaded without throwing.
    try {
      const mod = await import(
        /* @vite-ignore */ `${JSBRIDGE_HOST}/main.js?server=${encodeURIComponent(JSBRIDGE_HOST)}&tenant=${encodeURIComponent(channelName)}&_=${Date.now()}`
      );
      // main.js exposes __mcpLeaveChannel (see main.ts) as a best-effort
      // hook for exactly this - a module-scoped function, not a return
      // value, since main.js has no exports of its own (see its own
      // comment) and is imported purely for its side effects.
      leaveCurrentSocket = typeof window.__mcpLeaveChannel === 'function' ? window.__mcpLeaveChannel : undefined;
      setState('connected');
    } catch {
      setState('disconnected');
    }
  }

  /**
   * Click behavior: connect (or reconnect) if not connected; if already
   * connected, prompt to rename - so a user with multiple tabs open can
   * name each one on purpose instead of ending up with an unlabeled
   * auto-suffixed channel they can't identify later. Accepts a bare channel
   * name ("bug123") or "channel:app-name" ("bug123:htmlpaint") to join a
   * shared channel under an explicit app label distinct from the channel
   * name itself - lets several different apps deliberately land on the same
   * channel (like inviting several people into one Slack channel) while
   * keeping each one's tools under its own readable prefix.
   */
  async function handleConnectClick() {
    const promptCurrent = currentAppLabel === appName ? currentChannel : `${currentChannel}:${currentAppLabel}`;
    if (state === 'connected') {
      let next = prompt('Name this connection (channel, or channel:app-name to share a channel):', promptCurrent);
      if (!next || next === promptCurrent) return;
      let parsed = parseChannelInput(next);
      while (parsed.channel && !VALID_CHANNEL_NAME.test(parsed.channel)) {
        next = prompt(
          `"${parsed.channel}" isn't a valid channel name - only letters, digits, underscore, and hyphen are allowed (no spaces). Try again:`,
          `${sanitizeToValidChannelName(parsed.channel)}${parsed.appLabel ? `:${parsed.appLabel}` : ''}`
        );
        if (!next) return;
        parsed = parseChannelInput(next);
      }
      if (!parsed.channel) return;
      await connectToChannel(parsed.channel, parsed.appLabel);
      return;
    }
    await connectToChannel(currentChannel, currentAppLabel);
  }

  /** Connects automatically on page load - no button click required. */
  async function init() {
    await connectToChannel(currentChannel, currentAppLabel);
  }

  function onConnectionStateChange(cb) {
    stateListeners.add(cb);
    return () => stateListeners.delete(cb);
  }

  function getConnectionState() {
    return { state, channel: currentChannel, appLabel: currentAppLabel };
  }

  return { init, handleConnectClick, onConnectionStateChange, getConnectionState };
}
