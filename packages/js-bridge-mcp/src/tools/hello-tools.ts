import { z } from 'zod';
import type { Tenant } from 'mcp-tenant-lib';
import type { HelloState } from '../types.js';
import { listProxies as listProxiesState } from '../proxy/proxy-manager.js';

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: any, tenant: () => Tenant<undefined, HelloState>, port: number) => Promise<any>;
}

const getEmbedSnippet: ToolDef = {
  name: 'get_embed_snippet',
  description:
    'Returns one line of JavaScript that bridges a browser page to this server. Give it to the user verbatim ' +
    '(do not build the URL by hand): they paste it into that page\'s DevTools Console and press enter, or wrap ' +
    'it in <script type="module">...</script> before </body>. Warn them it opens a prompt() to label the ' +
    'connection (pre-filled with the page title; dismissing is safe). The page then pushes its tools ' +
    '(window.__mcpTools, optional window.__mcpSummary) and they become callable here — call describe_tools ' +
    'for their names. The page connects under this session\'s current name, which is also its tool prefix: ' +
    'call join_channel with a topic name (e.g. "bulletino") first to choose it, otherwise it is this ' +
    'server\'s own name. Each paste of the same snippet in another tab adds a separate connection.',
  schema: {},
  handler: async (_args, tenant, port) => {
    // displayName, not id, for a root tenant: its id is "root:<name>", and
    // the WS side (ws.ts) reads a colon in ?tenant= as "channel:name" — the
    // raw id put the page in a literal channel called "root" that no
    // session was on, so its tools never showed up anywhere.
    const t = tenant();
    const tenantId = t.isRoot ? t.displayName : t.id;
    const serverUrl = `http://localhost:${port}`;
    const moduleUrl = `${serverUrl}/main.js?server=${encodeURIComponent(serverUrl)}&tenant=${encodeURIComponent(tenantId)}`;
    const snippet = `import(${JSON.stringify(moduleUrl)});`;
    return { content: [{ type: 'text', text: snippet }] };
  },
};

const listProxies: ToolDef = {
  name: 'list_proxies',
  description:
    'Lists every configured MCP-server proxy (managed at /admin or with the admin__* tools) and its live ' +
    'status: connected, paused, toolCount, lastError. A proxy is an upstream MCP server whose tools appear ' +
    'in every session prefixed `<slug>__` (e.g. "atlassian__get_tickets") — call this before guessing such a ' +
    'name. `connected: false` with a `lastError` usually means the upstream needs its own auth or a config ' +
    'fix, not a bug here. describe_connection on a `slug` lists that proxy\'s tools.',
  schema: {},
  handler: async () => {
    return { content: [{ type: 'text', text: JSON.stringify(listProxiesState(), null, 2) }] };
  },
};

export const helloTools: ToolDef[] = [getEmbedSnippet, listProxies];
