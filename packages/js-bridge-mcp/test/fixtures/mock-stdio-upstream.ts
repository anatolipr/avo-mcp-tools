// Standalone stdio MCP server used as a fake "upstream" by
// proxy-manager.test.ts — spawned as a real child process (via `tsx`, same
// as the real js-bridge-mcp server under test) so the proxy's
// StdioClientTransport exercises a real stdin/stdout MCP session end to
// end, not a mocked one. One tool, mirroring the params shape a real
// upstream tool would have (a flat string param), to exercise
// proxy-manager.ts's JSON-Schema -> ToolParamSpec translation for real.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'mock-stdio-upstream', version: '0.0.1' });

server.tool('get_tickets', 'Returns fake tickets for a day', { day: z.string().describe('day filter') }, async ({ day }) => ({
  content: [{ type: 'text', text: `tickets for ${day}: [T-1, T-2]` }],
}));

await server.connect(new StdioServerTransport());
