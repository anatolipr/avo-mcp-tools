import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { registerSearchTool } from './shared/search-tool.js';
import { registerBucketFolderTools } from './shared/bucket-folder-tool.js';
import { registerAttachmentTools } from './attachments/tools.js';
import { AttachmentRepository } from './attachments/repository.js';
import { buildWebRouter } from './web/routes.js';
import { registerUiTool } from './web/ui-tool.js';
import { registerMemoryChannelTools } from './channels/tools.js';
import { startChannelSweep } from './channels/store.js';
import { startRemotePolling, type RemotePollerHandle } from './remote/remote-sync.js';

// server.ts is rebuilt from `buildMcpServer()` on every /mcp request (see below),
// so tool schemas (which conditionally include `folder` based on folder count) always
// reflect the current folders — no restart needed after an add/remove-folder call.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is <pkg>/src when run via tsx (dev/test) and <pkg>/dist/src once
// built — either way dist/client (the Vite output) sits one level above the
// nearer of the two src/ dirs, so walk up until we're out of any src/ nesting.
const packageRoot = __dirname.endsWith(`${path.sep}dist${path.sep}src`)
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');

// Always present regardless of --memory-dir/cwd, so skill_get("memory-bucket-authoring")
// works no matter where this server is run from (e.g. via `npx` in any project).
const builtinSkillsDir = path.join(__dirname, 'skills', 'builtin');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8767;

const config = loadConfig();
const db = openCache(config.cacheDbPath);

const skillSpec = skillSyncSpec([{ name: 'builtin', path: builtinSkillsDir }, ...config.skillFolders]);
const memorySpec = memorySyncSpec(config.memoryFolders);

initialScan(db, skillSpec);
initialScan(db, memorySpec);
const skillWatcher = watchSources(db, skillSpec);
const memoryWatcher = watchSources(db, memorySpec);

const skillRepo = new SkillRepository(
  db,
  [{ name: 'builtin', path: builtinSkillsDir }, ...config.skillFolders],
  config.remoteSkillFolders,
  config.baseDir
);
const memoryRepo = new MemoryRepository(db, config.memoryFolders, config.remoteMemoryFolders, config.baseDir);
skillRepo.setWatcher(skillWatcher);
memoryRepo.setWatcher(memoryWatcher);

const attachmentRepo = new AttachmentRepository(memoryRepo, skillRepo);

// Remote sources have no filesystem to watch (chokidar doesn't apply) - a
// fixed-interval poller stands in for watchSources above, pulling changes
// into each remote source's local mirror directory and reusing the exact
// same upsertFile/removeFile path a local file-watch event would.
const remoteSkillPoller: RemotePollerHandle | undefined =
  config.remoteSkillFolders.length > 0 ? startRemotePolling(db, skillSpec, config.remoteSkillFolders, config.baseDir) : undefined;
const remoteMemoryPoller: RemotePollerHandle | undefined =
  config.remoteMemoryFolders.length > 0 ? startRemotePolling(db, memorySpec, config.remoteMemoryFolders, config.baseDir) : undefined;

if (config.skillFolders.length === 0 && config.memoryFolders.length === 0) {
  console.error(
    `[memory-bucket] no folders configured — open http://localhost:${PORT} to add one`
  );
}

// If the user refers to "mem bucket", "mem bucket mcp", "memory bucket", or
// "skill bucket" (its working-title predecessor) in conversation, they mean
// this server — surfaced both in serverInfo.description and instructions so
// clients that expose either to the model can make that association.
const SERVER_DESCRIPTION =
  'Also known as "memory bucket", "mem bucket", or "skill bucket" — if the user refers to this server by any of those names, they mean this one.';
const SERVER_INSTRUCTIONS = `${SERVER_DESCRIPTION} Exposes skill_* (reusable coding patterns, stored as agentskills.io-standard SKILL.md folders) and memory_* (point-in-time working context — plans, specs, SQL, session summaries — looked up by key) tools, plus shared relocate/bucket_search/bucket_*_folder tools. Use skill_search/memory_search/bucket_search for full-text search over body content (not just metadata) — bucket_search when you don't know which bucket something landed in. Use bucket_list_folders to see what named source directories (folders) are configured before passing a folder argument elsewhere, and bucket_create_folder/bucket_delete_folder to register or unregister one. Most operations have a _bulk_ variant (bulk_get/bulk_create/bulk_update/bulk_delete/bulk_rename, relocate_bulk) that take a list and return per-item success/failure — prefer these over looping single calls when acting on more than one item. A memory doc's key can be changed in place via memory_update(id, key: ...) — no separate rename tool needed. Before calling any *_create/*_update/relocate tool, call skill_get("memory-bucket-authoring") first to learn the exact frontmatter schema — don't guess the shape. Also exposes memory_channel_read/memory_channel_post/list_memory_channels — a SEPARATE, ephemeral in-memory layer for live cross-agent coordination (a shared scratchpad/discussion channel by name), never written to disk and never indexed by memory_search/bucket_search; do not confuse these with the persisted memory_* docs above.`;

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'memory-bucket', version: '0.1.0', description: SERVER_DESCRIPTION },
    { capabilities: {}, instructions: SERVER_INSTRUCTIONS }
  );
  registerSkillTools(server, skillRepo);
  registerMemoryTools(server, memoryRepo);
  registerRelocateTool(server, skillRepo, memoryRepo);
  registerSearchTool(server, db);
  registerBucketFolderTools(server, config, skillRepo, memoryRepo, db, skillSpec, memorySpec);
  registerAttachmentTools(server, attachmentRepo);
  registerUiTool(server, PORT);
  registerMemoryChannelTools(server);
  return server;
}

startChannelSweep((name) => console.error(`[memory-bucket] sweeping idle memory channel: ${name}`));

const app = express();
app.use(express.json());
app.use(buildWebRouter(db, config, skillRepo, memoryRepo, skillSpec, memorySpec, { skill: remoteSkillPoller, memory: remoteMemoryPoller }));
app.use(express.static(path.join(packageRoot, 'dist', 'client')));

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
  console.error(`[memory-bucket] UI available at http://localhost:${PORT}`);
  console.error(
    `[memory-bucket] folderfoo integration: ${config.folderfooMode}${config.folderfooHost ? ` (${config.folderfooHost})` : ''}` +
      (config.folderfooMode === 'off' ? ' — pass --folderfoo-mode dev|cloud (or set FOLDERFOO_MODE) to enable' : '')
  );
  console.error(`[memory-bucket] skill folders: ${config.skillFolders.map((f) => `${f.name}=${f.path}`).join(', ') || '(none)'}`);
  console.error(`[memory-bucket] memory folders: ${config.memoryFolders.map((f) => `${f.name}=${f.path}`).join(', ') || '(none)'}`);
  if (config.remoteSkillFolders.length > 0 || config.remoteMemoryFolders.length > 0) {
    console.error(
      `[memory-bucket] remote (folderfoo) skill folders: ${config.remoteSkillFolders.map((f) => `${f.name}@${f.server}`).join(', ') || '(none)'}`
    );
    console.error(
      `[memory-bucket] remote (folderfoo) memory folders: ${config.remoteMemoryFolders.map((f) => `${f.name}@${f.server}`).join(', ') || '(none)'}`
    );
  }
});

process.on('SIGINT', () => {
  remoteSkillPoller?.stop();
  remoteMemoryPoller?.stop();
  db.close();
  process.exit(0);
});
