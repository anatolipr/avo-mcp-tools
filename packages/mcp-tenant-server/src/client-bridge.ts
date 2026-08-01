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
}

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
}

export interface StateSocketOptions {
  /**
   * Origin of the mcp-tenant-server instance to connect to, e.g.
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

export function connectStateSocket<TSchema, TValues>(
  handlers: StateSocketHandlers<TSchema, TValues>,
  options: StateSocketOptions = {}
) {
  let ws: WebSocket | undefined;
  let closedByCaller = false;

  const connect = () => {
    const tenantId = options.tenant ?? (location.pathname.startsWith('/t/')
      ? location.pathname.slice('/t/'.length).split('/')[0]
      : '');
    const wsPath = tenantId ? `/ws?tenant=${encodeURIComponent(tenantId)}` : '/ws';
    const wsOrigin = options.serverUrl
      ? options.serverUrl.replace(/^http/, 'ws')
      : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
    ws = new WebSocket(`${wsOrigin}${wsPath}`);

    ws.onopen = () => handlers.onConnect?.();
    ws.onclose = (event) => {
      handlers.onDisconnect?.();
      if (closedByCaller || event.code === 4404) return;
      setTimeout(connect, 2000);
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMessage<TSchema, TValues>;
      if (msg.type === 'init') handlers.onInit?.(msg.schema, msg.state);
      if (msg.type === 'reinit') handlers.onReinit?.(msg.schema, msg.state);
      if (msg.type === 'update') handlers.onUpdate?.(msg.field, msg.value);
      if (msg.type === 'call') handlers.onCall?.(msg.id, msg.name, msg.args);
    };
  };
  connect();

  return {
    send(msg: ClientMessage) {
      ws?.send(JSON.stringify(msg));
    },
    close() {
      closedByCaller = true;
      ws?.close();
    },
  };
}
