import { z } from 'zod';
import type { Tenant } from '@avo-mcp-tools/mcp-tenant-server';
import type { HelloState } from '../types.js';

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: any, tenant: () => Tenant<undefined, HelloState>, port: number) => Promise<any>;
}

const insertTitle: ToolDef = {
  name: 'insert_title',
  description:
    'Sets the <h1> title shown on the connected page. Call get_embed_snippet first ' +
    'and have the user paste it into their page before calling this.',
  schema: { title: z.string() },
  handler: async ({ title }, tenant) => {
    tenant().store.set('title', title);
    return { content: [{ type: 'text', text: `title set to "${title}"` }] };
  },
};

const insertMain: ToolDef = {
  name: 'insert_main',
  description:
    'Sets the <main> body content shown on the connected page. Call get_embed_snippet first ' +
    'and have the user paste it into their page before calling this.',
  schema: { main: z.string() },
  handler: async ({ main }, tenant) => {
    tenant().store.set('main', main);
    return { content: [{ type: 'text', text: 'main content updated' }] };
  },
};

const getEmbedSnippet: ToolDef = {
  name: 'get_embed_snippet',
  description:
    'Returns a <script> tag to paste into an existing static HTML page (e.g. right before ' +
    '</body>). Once pasted and the page is loaded in a browser, insert_title/insert_main ' +
    'calls made from THIS conversation will update that page live — the snippet is scoped ' +
    'to this MCP session\'s own tenant, so other sessions/pages stay isolated. ' +
    'Share the returned snippet with the user and tell them where to paste it; ' +
    'do not construct this URL by hand.',
  schema: {},
  handler: async (_args, tenant, port) => {
    const tenantId = tenant().id;
    const serverUrl = `http://localhost:${port}`;
    const snippet =
      `<script type="module" src="${serverUrl}/main.js?server=${encodeURIComponent(serverUrl)}&tenant=${tenantId}"></script>`;
    return { content: [{ type: 'text', text: snippet }] };
  },
};

export const helloTools: ToolDef[] = [insertTitle, insertMain, getEmbedSnippet];
