// Standalone stdio MCP server used as a fake "upstream" by
// proxy-manager.test.ts, mirroring @modelcontextprotocol/server-filesystem's
// read_multiple_files/edit_file shape (a top-level array-of-string param, an
// array-of-object param) to exercise proxy-manager.ts's recursive
// JSON-Schema -> ToolParamSpec translation for real, end-to-end. Kept
// separate from mock-stdio-upstream.ts so its tool count stays fixed for the
// other tests that assert against it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'mock-stdio-upstream-nested-params', version: '0.0.1' });

server.tool(
  'batch_tickets',
  'Applies fake edits to a batch of ticket ids',
  {
    ids: z.array(z.string()).describe('Ticket ids to touch'),
    edits: z.array(z.object({ field: z.string(), value: z.string() })).describe('Field/value pairs to apply to each ticket'),
  },
  async ({ ids, edits }) => ({
    content: [{ type: 'text', text: `applied ${edits.length} edit(s) to [${ids.join(', ')}]` }],
  }),
);

await server.connect(new StdioServerTransport());
