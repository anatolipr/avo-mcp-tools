// Standalone stdio MCP server used as a fake "upstream" by features.test.ts,
// for what a proxy must carry through unchanged: an error result, non-text
// content, tool annotations, progress notifications and cancellation.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'mock-stdio-upstream-features', version: '0.0.1' });
let cancelled = false;

server.tool('fail', 'Always fails', {}, async () => ({
  content: [{ type: 'text', text: 'upstream says no' }],
  isError: true,
}));

server.tool('image', 'Returns an image', {}, async () => ({
  content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
}));

server.tool('read_thing', 'Reads a thing', {}, { readOnlyHint: true, title: 'Read thing' }, async () => ({
  content: [{ type: 'text', text: 'thing' }],
}));

server.tool('slow', 'Reports progress, then waits', { ms: z.number() }, async ({ ms }, extra) => {
  const progressToken = extra._meta?.progressToken;
  if (progressToken !== undefined) {
    await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: 1, total: 2, message: 'halfway' } });
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    extra.signal.addEventListener('abort', () => {
      cancelled = true;
      clearTimeout(timer);
      resolve();
    });
  });
  return { content: [{ type: 'text', text: 'slow done' }] };
});

server.tool('was_cancelled', 'Reports whether "slow" was ever cancelled', {}, async () => ({
  content: [{ type: 'text', text: String(cancelled) }],
}));

await server.connect(new StdioServerTransport());
