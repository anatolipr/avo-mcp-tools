import { z } from 'zod';
import type { Tenant, TenantConnection } from '@avo-mcp-tools/mcp-tenant-server';
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
    'it runs, the page pushes its own tool manifest (window.__mcpTools, plus an optional ' +
    'window.__mcpSummary string with shared cross-tool context — see the describe_tools tool once ' +
    'connected) to this session\'s tenant, and the tools it declares become available to call from ' +
    'THIS conversation — other sessions/pages stay isolated. Running the snippet immediately opens ' +
    'a browser prompt() asking the user to name this connection (pre-filled with the page title) — ' +
    'warn the user about this pop-up before they paste it so it isn\'t a surprise, and know that ' +
    'dismissing/cancelling it is safe (falls back to the page title, connection proceeds either ' +
    'way). The chosen name becomes this connection\'s tool-name prefix once a second connection ' +
    'joins the same tenant (see describe_tools). Share the returned snippet with the user and tell ' +
    'them to open DevTools on the target page, go to the Console tab, paste it, and press enter; do ' +
    'not construct this URL by hand. ' +
    '\n\n' +
    'MANDATORY NEXT STEP — DO NOT SKIP: in the SAME turn, immediately after returning this snippet ' +
    'to the user, call wait_for_connection. Do not wait for the user to say "done" or "I pasted it" ' +
    'first — that round-trip is exactly what wait_for_connection exists to avoid. Yes, it blocks; ' +
    'that is intended, it is how you learn what just connected (its label, summary, and tools) the ' +
    'instant the page registers, without the user having to tell you separately.',
  schema: {},
  handler: async (_args, tenant, port) => {
    const tenantId = tenant().id;
    const serverUrl = `http://localhost:${port}`;
    const moduleUrl = `${serverUrl}/main.js?server=${encodeURIComponent(serverUrl)}&tenant=${tenantId}`;
    const snippet = `import(${JSON.stringify(moduleUrl)});`;
    return { content: [{ type: 'text', text: snippet }] };
  },
};

const waitForConnection: ToolDef = {
  name: 'wait_for_connection',
  description:
    'Blocks until a page that was just given get_embed_snippet actually connects (i.e. finishes ' +
    'the browser-side handshake and registers its tools). ALWAYS call this immediately after ' +
    'get_embed_snippet, in the same turn — do not return control to the user and wait for them to ' +
    'confirm they pasted it first. Blocking here is the point: it is what lets you find out what ' +
    'connected the instant it happens, instead of the user having to come back and tell you, or you ' +
    'finding out only when a later tool call happens to fail or succeed. ' +
    '\n\n' +
    'RETURN SHAPE: a JSON object with "label" (the connection name the user chose, or the page ' +
    'title if they dismissed the naming prompt), "summary" (page-authored context about what kind ' +
    'of app this is, if the page provided one), and "tools" (name + one-line description for each ' +
    'tool the page registered). ' +
    '\n\n' +
    'NEXT STEP: after this resolves, call describe_tools to get the full manifest-level context ' +
    '(including the tool-name prefix if multiple connections share this tenant) before calling any ' +
    'of the newly connected tools — this tool\'s summary/tools fields are a preview, describe_tools ' +
    'is authoritative. ' +
    '\n\n' +
    'If no page connects (user never pasted the snippet, or the tenant/session ends first), this ' +
    'call can hang indefinitely — it has no timeout, matching wait_for_submit in mcp-form. Only ' +
    'call it right after handing out a snippet you expect to be pasted soon.',
  schema: {},
  handler: async (_args, tenant) => {
    const conn = await new Promise<TenantConnection | { __disposed: true }>((resolve) => {
      tenant().connectionBus.once('connected', resolve);
      tenant().connectionBus.once('disposed', () => resolve({ __disposed: true } as any));
    });
    if ('__disposed' in conn) {
      return {
        content: [{ type: 'text', text: 'Error: the session was closed while waiting for a connection' }],
        isError: true,
      };
    }
    const payload = {
      label: conn.label ?? null,
      summary: conn.summary ?? null,
      tools: conn.manifest.map((e) => ({ name: e.name, description: e.description })),
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
};

export const helloTools: ToolDef[] = [getEmbedSnippet, waitForConnection];
