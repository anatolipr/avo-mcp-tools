export {
  Store, Tenant, tenants, getOrCreateTenant, disposeTenant, startIdleSweep, startEmptySweep,
  isValidChannelName, isValidConnectionName, sanitizeChannelName, dashboardEvents,
  reserveRootName, getRootTenant, getOrCreateRootTenant, listRootTenants,
} from './tenant.js';
export { buildMcpServer, type RegisterToolsFn, type McpServerIdentity } from './mcp.js';
export { createHttpServer, type CreateHttpServerOptions } from './http.js';
export { attachWebSocketServer } from './ws.js';
export { createManifestToolRegistry, type ManifestToolRegistry } from './manifest-tools.js';
export { registerChannelTools } from './channel-tools.js';
export {
  handleDashboardRoutes, buildDashboardSnapshot, buildRootConnectionsSnapshot, getConnectionToolList,
  type DashboardChannel, type DashboardConnection, type DashboardRootConnection, type DashboardToolEntry,
} from './dashboard.js';
export { findChannelMatches, scoreChannelMatch, type ChannelMatch } from './channel-search.js';
export { enablePersistence } from './persistence.js';
export * from './types.js';
