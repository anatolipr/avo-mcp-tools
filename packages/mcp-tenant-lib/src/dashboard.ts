import type { IncomingMessage, ServerResponse } from 'node:http';
import { tenants, dashboardEvents, isValidChannelName } from './tenant.js';
import { REMOTE_REGISTER_BY_PATH_CALL, REMOTE_REGISTER_BY_CODE_CALL, REMOTE_UNREGISTER_CALL } from './client-bridge.js';

export interface DashboardConnection {
  id: string;
  label: string | null;
  toolCount: number;
  summary: string | null;
  /** See TenantConnection.kind — 'admin' gets its own icon, distinct from a real MCP proxy. */
  kind: 'browser' | 'proxy' | 'admin';
  /** See TenantConnection.internal — true hides identify/move for this connection in the dashboard (no page to alert, or nothing useful to move). */
  internal: boolean;
}

export interface DashboardChannel {
  channel: string;
  lastActivityAt: number;
  connections: DashboardConnection[];
  recentToolRegistrations: DashboardToolRegistration[];
}

/**
 * One live root connection, flattened (no nested `connections` array —
 * unlike a channel, a root Tenant always has exactly one connection, so
 * there's nothing to enumerate). `name` is the id used to address it (e.g.
 * via describe_connection or the "root:<name>" path segment the existing
 * per-connection dashboard routes already accept transparently).
 */
export interface DashboardRootConnection {
  name: string;
  id: string;
  label: string | null;
  toolCount: number;
  summary: string | null;
  kind: 'browser' | 'proxy' | 'admin';
  lastActivityAt: number;
  /** See TenantConnection.internal — true hides identify/move for this connection in the dashboard (no page to alert, or nothing useful to move). */
  internal: boolean;
}

export interface DashboardToolRegistration {
  id: string;
  name: string;
  description: string;
  code: string | undefined;
  createdAt: number;
}

/**
 * Flat snapshot of every live tenant ("channel" in agent-facing language)
 * and its connections — the same data list_channels/describe_channel expose
 * to MCP tools, reshaped for a human-facing dashboard. Rebuilt fresh on
 * every call rather than cached: cheap (iterates in-memory maps only), and
 * avoids a second source of truth to keep in sync with `tenants`.
 */
