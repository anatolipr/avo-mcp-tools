import type { ServerMessage, ClientMessage } from './types.js';

export interface ClientAction {
  name: string;
  resolve: 'window' | ((args: any) => unknown | Promise<unknown>);
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
  onConnect?(): void;
  onDisconnect?(): void;
}

export function connectStateSocket<TSchema, TValues>(handlers: StateSocketHandlers<TSchema, TValues>) {
  let ws: WebSocket | undefined;
  let closedByCaller = false;

  const connect = () => {
    const tenantId = location.pathname.startsWith('/t/')
      ? location.pathname.slice('/t/'.length).split('/')[0]
      : '';
    const wsPath = tenantId ? `/ws?tenant=${encodeURIComponent(tenantId)}` : '/ws';
    ws = new WebSocket(`ws://${location.host}${wsPath}`);

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
