import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerChannelTools, type Tenant } from 'mcp-tenant-lib';
import type { FormDef, FieldValues } from '../types.js';
import { initialValuesFor } from '../types.js';
import { formTools } from './form-tools.js';
import { fieldTools } from './field-tools.js';

export function makeRegisterFormTools(initialFormDef: FormDef) {
  return function registerFormTools(
    mcp: McpServer,
    tenant: () => Tenant<FormDef, FieldValues>,
    port: number,
    setChannel: (id: string) => void
  ) {
    for (const tool of [...formTools, ...fieldTools]) {
      mcp.tool(tool.name, tool.description, tool.schema, (args: any) => tool.handler(args, tenant, port));
    }
    registerChannelTools(mcp, tenant, port, setChannel, initialFormDef, initialValuesFor(initialFormDef));
  };
}
