import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from '@mcp-form-demo/mcp-tenant-server';
import { formTools } from './form-tools.js';
import { fieldTools } from './field-tools.js';

export function registerFormTools(mcp: McpServer, tenant: () => Tenant, port: number) {
  for (const tool of [...formTools, ...fieldTools]) {
    mcp.tool(tool.name, tool.description, tool.schema, (args: any) => tool.handler(args, tenant, port));
  }
}
