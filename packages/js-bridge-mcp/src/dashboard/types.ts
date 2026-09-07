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
  pendingApprovals: DashboardPendingApproval[];
}

// Mirrors mcp-tenant-lib's DashboardPendingApproval (dashboard.ts) — a
// register_page_tool_by_code request awaiting a human's Approve/Decline on
// this dashboard, pushed via the same SSE snapshot as `connections` above.
export interface DashboardPendingApproval {
  id: string;
  name: string;
  description: string;
  code: string;
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
}
