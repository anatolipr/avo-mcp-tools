// Mirrors mcp-tenant-lib's DashboardChannel/DashboardConnection (dist has no
// client-safe export path, so this is duplicated the same way mem-bucket's
// client/types.ts duplicates server-side shapes across the client build boundary).
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
  recentToolRegistrations: DashboardToolRegistration[];
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
