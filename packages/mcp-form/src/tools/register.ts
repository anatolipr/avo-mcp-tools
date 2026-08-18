import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from '@avo-mcp-tools/mcp-tenant-lib';
import type { FormDef, FieldValues } from '../types.js';
import { formTools } from './form-tools.js';
import { fieldTools } from './field-tools.js';

export function registerFormTools(mcp: McpServer, tenant: () => Tenant<FormDef, FieldValues>, port: number) {
  for (const tool of [...formTools, ...fieldTools]) {
    mcp.tool(tool.name, tool.description, tool.schema, (args: any) => tool.handler(args, tenant, port));
  }
}
