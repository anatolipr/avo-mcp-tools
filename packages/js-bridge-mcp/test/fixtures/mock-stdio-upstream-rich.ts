// Standalone stdio MCP server used as a fake "upstream" by
// proxy-manager.test.ts, for two things the flat-string fixture can't show:
// param shapes ToolParamSpec used to reject outright (an enum, a union, a
// free-form object), and an upstream process that dies mid-session.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'mock-stdio-upstream-rich', version: '0.0.1' });

server.tool(
  'search',
  'Searches with a mode, an optional filter and optional metadata',
  {
    mode: z.enum(['fast', 'deep']).describe('search mode'),
    filter: z.union([z.string(), z.number()]).optional().describe('id or name'),
    meta: z.record(z.any()).optional().describe('free-form metadata'),
  },
  async ({ mode, filter, meta }) => ({
    content: [{ type: 'text', text: `search ${mode} filter=${JSON.stringify(filter)} meta=${JSON.stringify(meta)}` }],
  }),
);

server.tool('crash', 'Exits the process shortly after replying', {}, async () => {
  setTimeout(() => process.exit(1), 20);
  return { content: [{ type: 'text', text: 'crashing' }] };
});

await server.connect(new StdioServerTransport());
