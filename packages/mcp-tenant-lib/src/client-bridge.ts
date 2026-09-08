import type { ServerMessage, ClientMessage, ToolManifestEntry, ToolParamSpec } from './types.js';

export interface ClientAction {
  name: string;
  resolve: 'window' | ((args: any) => unknown | Promise<unknown>);
}

/**
 * The page-authored form of a manifest entry: same shape as
 * ToolManifestEntry (name/description/params/example) plus a real function
 * reference. Pages build an array of these (e.g. assigned to a global like
 * window.__mcpTools) and pass it to registerPageTools below — the function
 * reference never goes over the wire, only the serializable fields do.
 */
export interface PageToolDef {
  name: string;
  description: string;
  params: Record<string, ToolParamSpec>;
  example?: Record<string, unknown>;
  fn: (args: any) => unknown | Promise<unknown>;
  /** See ToolManifestEntry's own doc comment (types.ts) - carried through splitPageTools unchanged. */
  source?: 'dynamic' | 'host';
  /** See ToolManifestEntry's own doc comment (types.ts) - carried through splitPageTools unchanged. */
  origin?: { kind: 'code'; code: string } | { kind: 'path'; path: string };
}

/**
 * Reserved Tenant.call `name` values used by the remote tool
 * registration/unregistration feature (register_page_tool_by_path/_by_code,
 * unregister_page_tool - see manifest-tools.ts). These ride on the existing
 * generic call/call_result round trip rather than adding new wire-protocol
 * message types - a page's onCall handler special-cases these three names
 * (never real page tools, never sent in a register_tools manifest) instead
 * of dispatching to fnByName. Exported here (the confirmed browser-safe
 * boundary both server code and page bridge code can import) so the server
 * side (manifest-tools.ts) and the browser side (e.g. js-bridge-mcp's
 * main.ts) share one source of truth for the three magic strings instead of
 * each hand-typing them and risking drift.
 */
export const REMOTE_REGISTER_BY_PATH_CALL = '__register_tool_by_path__';
export const REMOTE_REGISTER_BY_CODE_CALL = '__register_tool_by_code__';
export const REMOTE_UNREGISTER_CALL = '__unregister_tool__';

/**
 * Reserved Tenant.call name for request_reconnect (see manifest-tools.ts).
 * Same ride-on-the-existing-call/call_result-round-trip approach as the
 * three above - added here, not a new wire-protocol message type, so any
 * connection type (a page's main.ts, an extension's background script, or
 * anything else built on connectStateSocket) special-cases this one more
 * reserved name the same way it already special-cases the other three.
 * Args: `{ targetOrigin?: string; targetTabId?: number }`, forwarded
 * opaquely - what "reconnect" means, and how targetOrigin/targetTabId are
 * used, is entirely up to whichever connection receives the call (a page
 * bridge has no way to act on it at all, since its own socket dying is
 * exactly the situation this call addresses; a browser extension can use
 * these hints to find and re-inject into the right tab).
 */
export const REMOTE_REQUEST_RECONNECT_CALL = '__request_reconnect__';

/**
 * Strips `fn` from each PageToolDef to produce the wire-safe
 * ToolManifestEntry[] for a RegisterToolsMessage, and returns a
 * name -> fn lookup for dispatching incoming CallMessages locally.
 */
export function splitPageTools(defs: PageToolDef[]): { manifest: ToolManifestEntry[]; fnByName: Map<string, PageToolDef['fn']> } {
  const manifest: ToolManifestEntry[] = [];
  const fnByName = new Map<string, PageToolDef['fn']>();
  for (const { fn, ...entry } of defs) {
    manifest.push(entry);
    fnByName.set(entry.name, fn);
  }
  return { manifest, fnByName };
}

export function createClientBridge(actions: ClientAction[]) {
  const byName = new Map(actions.map((a) => [a.name, a]));

  return {
    async dispatch(name: string, args: unknown): Promise<unknown> {
      const action = byName.get(name);
      if (!action) throw new Error(`No client action registered for "${name}"`);
      if (action.resolve === 'window') {
        const fn = (window as any)[name];
        if (typeof fn !== 'function') {
          throw new Error(`window.${name} is not a function — expose it before dispatching`);
        }
        return fn(args);
      }
      return action.resolve(args);
    },
  };
}

export interface StateSocketHandlers<TSchema, TValues> {
  onInit?(schema: TSchema, state: TValues): void;
  onReinit?(schema: TSchema, state: TValues): void;
  onUpdate?(field: string, value: unknown): void;
  onCall?(id: string, name: string, args: unknown): void;
  onConnect?(): void;
  onDisconnect?(): void;
  /** Server-pushed "identify yourself" signal (see identify_connection tool). Defaults to a window.alert(). */
  onIdentify?(label: string | undefined): void;
  /**
   * Server-pushed "move to a different channel" command (the dashboard's
   * move-to-channel action — see Tenant.moveConnection in mcp-tenant-lib
   * and types.ts's MoveChannelMessage). No default behavior: unlike
   * onIdentify, a caller that doesn't implement this simply ignores the
   * command and stays on its current channel. js-bridge-mcp's main.ts is
   * the consumer that actually performs the move (leave this channel,
   * reconnect fresh to `channel`).
   */
  onMove?(channel: string): void;
}