export function buildDashboardSnapshot(): DashboardChannel[] {
  return [...tenants.entries()]
    .filter(([, t]) => !t.isRoot)
    .map(([channel, t]) => ({
      channel,
      lastActivityAt: t.lastActivityAt,
      connections: [...t.connections.values()].map((c) => ({
        id: c.id,
        label: c.label ?? null,
        toolCount: c.manifest.length,
        summary: c.summary ?? null,
        kind: c.kind,
        internal: c.internal ?? false,
      })),
      // Recent register_page_tool_by_path/_by_code registrations for this
      // channel — a passive log the dashboard renders as sticky toasts, near-
      // zero cost when empty (the common case). See Tenant.logToolRegistration
      // (tenant.ts) — registration already happened by the time this exists.
      recentToolRegistrations: t.recentToolRegistrations.map((r) => ({ ...r })),
    }))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/**
 * Flat snapshot of every live root connection — the human-facing view for
 * the dashboard's "flat connections" tiles rendered above the channel list
 * (see js-bridge-mcp's dashboard-app.ts). Each root Tenant always has
 * exactly one connection, so this flattens straight to one row per tenant
 * rather than nesting a `connections` array the way DashboardChannel does.
 */
export function buildRootConnectionsSnapshot(): DashboardRootConnection[] {
  return [...tenants.values()]
    // A root Tenant with zero connections (e.g. a paused proxy — see
    // proxy-manager.ts's stopProxy, which deliberately leaves the Tenant
    // alive so resume can reuse the same name) has nothing to show: a root
    // row IS a live connection, unlike a channel tile, which can
    // legitimately render empty ("no tabs currently bridged"). Filtering
    // it out here (rather than rendering a ghost 0-tool row) means a
    // paused proxy simply disappears from the dashboard until resumed.
    .filter((t) => t.isRoot && t.connections.size > 0)
    .map((t) => {
      const conn = [...t.connections.values()][0]!;
      return {
        name: t.displayName,
        id: conn.id,
        label: conn.label ?? null,
        toolCount: conn.manifest.length,
        summary: conn.summary ?? null,
        kind: conn.kind,
        lastActivityAt: t.lastActivityAt,
        internal: conn.internal ?? false,
      };
    })
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export interface DashboardToolEntry {
  name: string;
  description: string;
  source: 'dynamic' | 'host';
  /** See ToolManifestEntry.origin (types.ts) — absent for 'host' tools and older/DevTools-pasted dynamic ones. */
  origin?: { kind: 'code'; code: string } | { kind: 'path'; path: string };
}

/**
 * Raw per-connection tool list for the tools-visualizer modal — reads
 * conn.manifest directly (NOT buildDescribePayload, which prefix-mangles
 * names for the multi-connection MCP-facing case; the modal wants this one
 * connection's own unprefixed names). Defaults an entry's source to 'host'
 * when absent, matching ToolManifestEntry's own documented back-compat
 * default for pages running an older bridge.
 */
export function getConnectionToolList(channel: string, connectionId: string): DashboardToolEntry[] | undefined {
  const conn = tenants.get(channel)?.connections.get(connectionId);
  if (!conn) return undefined;
  return conn.manifest.map((e) => ({
    name: e.name,
    description: e.description,
    source: e.source ?? 'host',
    origin: e.origin,
  }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Shared by the two register routes below: reads+parses the JSON body,
 * validates the required string fields are present, then funnels into the
 * SAME Tenant.call(...) reserved-name mechanism the register_page_tool_by_path
 * /_by_code MCP tools use (manifest-tools.ts) — one implementation, two
 * front doors (a human via this REST route, an agent via the MCP tool).
 * 422 signals "the browser rejected the call" (bad path or failed compile) —
 * distinct from 400 (malformed request) and 404 (channel/connection gone),
 * giving the dashboard UI a clean signal for which toast to show.
 */
async function handleRegisterRoute(
  req: IncomingMessage, res: ServerResponse, channel: string, connectionId: string,
  callName: string, requiredFields: string[]
): Promise<boolean> {
  const t = tenants.get(channel);
  if (!t) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'channel not found' }));
    return true;
  }
  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
    return true;
  }
  for (const field of requiredFields) {
    if (typeof body[field] !== 'string' || !body[field]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `missing required field "${field}"` }));
      return true;
    }
  }
  try {
    const result = await t.call(connectionId, callName, body, 60_000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  } catch (err) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
  return true;
}

/**
 * Handles the dashboard HTTP routes against a raw node http.Server, the
 * same low-level style createHttpServer (http.ts) already uses (no
 * Express dependency in this package). Returns true if the request was
 * handled (caller should stop routing further), false if the path/method
 * didn't match anything here.
 *
 * Mount this ahead of static file serving in the consuming package's own
 * request handler, e.g.:
 *
 *   if (await handleDashboardRoutes(req, res, port)) return;
 */
