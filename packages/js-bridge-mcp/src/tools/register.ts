import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from 'mcp-tenant-lib';
import { createManifestToolRegistry } from 'mcp-tenant-lib';
import type { HelloState } from '../types.js';
import { helloTools } from './hello-tools.js';

export function registerHelloTools(mcp: McpServer, tenant: () => Tenant<undefined, HelloState>, port: number) {
  for (const tool of helloTools) {
    mcp.tool(tool.name, tool.description, tool.schema, (args: any) => tool.handler(args, tenant, port));
  }
  const registry = createManifestToolRegistry(mcp, tenant);
  // addManifestToolRegistry syncs immediately and keeps this registry
  // subscribed to future tenant.syncManifestToolRegistries() calls (see
  // tenant.ts) — required under defaultTenantMode: 'shared', where
  // multiple concurrent MCP sessions' McpServer/registry pairs can be
  // bound to the same tenant at once and all need to stay in sync, not
  // just whichever one connected last.
  tenant().addManifestToolRegistry(registry);
  mcp.server.onclose = () => tenant().removeManifestToolRegistry(registry);
}
