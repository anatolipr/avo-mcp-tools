import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { FormDef, ClientMessage } from '../shared/types.js';
import { getOrCreateTenant, tenants } from './tenant.js';

export function attachWebSocketServer(httpServer: Server, port: number, initialFormDef: FormDef) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const wsUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
    const requestedTenantId = wsUrl.searchParams.get('tenant');

    if (requestedTenantId && !tenants.has(requestedTenantId)) {
      // An explicit tenant was requested but no longer exists (for example
      // because its MCP session was disposed). Reject instead of silently
      // falling back to the shared default tenant.
      ws.close(4404, 'Unknown or expired tenant');
      return;
    }

    const tenantId = requestedTenantId || 'default';
    const t = getOrCreateTenant(tenantId, initialFormDef);

    t.wsClients.add(ws);
    ws.send(JSON.stringify({ type: 'init', formDef: t.formDef, state: t.store.snapshot() }));

    ws.on('message', (raw) => {
      t.touch();
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'set' && t.store.has(msg.field)) {
        t.store.set(msg.field, msg.value);
      }

      if (msg.type === 'submit') {
        t.submitBus.emit('submit', { __interrupted: false, ...t.store.snapshot() });
      }

      if (msg.type === 'interrupt') {
        t.submitBus.emit('submit', { __interrupted: true, ...t.store.snapshot() });
      }
    });

    ws.on('close', () => {
      t.wsClients.delete(ws);
    });
  });

  return wss;
}
