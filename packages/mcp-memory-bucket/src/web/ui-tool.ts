import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { scaffoldifyUiUrl } from './scaffoldify-access.js';

// The bucket's UI is moving to scaffoldify.com (its "MCP" tab), which talks to this server over
// localhost. MEMORY_BUCKET_UI=local returns the old built-in page instead while that migration runs.
export function registerUiTool(mcp: McpServer, port: number, uiToken: string): void {
  mcp.tool(
    'bucket_open_ui',
    'Returns the URL for the memory bucket web UI: the "MCP" tab on scaffoldify.com, connected to this local server — searching/filtering skills and memory docs by tag, status, owner, deprecated flag and full text, editing front matter, marking items deprecated or paused, deleting them (single or bulk), and managing folders. Open the URL as given: it carries the token this server needs. For anything beyond that, use the skill_*/memory_* tools instead.',
    {},
    async () => {
      const local = `http://localhost:${port}/`;
      const text =
        process.env.MEMORY_BUCKET_UI === 'local'
          ? local
          : `${scaffoldifyUiUrl(port, uiToken)}\n\n(The built-in page is still at ${local} while the UI moves to scaffoldify.com.)`;
      return { content: [{ type: 'text', text }] };
    }
  );
}
