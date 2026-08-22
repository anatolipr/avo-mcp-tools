import { z } from 'zod';
import type { Tenant } from 'mcp-tenant-lib';
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
    'Returns a single line of executable JavaScript that connects the current page to this MCP session\'s ' +
    'channel. Paste it directly into the browser DevTools console on the target page and press enter — no ' +
    'source edits needed (or wrap in <script type="module">...</script> before </body> to bake it into the ' +
    'page). Once run, the page pushes its tool manifest (window.__mcpTools, optional window.__mcpSummary — see ' +
    'describe_tools) to this session\'s channel, and its tools become callable from THIS conversation. Share ' +
    'the snippet and tell the user to paste it in DevTools\' Console tab and press enter; do not construct the ' +
    'URL by hand. ' +
    '\n\n' +
    'DEFAULT TO calling join_channel with a topic-scoped name (e.g. "bulletino", from the page/app or task) ' +
    'BEFORE this — the normal path, not something reserved for when it happens to matter. Skip only for a ' +
    'genuinely one-off bridge, or when nothing suggests a name worth giving it: staying on "default" means ' +
    'sharing state with every other unnamed session on this server, and blocks another agent from reconnecting ' +
    'to the SAME bridged page later by name. The snippet is generated fresh from whatever channel this session ' +
    'is on, so join first, then call this. Reusing an already-generated snippet in a second tab connects that ' +
    'tab to the SAME channel, not a new one — join a different name and call this again for a distinct one. ' +
    '\n\n' +
    'Running the snippet opens a browser prompt() asking the user to name this connection (pre-filled with the ' +
    'page title) — warn them before they paste it; dismissing is safe (falls back to the page title). That ' +
    'name becomes this connection\'s tool-name prefix once a second connection joins the same channel (see ' +
    'describe_tools).',
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
