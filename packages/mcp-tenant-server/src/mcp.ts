import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from './tenant.js';

export type RegisterToolsFn = (mcp: McpServer, tenant: () => Tenant, port: number) => void;

export function buildMcpServer(
  tenantId: string,
  getTenant: (id: string) => Tenant,
  port: number,
  registerFn: RegisterToolsFn
) {
  const mcp = new McpServer({ name: 'mcp-form', version: '0.2.0' });
  const tenant = () => getTenant(tenantId);
  registerFn(mcp, tenant, port);
  return mcp;
}
