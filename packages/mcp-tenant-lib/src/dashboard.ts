import type { IncomingMessage, ServerResponse } from 'node:http';
import { tenants, dashboardEvents } from './tenant.js';

export interface DashboardConnection {
  id: string;
  label: string | null;
  toolCount: number;
  summary: string | null;
}

export interface DashboardChannel {
  channel: string;
  lastActivityAt: number;
  connections: DashboardConnection[];
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
    .map(([channel, t]) => ({
      channel,
      lastActivityAt: t.lastActivityAt,
      connections: [...t.connections.values()].map((c) => ({
        id: c.id,
        label: c.label ?? null,
        toolCount: c.manifest.length,
        summary: c.summary ?? null,
      })),
    }))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/**
 * Handles the three dashboard HTTP routes against a raw node http.Server,
 * the same low-level style createHttpServer (http.ts) already uses (no
 * Express dependency in this package). Returns true if the request was
 * handled (caller should stop routing further), false if the path/method
 * didn't match anything here.
 *
 * Mount this ahead of static file serving in the consuming package's own
 * request handler, e.g.:
 *
 *   if (handleDashboardRoutes(req, res)) return;
 */
export function handleDashboardRoutes(req: IncomingMessage, res: ServerResponse, port: number): boolean {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (url.pathname === '/api/dashboard' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildDashboardSnapshot()));
    return true;
  }

  // Server-sent-events stream: pushes a fresh full snapshot immediately on
  // connect, then again every time dashboardEvents fires (a connection
  // opened/closed, a manifest changed, a channel was created/disposed) — see
  // tenant.ts's notifyDashboard call sites. No diffing: the snapshot is
  // small (one row per channel/connection) and a full replace is simpler
  // and less bug-prone client-side than patching.
  if (url.pathname === '/api/dashboard/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = () => res.write(`data: ${JSON.stringify(buildDashboardSnapshot())}\n\n`);
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

  return false;
}
