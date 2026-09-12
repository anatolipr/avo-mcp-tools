// Shared connect-lifecycle module for any page auto-connecting to a locally
// running js-bridge-mcp server - see packages/js-bridge-mcp/README.md's
// "Auto-connect on page load" section for the full design rationale.
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
// ROOT vs CHANNEL (breaking change from the old "always a channel" model):
// a bare name (no colon), e.g. "htmlpaint", is now a ROOT connection -
// addressed directly by name, with its tools always prefixed
// "htmlpaint__..." and merged into every MCP session automatically, no
// join_channel needed (mcp-tenant-lib's describe_connection can inspect one
// by name). Typing "channel:app-name" - e.g. "bug123:htmlpaint" - instead
// joins the REAL, agent-joinable channel "bug123" under connection name
// "htmlpaint", letting several different apps deliberately share one
// channel (like inviting several people into one Slack channel) while each
// keeps its own readable tool prefix. There is no longer an implicit shared
// "default" channel: omitting opts.defaultChannel just makes this app its
// own root connection named after opts.appName.

// js-bridge-mcp has no production deployment - it only ever runs locally,
// launched via `npx` (see packages/js-bridge-mcp), so this always targets
// localhost regardless of where the host app is served from.
const JSBRIDGE_HOST = 'http://localhost:8766';

// Must match js-bridge-mcp's own isValidChannelName (mcp-tenant-lib/src/tenant.ts)
// exactly - channel names become the WS `?tenant=` query param, and the
// server rejects anything outside this set with a 4404 close before a
// Tenant is ever created. Exported (along with parseChannelInput/
// sanitizeToValidChannelName below) so the dashboard's own copy-snippet
// button (dashboard-app.ts) can reuse the exact same validation instead of
// duplicating it - the dashboard is bundled via vite.dashboard.config.ts,
// so it CAN statically import this file at build time, unlike a
// cross-origin host page which only ever reaches this module via a
// runtime URL fetch.
export const VALID_CHANNEL_NAME = /^[a-zA-Z0-9_-]+$/;

export function sanitizeToValidChannelName(raw) {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

/**
 * Splits a user-typed connection string into root-vs-channel parts. A bare
 * name (no colon) means a ROOT connection named `input` - `channel` comes
 * back undefined. "channel:app" means real channel `channel` with connection
 * name `app` inside it. Split on the FIRST colon only, so an app name may
 * itself contain colons. An empty channel before the colon (":foo") is left
 * for the caller to reject via VALID_CHANNEL_NAME, same as any other invalid
 * channel string - this function does no validation itself.
 */
export function parseChannelInput(input) {
  const idx = input.indexOf(':');
  if (idx === -1) return { channel: undefined, appLabel: input.trim() || undefined };
  const channel = input.slice(0, idx).trim();
  const appLabel = input.slice(idx + 1).trim();
  return { channel, appLabel: appLabel || undefined };
}

/**
 * @param {object} opts
 * @param {string} opts.appName - Short app-specific identifier, e.g.
 *   "htmlpaint", "bulletino", "mindfoo". Used as: the localStorage key
 *   namespace, this app's default ROOT connection name (unless
 *   opts.defaultChannel or a prompt input overrides it), and (unless a
 *   "channel:app" prompt input overrides it) the connection's
 *   window.__mcpAppName label.
 * @param {string} [opts.defaultChannel] - The raw connect string used before
 *   any human retargets via handleConnectClick's prompt. Defaults to
 *   opts.appName - i.e. this app becomes its own root connection, addressed
 *   directly by name with no channel needed. Pass a "channel:app-name"
 *   string instead to have this app join a real channel by default.
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

  // Reacts to a server-pushed "move to channel" (mcp-tenant-lib's
  // Tenant.moveConnection) that main.js already carried out on its own by
  // reconnecting - see main.ts's onMove handler. That reconnect goes
  // straight to a fresh main.js import, bypassing connectToChannel (and
  // therefore this module's own bookkeeping) entirely - main.js has no way
  // to know this page is even using connect.js. Without this listener,
  // currentChannel/localStorage would go stale after a move: a page reload
  // would reconnect to the channel this connection was moved OFF of, and
  // any UI reading getConnectionState()/onConnectionStateChange would keep
  // showing the pre-move channel. main.js dispatches this event on
  // `window` only after its own reconnect resolves, so
  // window.__mcpLeaveChannel already points at the NEW socket by the time
  // this runs. Deliberately does not touch currentAppLabel/its storage key -
  // a move only ever changes which channel a connection is on, never its
  // app label (main.ts's onMove preserves the label across the move itself).
  window.addEventListener('mcp-bridge-moved', (event) => {
    const channel = event.detail?.channel;
    if (!channel || channel === currentChannel) return;
    currentChannel = channel;
    setStored(CHANNEL_STORAGE_KEY, currentChannel);
    leaveCurrentSocket = typeof window.__mcpLeaveChannel === 'function' ? window.__mcpLeaveChannel : undefined;
    setState('connected');
  });

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

  async function connectToChannel(connectString, appLabel) {
    // Tell whichever channel we were previously on that we're leaving it
    // BEFORE opening the new socket, so the server can drop that tenant the
    // moment it's empty rather than only after this tab's old socket times
    // out - see leave_channel's own doc comment in mcp-tenant-lib/types.ts.
    // Safe to call unconditionally: a no-op if there's no prior socket, or
    // if other connections remain on that channel.
    leaveCurrentSocket?.();
    leaveCurrentSocket = undefined;

    setState('connecting');
    currentChannel = connectString;
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

    // `connectString` is passed through to `?tenant=` exactly as typed (bare
    // name -> root connection, "channel:name" -> real channel) - the
    // server (ws.ts) does the colon interpretation, so this module doesn't
    // need to know the root-tenant-id namespacing convention at all. A fresh
    // import (unique URL per tenant, since main.js reads `tenant` once at
    // module-eval time and exposes no way to retarget an existing
    // connection) - main.js has no export, so this is fire-and-forget;
    // connect/disconnect status past this point is inferred from the probe
    // above plus the module having loaded without throwing.
    try {
      const mod = await import(
        /* @vite-ignore */ `${JSBRIDGE_HOST}/main.js?server=${encodeURIComponent(JSBRIDGE_HOST)}&tenant=${encodeURIComponent(connectString)}&_=${Date.now()}`
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
   * auto-suffixed connection they can't identify later. A bare name
   * ("htmlpaint2") means a root connection with that name; "channel:app-name"
   * ("bug123:htmlpaint") joins the real channel "bug123" under connection
   * name "htmlpaint" - lets several different apps deliberately share one
   * channel (like inviting several people into one Slack channel) while
   * keeping each one's tools under its own readable prefix.
   */
  async function handleConnectClick() {
    if (state === 'connected') {
      let next = prompt('Name this connection (or "channel:name" to join a shared channel):', currentChannel);
      if (!next || next === currentChannel) return;
      let parsed = parseChannelInput(next);
      while (parsed.channel !== undefined && !VALID_CHANNEL_NAME.test(parsed.channel)) {
        next = prompt(
          `"${parsed.channel}" isn't a valid channel name - only letters, digits, underscore, and hyphen are allowed (no spaces). Try again:`,
          `${sanitizeToValidChannelName(parsed.channel)}${parsed.appLabel ? `:${parsed.appLabel}` : ''}`
        );
        if (!next) return;
        parsed = parseChannelInput(next);
      }
      await connectToChannel(next, parsed.appLabel);
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
