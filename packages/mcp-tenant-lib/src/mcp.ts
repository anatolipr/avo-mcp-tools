import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from './tenant.js';

export type RegisterToolsFn<TSchema = any, TValues = any> = (
  mcp: McpServer,
  tenant: () => Tenant<TSchema, TValues>,
  port: number,
  setChannel: (id: string) => void
) => void;

export interface McpServerIdentity {
  name: string;
  version: string;
}

/**
 * `tenantId` is only the session's bootstrap identity — a private id minted
 * before any tool call has happened, so before an agent could have chosen a
 * channel name (see channel-tools.ts). It is NOT fixed for the session's
 * lifetime: `setChannel` (passed into `registerFn`, typically wired to a
 * `join_channel` tool) reassigns which tenant `tenant()` resolves to from
 * that point on, so a session can retarget itself onto an agent-named,
 * cross-session-shared channel after connecting.
 */
export function buildMcpServer<TSchema, TValues>(
  identity: McpServerIdentity,
  tenantId: string,
  getTenant: (id: string) => Tenant<TSchema, TValues>,
  port: number,
  registerFn: RegisterToolsFn<TSchema, TValues>
) {
  const mcp = new McpServer(identity);
  let currentTenantId = tenantId;
  const tenant = () => getTenant(currentTenantId);
  const setChannel = (id: string) => { currentTenantId = id; };
  registerFn(mcp, tenant, port, setChannel);
  return mcp;
}
