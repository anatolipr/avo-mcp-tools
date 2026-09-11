// Standalone streamableHttp MCP server used as a fake "upstream" by
// proxy-manager.test.ts — started in-process (unlike the stdio fixture,
// which must be a real child process; an HTTP server needs no separate
// process to give proxy-manager.ts's StreamableHTTPClientTransport a real
// network round trip). Exports start()/stop() rather than running
// standalone, so the test file controls its lifecycle directly.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export async function startMockHttpUpstream(port: number): Promise<{ close: () => Promise<void> }> {
  const server = new McpServer({ name: 'mock-http-upstream', version: '0.0.1' });
  server.tool('echo', 'Echoes back the given text', { text: z.string() }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo: ${text}` }],
  }));

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
