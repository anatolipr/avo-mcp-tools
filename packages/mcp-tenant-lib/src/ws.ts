import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage } from './types.js';
import { getOrCreateTenant, tenants, isValidChannelName } from './tenant.js';

/**
 * Ping interval for the liveness check below. Half-open sockets (client
 * process killed/suspended without a clean TCP close — the common case for
 * a backgrounded browser tab or a harness that drops its child process)
 * otherwise sit in `wsClients`/`connections` indefinitely: no 'close' event
 * ever fires, so removeConnection() never runs and Tenant.call() keeps
 * "succeeding" at sending into a socket that will never respond, running
 * out the clock on its own 10s timeout instead of failing fast.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

interface HeartbeatState {
  isAlive: boolean;
}
const heartbeatState = new WeakMap<WebSocket, HeartbeatState>();

export function attachWebSocketServer<TSchema, TValues>(httpServer: Server, port: number, initialSchema: TSchema, initialValues: TValues) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = heartbeatState.get(ws);
      if (state && !state.isAlive) {
        console.error('[ws] heartbeat missed, terminating dead connection');
        ws.terminate();
        continue;
      }
      if (state) state.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    const wsUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
    const requestedTenantId = wsUrl.searchParams.get('tenant');

    if (requestedTenantId && !isValidChannelName(requestedTenantId)) {
      // Never silently vivify a channel from a malformed/hostile id — same
      // validation join_channel applies agent-side.
      console.error(`[ws] rejected connection: invalid tenant id "${requestedTenantId}"`);
      ws.close(4404, 'Invalid tenant id');
      return;
    }

    const tenantId = requestedTenantId || 'default';
    const recreated = !!requestedTenantId && !tenants.has(requestedTenantId);
    const t = getOrCreateTenant(tenantId, initialSchema, initialValues);
    if (recreated) {
      // A page reconnecting (browser retry loop) to a named channel that no
      // longer exists server-side — most commonly a server restart, which
      // wipes the in-memory tenants map entirely. Recreate it on demand
      // rather than rejecting, so the page keeps working and an agent can
      // rejoin the same name later instead of the connection being stuck
      // retrying forever against a channel the server will never revive.
      console.error(`[ws] recreated previously unknown/expired tenant "${tenantId}" on reconnect`);
    }

    const connectionId = randomUUID();
    t.registerConnection(connectionId, ws);
    console.error(`[ws] connection opened: tenant=${tenantId} connection=${connectionId} (${t.connections.size} connection(s) on tenant)`);

    heartbeatState.set(ws, { isAlive: true });
    ws.on('pong', () => {
      const state = heartbeatState.get(ws);
      if (state) state.isAlive = true;
    });

    ws.send(JSON.stringify({ type: 'init', schema: t.schema, state: t.store.snapshot(), waiting: t.waiting, submitted: t.submitted }));

    ws.on('message', (raw) => {
      t.touch();
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'set' && t.store.has(msg.field)) {
        t.store.set(msg.field, msg.value);
      }

      if (msg.type === 'submit') {
        t.submitted = true;
        t.submitBus.emit('submit', { __interrupted: false, ...t.store.snapshot() });
      }

      if (msg.type === 'interrupt') {
        t.submitBus.emit('submit', { __interrupted: true, ...t.store.snapshot() });
      }

      if (msg.type === 'register_tools') {
        t.updateConnectionManifest(connectionId, msg.tools, msg.summary, msg.appLabel);
      }

      if (msg.type === 'rename_connection') {
        t.renameConnection(connectionId, msg.appLabel);
      }

      if (msg.type === 'call_result') {
        if (msg.error) t.rejectCall(msg.id, msg.error);
        else t.resolveCall(msg.id, msg.result);
      }
    });

    ws.on('close', (code, reason) => {
      console.error(`[ws] connection closed: tenant=${tenantId} connection=${connectionId} code=${code} reason=${reason.toString() || '(none)'}`);
      t.removeConnection(connectionId);
    });

    ws.on('error', (err) => {
      console.error(`[ws] connection error: tenant=${tenantId} connection=${connectionId}: ${err.message}`);
    });
  });

  return wss;
}
