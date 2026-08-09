#!/usr/bin/env node
// Real MCP server (stdio transport) for agents/clients that can connect to
// tools directly - Claude Code, Claude Desktop, any MCP-speaking client. No
// human relay involved; see relay-server.ts for the copy/paste bridge used
// when the calling agent has no direct MCP/tool access.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ToolRegistry } from './tools/registry.js';
import { paramsToZodShape } from './param-schema.js';
import { parseArgs } from './cli-args.js';

async function main() {
  let args = parseArgs(process.argv.slice(2));
  let registry = new ToolRegistry({ sandboxRoot: args.sandboxRoot, allowExec: args.allowExec });

  let server = new McpServer(
    { name: 'mcp-terminal', version: '0.1.0' },
    { instructions: registry.summary },
  );

  for (let tool of registry.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: paramsToZodShape(tool.params),
      },
      async (args: Record<string, unknown>) => {
        try {
          let data = await tool.fn(args);
          let text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
          return { content: [{ type: 'text', text }] };
        } catch (e) {
          let message = e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text: message }], isError: true };
        }
      },
    );
  }

  let transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp-terminal] MCP stdio server ready. Sandbox root: ${registry.sandbox.root}`);
  console.error(`[mcp-terminal] run_command: ${args.allowExec ? 'ENABLED' : 'disabled (pass --allow-exec to enable)'}`);
}

main().catch((err) => {
  console.error('[mcp-terminal] fatal:', err);
  process.exit(1);
});
