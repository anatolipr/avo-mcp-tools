import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from '@avo-mcp-tools/mcp-tenant-server';
import { createManifestToolRegistry } from '@avo-mcp-tools/mcp-tenant-server';
import type { HelloState } from '../types.js';
import { helloTools } from './hello-tools.js';

export function registerHelloTools(mcp: McpServer, tenant: () => Tenant<undefined, HelloState>, port: number) {
  for (const tool of helloTools) {
    mcp.tool(tool.name, tool.description, tool.schema, (args: any) => tool.handler(args, tenant, port));
  }
  const registry = createManifestToolRegistry(mcp, tenant);
  tenant().manifestToolRegistry = registry;
  registry.sync();
}
