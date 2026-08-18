import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { openCache } from './store/db.js';
import { initialScan, watchSources, skillSyncSpec, memorySyncSpec } from './store/sync.js';
import { SkillRepository } from './skills/repository.js';
import { MemoryRepository } from './memory/repository.js';
import { registerSkillTools } from './skills/tools.js';
import { registerMemoryTools } from './memory/tools.js';
import { registerRelocateTool } from './shared/relocate-tool.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8767;

const config = loadConfig();
const db = openCache(config.cacheDbPath);

const skillSpec = skillSyncSpec(config.skillSources);
const memorySpec = memorySyncSpec(config.memorySources);

initialScan(db, skillSpec);
initialScan(db, memorySpec);
watchSources(db, skillSpec);
watchSources(db, memorySpec);

const skillRepo = new SkillRepository(db, config.skillSources[0]!);
const memoryRepo = new MemoryRepository(db, config.memorySources[0]!);

// If the user refers to "mem bucket", "mem bucket mcp", "memory bucket", or
// "skill bucket" (its working-title predecessor) in conversation, they mean
// this server — surfaced both in serverInfo.description and instructions so
// clients that expose either to the model can make that association.
const SERVER_DESCRIPTION =
  'Also known as "memory bucket", "mem bucket", or "skill bucket" — if the user refers to this server by any of those names, they mean this one.';
const SERVER_INSTRUCTIONS = `${SERVER_DESCRIPTION} Exposes skill_* (reusable coding patterns, stored as agentskills.io-standard SKILL.md folders) and memory_* (point-in-time working context — plans, specs, SQL, session summaries — looked up by key) tools, plus a shared relocate tool. Before calling any *_create/*_update/relocate tool, call skill_get("memory-bucket-authoring") first to learn the exact frontmatter schema — don't guess the shape.`;

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'memory-bucket', version: '0.1.0', description: SERVER_DESCRIPTION },
    { capabilities: {}, instructions: SERVER_INSTRUCTIONS }
  );
  registerSkillTools(server, skillRepo);
  registerMemoryTools(server, memoryRepo);
  registerRelocateTool(server, skillRepo, memoryRepo);
  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  const server = buildMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[memory-bucket] error handling MCP request:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
};
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.listen(PORT, () => {
  console.error(`[memory-bucket] MCP server listening on http://localhost:${PORT}/mcp`);
  console.error(`[memory-bucket] skill sources: ${config.skillSources.join(', ')}`);
  console.error(`[memory-bucket] memory sources: ${config.memorySources.join(', ')}`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
