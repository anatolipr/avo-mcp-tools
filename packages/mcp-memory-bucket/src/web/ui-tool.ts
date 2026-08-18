import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerUiTool(mcp: McpServer, port: number): void {
  mcp.tool(
    'bucket_open_ui',
    'Returns the URL for the mem-bucket web viewer — a read-only browser UI for searching/filtering skills and memory docs by tag, status, owner, and fulltext. Not for editing; use the skill_*/memory_* tools for that.',
    {},
    async () => {
      const url = `http://localhost:${port}/`;
      return { content: [{ type: 'text', text: url }] };
    }
  );
}
