import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from './tenant.js';

export type RegisterToolsFn<TSchema = any, TValues = any> = (
  mcp: McpServer,
  tenant: () => Tenant<TSchema, TValues>,
  port: number
) => void;

export interface McpServerIdentity {
  name: string;
  version: string;
}

export function buildMcpServer<TSchema, TValues>(
  identity: McpServerIdentity,
  tenantId: string,
  getTenant: (id: string) => Tenant<TSchema, TValues>,
  port: number,
  registerFn: RegisterToolsFn<TSchema, TValues>
) {
  const mcp = new McpServer(identity);
  const tenant = () => getTenant(tenantId);
  registerFn(mcp, tenant, port);
  return mcp;
}