export async function handleDashboardRoutes(req: IncomingMessage, res: ServerResponse, port: number): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (url.pathname === '/api/dashboard' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ channels: buildDashboardSnapshot(), root: buildRootConnectionsSnapshot() }));
    return true;
  }

  // Server-sent-events stream: pushes a fresh full snapshot immediately on
  // connect, then again every time dashboardEvents fires (a connection
  // opened/closed, a manifest changed, a channel was created/disposed) — see
  // tenant.ts's notifyDashboard call sites. No diffing: the snapshot is
  // small (one row per channel/connection) and a full replace is simpler
  // and less bug-prone client-side than patching. `root` carries flat root
  // connections alongside `channels` in one payload so the dashboard needs
  // only one EventSource/onmessage handler for both.
  if (url.pathname === '/api/dashboard/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = () => res.write(`data: ${JSON.stringify({ channels: buildDashboardSnapshot(), root: buildRootConnectionsSnapshot() })}\n\n`);
    send();
    dashboardEvents.on('change', send);
    req.on('close', () => dashboardEvents.off('change', send));
    return true;
  }

  // Triggers identifyConnection on one connection — the dashboard's "which
  // tab is this" button, same underlying mechanism as the identify_connection
  // MCP tool (manifest-tools.ts), just reachable from a human clicking
  // instead of an agent calling a tool.
  const identifyMatch = url.pathname.match(/^\/api\/dashboard\/channels\/([^/]+)\/connections\/([^/]+)\/identify$/);
  if (identifyMatch && req.method === 'POST') {
    const [, channel, connectionId] = identifyMatch as unknown as [string, string, string];
    const t = tenants.get(decodeURIComponent(channel));
    const ok = t?.identifyConnection(decodeURIComponent(connectionId)) ?? false;
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return true;
  }

  // Pushes Tenant.moveConnection at one connection — the dashboard's "move
  // to channel" action, letting a human group a few tenants by moving their
  // connections into one shared channel (or off into a brand-new one).
  // targetChannel is validated with the same rule join_channel enforces
  // (isValidChannelName) since it ultimately becomes a WS `?tenant=` value
  // once the page reconnects; an unknown-but-valid name is fine — it's
  // created on demand exactly like join_channel/a fresh WS connect already do.
  const moveMatch = url.pathname.match(/^\/api\/dashboard\/channels\/([^/]+)\/connections\/([^/]+)\/move$/);
  if (moveMatch && req.method === 'POST') {
    const [, channel, connectionId] = moveMatch as unknown as [string, string, string];
    const t = tenants.get(decodeURIComponent(channel));
    if (!t) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'channel not found' }));
      return true;
    }
    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
      return true;
    }
    const targetChannel = body?.targetChannel;
    if (typeof targetChannel !== 'string' || !isValidChannelName(targetChannel)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'targetChannel must contain only letters, digits, underscore, and hyphen' }));
      return true;
    }
    const ok = t.moveConnection(decodeURIComponent(connectionId), targetChannel);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return true;
  }

  // Per-connection tool browse list for the tools-visualizer modal — fetched
  // on-demand when the modal opens, not part of the SSE snapshot (that stays
  // toolCount-only for the connection-row list; this is the full detail view).
  const toolsListMatch = url.pathname.match(/^\/api\/dashboard\/channels\/([^/]+)\/connections\/([^/]+)\/tools$/);
  if (toolsListMatch && req.method === 'GET') {
    const [, channel, connectionId] = toolsListMatch as unknown as [string, string, string];
    const tools = getConnectionToolList(decodeURIComponent(channel), decodeURIComponent(connectionId));
    if (!tools) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'channel or connection not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools }));
    return true;
  }

  // Registers a new tool pointing at an existing window.* function — same
  // underlying mechanism as the register_page_tool_by_path MCP tool
  // (manifest-tools.ts), reachable from the dashboard's own modal form.
  const registerByPathMatch = url.pathname.match(/^\/api\/dashboard\/channels\/([^/]+)\/connections\/([^/]+)\/tools\/register-by-path$/);
  if (registerByPathMatch && req.method === 'POST') {
    const [, channel, connectionId] = registerByPathMatch as unknown as [string, string, string];
    return handleRegisterRoute(req, res, decodeURIComponent(channel), decodeURIComponent(connectionId), REMOTE_REGISTER_BY_PATH_CALL, ['name', 'description', 'path']);
  }

  // Registers a new tool by compiling fresh code — same underlying mechanism
  // as the register_page_tool_by_code MCP tool. Registers immediately, no
  // approval gate — this route just relays the request and its eventual
  // success/failure; the dashboard's own SSE stream separately surfaces a
  // sticky toast once Tenant.logToolRegistration records it.
  const registerByCodeMatch = url.pathname.match(/^\/api\/dashboard\/channels\/([^/]+)\/connections\/([^/]+)\/tools\/register-by-code$/);
  if (registerByCodeMatch && req.method === 'POST') {
    const [, channel, connectionId] = registerByCodeMatch as unknown as [string, string, string];
    return handleRegisterRoute(req, res, decodeURIComponent(channel), decodeURIComponent(connectionId), REMOTE_REGISTER_BY_CODE_CALL, ['name', 'description', 'code']);
  }

  // Unregisters a previously dynamically-added tool by name — same
  // underlying mechanism as the unregister_page_tool MCP tool. The browser
  // rejects (surfacing a 422 here) if the name isn't a currently-tracked
  // dynamic registration, including if it's a host tool.
  const unregisterMatch = url.pathname.match(/^\/api\/dashboard\/channels\/([^/]+)\/connections\/([^/]+)\/tools\/([^/]+)$/);
  if (unregisterMatch && req.method === 'DELETE') {
    const [, channel, connectionId, toolName] = unregisterMatch as unknown as [string, string, string, string];
    const t = tenants.get(decodeURIComponent(channel));
    if (!t) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'channel not found' }));
      return true;
    }
    try {
      const result = await t.call(decodeURIComponent(connectionId), REMOTE_UNREGISTER_CALL, { toolName: decodeURIComponent(toolName) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return true;
  }

  return false;
}