export interface StateSocketOptions {
  /**
   * Origin of the mcp-tenant-lib instance to connect to, e.g.
   * 'http://localhost:8766'. Omit when the page is served by the same
   * server it's connecting to (same-origin) — defaults to location.host.
   * Required for the cross-origin "AI-enable an existing page" pattern.
   */
  serverUrl?: string;
  /**
   * Explicit tenant id. Omit to fall back to parsing '/t/<id>' from
   * location.pathname (same-origin pattern), else 'default'.
   */
  tenant?: string;
}

/** Steady-state delay between reconnect attempts once the connection drops. */
const RECONNECT_INTERVAL_MS = 10_000;
/**
 * How long to keep retrying at RECONNECT_INTERVAL_MS before giving up
 * entirely. A dropped connection is usually the server restarting (or a
 * laptop sleeping) rather than something permanent, and unknown named
 * tenants are now recreated on demand server-side (see ws.ts) rather than
 * rejected — so it's worth retrying for a long while rather than a few
 * seconds, without retrying literally forever if the server is gone for good.
 */
const RECONNECT_GIVE_UP_MS = 60 * 60 * 1000;

export function connectStateSocket<TSchema, TValues>(
  handlers: StateSocketHandlers<TSchema, TValues>,
  options: StateSocketOptions = {}
) {
  let ws: WebSocket | undefined;
  let closedByCaller = false;
  let reconnectAttempts = 0;
  let firstDisconnectAt: number | undefined;
  // Messages sent before the socket has finished its handshake (readyState
  // still CONNECTING) - e.g. a caller's own onChange-style resend firing
  // concurrently with the initial connect, before onopen. WebSocket#send
  // throws InvalidStateError synchronously if called while CONNECTING (seen
  // in practice: packages/browser-extension's host-tools/bus onChange
  // listeners can fire this way, since tool registration finishes fast while
  // the WS handshake takes a real network round trip) - queued here and
  // flushed once onopen fires, rather than either dropping the message or
  // leaving every caller responsible for checking readyState itself.
  let pendingSends: string[] = [];

  const connect = () => {
    const tenantId = options.tenant ?? (location.pathname.startsWith('/t/')
      ? location.pathname.slice('/t/'.length).split('/')[0]
      : '');
    const wsPath = tenantId ? `/ws?tenant=${encodeURIComponent(tenantId)}` : '/ws';
    const wsOrigin = options.serverUrl
      ? options.serverUrl.replace(/^http/, 'ws')
      : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
    const wsUrl = `${wsOrigin}${wsPath}`;
    console.log(`[mcp-ws] connecting (attempt ${reconnectAttempts + 1}): ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[mcp-ws] connected${reconnectAttempts > 0 ? ` after ${reconnectAttempts} reconnect attempt(s)` : ''}`);
      reconnectAttempts = 0;
      firstDisconnectAt = undefined;
      handlers.onConnect?.();
      // Flush anything queued while CONNECTING - onConnect above may itself
      // have just called send() again (e.g. the initial register_tools),
      // which appends to a fresh queue rather than the one being flushed
      // here, so order is preserved either way.
      const queued = pendingSends;
      pendingSends = [];
      for (const raw of queued) ws?.send(raw);
    };
    ws.onclose = (event) => {
      console.log(`[mcp-ws] disconnected: code=${event.code} reason=${event.reason || '(none)'} wasClean=${event.wasClean}`);
      handlers.onDisconnect?.();
      if (closedByCaller) return;
      if (event.code === 4404) {
        console.log('[mcp-ws] invalid tenant id (4404) — not retrying');
        return;
      }
      firstDisconnectAt ??= Date.now();
      if (Date.now() - firstDisconnectAt > RECONNECT_GIVE_UP_MS) {
        console.log(`[mcp-ws] giving up after retrying for over ${RECONNECT_GIVE_UP_MS / 60_000} minutes`);
        return;
      }
      reconnectAttempts++;
      console.log(`[mcp-ws] retrying in ${RECONNECT_INTERVAL_MS / 1000}s (attempt ${reconnectAttempts + 1})`);
      setTimeout(connect, RECONNECT_INTERVAL_MS);
    };
    ws.onerror = () => {
      console.log('[mcp-ws] socket error (see close event for details)');
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMessage<TSchema, TValues>;
      if (msg.type === 'init') handlers.onInit?.(msg.schema, msg.state);
      if (msg.type === 'reinit') handlers.onReinit?.(msg.schema, msg.state);
      if (msg.type === 'update') handlers.onUpdate?.(msg.field, msg.value);
      if (msg.type === 'call') handlers.onCall?.(msg.id, msg.name, msg.args);
      if (msg.type === 'identify') {
        if (handlers.onIdentify) handlers.onIdentify(msg.label);
        else alert(`Identify: this is the "${msg.label ?? 'unlabeled'}" connection`);
      }
      if (msg.type === 'move_channel') handlers.onMove?.(msg.channel);
    };
  };
  connect();

  return {
    send(msg: ClientMessage) {
      const raw = JSON.stringify(msg);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(raw);
      } else {
        // CONNECTING (queue for onopen's flush above), or CLOSING/CLOSED/no
        // socket yet (queued anyway - a subsequent reconnect's onopen will
        // flush it; harmless if the caller has otherwise given up, since
        // nothing reads pendingSends again after that).
        pendingSends.push(raw);
      }
    },
    close() {
      closedByCaller = true;
      ws?.close();
    },
  };
}
