import { z } from 'zod';
import type { Tenant } from '@avo-mcp-tools/mcp-tenant-server';
import type { HelloState } from '../types.js';

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: any, tenant: () => Tenant<undefined, HelloState>, port: number) => Promise<any>;
}

const getEmbedSnippet: ToolDef = {
  name: 'get_embed_snippet',
  description:
    'Returns a single line of executable JavaScript that connects the current page to this ' +
    'MCP session\'s tenant. Primary use: paste it directly into the browser\'s DevTools console ' +
    '(Chrome/Firefox/etc.) on the target page and press enter — no editing the page\'s source ' +
    'required. It can also be wrapped in a <script type="module">...</script> tag if the user ' +
    'wants to bake it into the page\'s HTML instead (e.g. right before </body>). Either way, once ' +
    'it runs, the page pushes its own JSON tool manifest (a <script id="mcp-tools" ' +
    'type="application/json"> block on the page, if present) to this session\'s tenant, and the ' +
    'tools it declares become available to call from THIS conversation — other sessions/pages ' +
    'stay isolated. Share the returned snippet with the user and tell them to open DevTools on ' +
    'the target page, go to the Console tab, paste it, and press enter; do not construct this ' +
    'URL by hand.',
  schema: {},
  handler: async (_args, tenant, port) => {
    const tenantId = tenant().id;
    const serverUrl = `http://localhost:${port}`;
    const moduleUrl = `${serverUrl}/main.js?server=${encodeURIComponent(serverUrl)}&tenant=${tenantId}`;
    const snippet = `import(${JSON.stringify(moduleUrl)});`;
    return { content: [{ type: 'text', text: snippet }] };
  },
};

export const helloTools: ToolDef[] = [getEmbedSnippet];
