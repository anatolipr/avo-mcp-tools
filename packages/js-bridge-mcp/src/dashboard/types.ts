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
}
