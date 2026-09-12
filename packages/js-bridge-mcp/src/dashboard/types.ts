// Mirrors mcp-tenant-lib's DashboardChannel/DashboardConnection (dist has no
// client-safe export path, so this is duplicated the same way mem-bucket's
// client/types.ts duplicates server-side shapes across the client build boundary).
export interface DashboardConnection {
  id: string;
  label: string | null;
  toolCount: number;
  summary: string | null;
  // 'proxy' for a real MCP-proxy connection, 'admin' for the fixed
  // proxy-management connection (see the /admin page), 'browser' for a
  // real bridged tab. Absent on an older/not-yet-rebuilt server response —
  // treat as 'browser' (see #renderChannel below).
  kind?: 'browser' | 'proxy' | 'admin';
  // True hides identify/move for this connection (no page to alert, or
  // nothing useful to move) — e.g. admin, the browser extension. Absent on
  // an older/not-yet-rebuilt server response — treat as false.
  internal?: boolean;
}

export interface DashboardChannel {
  channel: string;
  lastActivityAt: number;
  connections: DashboardConnection[];
  recentToolRegistrations: DashboardToolRegistration[];
}

// Mirrors mcp-tenant-lib's DashboardRootConnection (dashboard.ts) — one
// flat row per live root connection (addressed directly by name, not
// nested in a channel). `name` is the id used to identify/move/inspect it
// (the same connection-action REST routes accept "root:<name>" transparently
// in place of a channel name).
export interface DashboardRootConnection {
  name: string;
  id: string;
  label: string | null;
  toolCount: number;
  summary: string | null;
  kind: 'browser' | 'proxy' | 'admin';
  lastActivityAt: number;
  // True hides identify/move for this connection — e.g. admin, the browser extension.
  internal: boolean;
}

// Combined shape pushed over the dashboard SSE stream — see dashboard-app.ts's connectedCallback.
export interface DashboardSnapshot {
  channels: DashboardChannel[];
  root: DashboardRootConnection[];
}

// Mirrors mcp-tenant-lib's DashboardToolRegistration (dashboard.ts) — a
// register_page_tool_by_path/_by_code registration that already happened,
// logged for the dashboard to show as a sticky toast, pushed via the same
// SSE snapshot as `connections` above.
export interface DashboardToolRegistration {
  id: string;
  name: string;
  description: string;
  code: string | undefined;
  createdAt: number;
}

// Mirrors mcp-tenant-lib's DashboardToolEntry (dashboard.ts) — the
// tools-visualizer modal's per-connection browse-list entry shape, fetched
// on demand from GET .../connections/:id/tools, not part of the SSE
// snapshot above.
export interface DashboardToolEntry {
  name: string;
  description: string;
  source: 'dynamic' | 'host';
  // See mcp-tenant-lib's ToolManifestEntry.origin (types.ts) — absent for
  // 'host' tools and older/DevTools-pasted dynamic ones.
  origin?: { kind: 'code'; code: string } | { kind: 'path'; path: string };
}
