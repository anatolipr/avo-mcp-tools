import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage } from './types.js';
import { getOrCreateTenant, getOrCreateRootTenant, tenants, isValidChannelName, sanitizeChannelName } from './tenant.js';

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
    const rawTenantParam = wsUrl.searchParams.get('tenant');

    // Split on the FIRST colon only: "channel1:foo" -> real channel
    // "channel1" + connection name "foo" inside it; a bare "foo" (no colon)
    // -> a ROOT connection named "foo" (addressed directly, no channel).
    // This is the flipped meaning of the pre-existing "channel:app-name"
    // convention (connect.js's parseChannelInput used to treat the part
    // before the colon as always-a-channel and the part after as a purely
    // cosmetic label) — an accepted breaking change, see connect.js.
    let channelPart: string | undefined;
    let namePart: string | undefined;
    if (rawTenantParam !== null) {
      const colonIdx = rawTenantParam.indexOf(':');
      if (colonIdx === -1) {
        namePart = rawTenantParam;
      } else {
        channelPart = rawTenantParam.slice(0, colonIdx);
        namePart = rawTenantParam.slice(colonIdx + 1) || undefined;
      }
    }

    if (channelPart !== undefined && !isValidChannelName(channelPart)) {
      // A browser-supplied name (e.g. a human renaming a bridged tab via a
      // plain prompt()) has no reason to know the slug rule — coerce it
      // into something valid rather than rejecting outright, same as
      // join_channel would reject a raw name but this WS path favors
      // recovering the connection. Only a genuinely empty result (every
      // character was disallowed — including an empty channel before the
      // colon, e.g. ":foo") still gets rejected below.
      const sanitized = sanitizeChannelName(channelPart);
      if (!sanitized) {
        console.error(`[ws] rejected connection: invalid channel "${channelPart}" (nothing left after sanitizing)`);
        ws.close(4404, 'Invalid tenant id');
        return;
      }
      console.error(`[ws] sanitized invalid channel "${channelPart}" -> "${sanitized}"`);
      channelPart = sanitized;
    }
    if (namePart !== undefined && !isValidChannelName(namePart)) {
      const sanitized = sanitizeChannelName(namePart);
      namePart = sanitized || undefined;
    }

    let t;
    let tenantId: string;
    let resolvedName: string;
    let recreated: boolean;
    const connectionId = randomUUID();

    if (channelPart !== undefined) {
      // Real named channel — unchanged tenant id/reconnect semantics.
      tenantId = channelPart;
      recreated = !tenants.has(tenantId);
      t = getOrCreateTenant(tenantId, initialSchema, initialValues);
      if (recreated) {
        // A page reconnecting (browser retry loop) to a named channel that
        // no longer exists server-side — most commonly a server restart,
        // which wipes the in-memory tenants map entirely. Recreate it on
        // demand rather than rejecting, so the page keeps working and an
        // agent can rejoin the same name later instead of the connection
        // being stuck retrying forever against a channel the server will
        // never revive.
        console.error(`[ws] recreated previously unknown/expired tenant "${tenantId}" on reconnect`);
      }
      // Empty name after the colon (e.g. "channel1:") or no colon-part at
      // all falls back to a placeholder — the connection's real name/label
      // arrives moments later via its first register_tools message
      // (appLabel), same deferral registerConnection already does for
      // `label`. registerConnection itself resolves collisions against this
      // channel's OTHER live connections.
      resolvedName = t.registerConnection(connectionId, ws, namePart ?? 'conn');
    } else {
      // No colon at all — a root connection, addressed directly by name
      // rather than through any channel. Each root connection is its own
      // single-connection Tenant (see getOrCreateRootTenant), so a name
      // collision is resolved against OTHER live root connections, not
      // within one Tenant's own connections map.
      const desired = namePart ?? 'conn';
      const created = getOrCreateRootTenant(desired, initialSchema, initialValues);
      t = created.tenant;
      tenantId = t.id;
      recreated = false; // a root tenant is always freshly minted per reserved name — never a stale reconnect target
      resolvedName = t.registerConnection(connectionId, ws, created.name);
    }

    console.error(`[ws] connection opened: tenant=${tenantId} connection=${connectionId} name=${resolvedName} (${t.connections.size} connection(s) on tenant)`);

    heartbeatState.set(ws, { isAlive: true });
    ws.on('pong', () => {
      const state = heartbeatState.get(ws);
      if (state) state.isAlive = true;
    });

    ws.send(JSON.stringify({ type: 'init', schema: t.schema, state: t.store.snapshot(), waiting: t.waiting, submitted: t.submitted, recreated }));

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
        t.updateConnectionManifest(connectionId, msg.tools, msg.summary, msg.appLabel, msg.internal);
      }

      if (msg.type === 'rename_connection') {
        t.renameConnection(connectionId, msg.appLabel);
      }

      if (msg.type === 'call_result') {
        if (msg.error) t.rejectCall(msg.id, msg.error);
        else t.resolveCall(msg.id, msg.result);
      }

      if (msg.type === 'resync') {
        const applied = t.restoreState(msg.schema as TSchema, msg.values as TValues, msg.submitted, msg.changedAt);
        console.error(applied
          ? `[ws] resync from connection=${connectionId}: restoring tenant "${tenantId}" state pushed back by the browser`
          : `[ws] resync from connection=${connectionId}: ignored — tenant "${tenantId}" already has state at least as recent`);
      }

      if (msg.type === 'leave_channel') {
        // The page told us — as opposed to just dropping — that it's done
        // with this channel (e.g. switching to a different one). Remove
        // this connection now rather than waiting for the socket's own
        // 'close' event, so a tenant this was the last connection on
        // becomes empty (and eligible for startEmptySweep) immediately;
        // the socket is closed right after, which would otherwise fire the
        // same removeConnection redundantly — guarded there by connections
        // no longer having this id.
        console.error(`[ws] connection ${connectionId} left tenant=${tenantId} (${t.connections.size - 1} connection(s) remaining)`);
        t.removeConnection(connectionId);
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
