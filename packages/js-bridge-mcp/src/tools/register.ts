import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from 'mcp-tenant-lib';
import { createManifestToolRegistry, registerChannelTools } from 'mcp-tenant-lib';
import type { HelloState } from '../types.js';
import { initialHelloState } from '../types.js';
import { helloTools } from './hello-tools.js';

export function registerHelloTools(
  mcp: McpServer,
  tenant: () => Tenant<undefined, HelloState>,
  port: number,
  setChannel: (id: string) => void
) {
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
  //
  // Track which Tenant object the registry is currently subscribed to so a
  // later join_channel (see the wrapped setChannel below) can move the
  // subscription — tenant() is a live accessor that starts pointing at a
  // different Tenant once the session retargets to a named channel, but the
  // subscription itself does NOT follow automatically: addManifestToolRegistry
  // only runs once here, against whichever tenant was current at connect
  // time. Without migrating it, a page that bridges into a channel AFTER
  // join_channel was called would push its manifest to a tenant nothing is
  // subscribed to — describe_tools would still see it (it reads
  // tenant().toolManifest fresh every call), but no real MCP tool would ever
  // get registered for it.
  let subscribedTenant = tenant();
  subscribedTenant.addManifestToolRegistry(registry);
  mcp.server.onclose = () => subscribedTenant.removeManifestToolRegistry(registry);

  const setChannelAndMigrateRegistry = (id: string) => {
    setChannel(id);
    subscribedTenant.removeManifestToolRegistry(registry);
    subscribedTenant = tenant();
    subscribedTenant.addManifestToolRegistry(registry);
  };

  registerChannelTools(mcp, tenant, port, setChannelAndMigrateRegistry, undefined, { ...initialHelloState });
}
