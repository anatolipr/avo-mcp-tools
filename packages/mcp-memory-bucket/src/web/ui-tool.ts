import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerUiTool(mcp: McpServer, port: number): void {
  mcp.tool(
    'bucket_open_ui',
    'Returns the URL for the mem-bucket web viewer — a browser UI for searching/filtering skills and memory docs by tag, status, owner, deprecated flag, and fulltext, sorting by creation date, and marking items deprecated or deleting them (single or bulk). For anything beyond that, use the skill_*/memory_* tools instead.',
    {},
    async () => {
      const url = `http://localhost:${port}/`;
      return { content: [{ type: 'text', text: url }] };
    }
  );
}
