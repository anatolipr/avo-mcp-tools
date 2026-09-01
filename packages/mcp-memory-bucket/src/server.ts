import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type RemoteFolder } from './config.js';
import { openCache } from './store/db.js';
import { initialScan, watchSources, skillSyncSpec, memorySyncSpec } from './store/sync.js';
import { SkillRepository, findSkillDirAncestor } from './skills/repository.js';
import { MemoryRepository } from './memory/repository.js';
import { registerSkillTools } from './skills/tools.js';
import { registerMemoryTools } from './memory/tools.js';
import { registerRelocateTool } from './shared/relocate-tool.js';
import { registerSearchTool } from './shared/search-tool.js';
import { registerBucketFolderTools } from './shared/bucket-folder-tool.js';
import { registerBucketShareTools } from './shared/bucket-share-tool.js';
import { registerAttachmentTools } from './attachments/tools.js';
import { AttachmentRepository } from './attachments/repository.js';
import { buildWebRouter } from './web/routes.js';
import { registerUiTool } from './web/ui-tool.js';
import { registerMemoryChannelTools } from './channels/tools.js';
import { startChannelSweep } from './channels/store.js';
import { startRemotePolling, type RemotePollerHandle } from './remote/remote-sync.js';
import { IdentityTracker, decodeUsername, isFolderVisible } from './remote/identity.js';
import { getCredential } from './remote/credentials.js';
import { FolderfooAuthError } from './remote/folderfoo-client.js';

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
const identity = new IdentityTracker(config.folderfooMode);
// Restore the logged-in identity from a previously saved credential so a
// restarted process doesn't hide every remote folder (see isFolderVisible)
// until the user re-logs-in via the web UI - the JWT itself, not the config
// file's stored username, is the source of truth here since it's what
// login.ts's own handler decodes to call identity.setUsername() normally.
if (config.folderfooHost) {
  const credential = getCredential(config.baseDir, config.folderfooHost);
  if (credential) {
    try {
      identity.setUsername(decodeUsername(credential.jwt));
    } catch {
      // malformed/stale token - leave identity logged out, same as no credential at all
    }
  }
}

// Built ONCE and shared by reference with SkillRepository below — registerRemoteFolder/addFolder
// push into this same array in place, so skillSpec.sources (used by initialScan/watchSources/
// startRemotePolling/pollOne's upsertFile) sees a folder added live, without a restart. Evaluating
// this array literal separately for skillSpec and for `new SkillRepository(...)` (as before) creates
// two distinct arrays that fall out of sync the moment a folder is added live: upsertFile's
// folderForFile lookup against the stale skillSpec.sources then finds no match and stamps folder=""
// on every doc from that folder — permanently, since upsertFile's mtime-based skip check means the
// row is never reprocessed to pick up the correct value once the array is finally in sync.
const skillFolders = [{ name: 'builtin', path: builtinSkillsDir }, ...config.skillFolders];
const skillSpec = skillSyncSpec(skillFolders);
const memorySpec = memorySyncSpec(config.memoryFolders);

// Built before watchSources below so onUnmatchedFileChange's closure can reference skillRepo —
// SkillRepository's own constructor doesn't need the watcher itself (that's attached separately via
// setWatcher once it exists).
const skillRepo = new SkillRepository(
  db,
  skillFolders,
  config.remoteSkillFolders,
  config.baseDir,
  identity
);
const memoryRepo = new MemoryRepository(db, config.memoryFolders, config.remoteMemoryFolders, config.baseDir, identity);

// Reacts to a direct filesystem write under an existing skill's directory (any file that isn't
// SKILL.md itself, outside attachments/) that bypassed every MCP tool — e.g. an agent using a
// generic file-write tool to drop references/foo.md straight into a skill's directory. Pushes/
// re-pushes it to the skill's remote folder if that folder is remote-backed (no-op for a local
// folder — pushSkillSiblingFileIfNeeded/trashSkillSiblingFileIfNeeded already guard on that), and
// trashes it remotely on unlink. Kept out of the generic sync.ts layer since "parent dir contains
// SKILL.md" is a skill-specific convention.
skillSpec.onUnmatchedFileChange = (filePath, changeType) => {
  if (path.basename(filePath) === '.last-synced') return; // remote poller's own watermark sidecar file, not skill content
  const folder = skillFolders.find((f) => filePath.startsWith(f.path + path.sep));
  if (!folder) return;
  const skillDir = findSkillDirAncestor(filePath, folder.path);
  if (!skillDir) return; // not actually under any skill's own directory (e.g. a stray file at the folder root)
  if (changeType === 'unlink') {
    skillRepo.trashSkillSiblingFileIfNeeded(folder.name, filePath).catch((err) => console.error(`[memory-bucket] failed to trash sibling ${filePath}:`, err));
  } else {
    fs.promises
      .readFile(filePath)
      .then((data) => skillRepo.pushSkillSiblingFileIfNeeded(folder.name, filePath, data))
      .catch((err) => console.error(`[memory-bucket] failed to push sibling ${filePath}:`, err));
  }
};

initialScan(db, skillSpec);
initialScan(db, memorySpec);
const skillWatcher = watchSources(db, skillSpec);
const memoryWatcher = watchSources(db, memorySpec);
skillRepo.setWatcher(skillWatcher);
memoryRepo.setWatcher(memoryWatcher);

const attachmentRepo = new AttachmentRepository(memoryRepo, skillRepo, db);

// Remote sources have no filesystem to watch (chokidar doesn't apply) - a
// fixed-interval poller stands in for watchSources above, pulling changes
// into each remote source's local mirror directory and reusing the exact
// same upsertFile/removeFile path a local file-watch event would.
//
// onSynced re-declares any attachment file that's present on disk (pulled down by this same poll)
// but missing from its parent doc's declared list — e.g. a file restored from folderfoo's own
// trash after an earlier attachment_remove. See AttachmentRepository.repairUnlistedInFolder's doc
// comment for why this lives here (needs memoryRepo/skillRepo, which remote-sync.ts itself doesn't
// depend on) rather than inside pollOne/reconcileDeletions.
//
// startRemotePolling below only ever calls onSynced for a folder that passed its own isVisible
// check first (isRemoteFolderVisible), so this never runs for a folder connected under a
// different identity than the one currently logged in — repairUnlistedInFolder can safely call
// skillRepo.get()/memoryRepo.get() without a spurious "not found" from a currently-invisible doc.
function onAttachmentSync(table: 'skills' | 'memory_docs', folder: RemoteFolder): void {
  attachmentRepo.repairUnlistedInFolder(table, folder.name).catch((err) => {
    console.error(`[memory-bucket] failed to repair attachments for folder "${folder.name}":`, err);
    // The credential can die between pollOne's own success and this later read (a real race, not
    // just pollOne's own auth check) — see remote-sync.ts's onAuthExpired doc comment for why
    // identity must be told here too, not just from pollOne's catch block, or IdentityTracker keeps
    // reporting a dead login as live until the user manually re-authenticates.
    if (err instanceof FolderfooAuthError) identity.clearUsername();
  });
}
// folderfoo integration off means nobody can ever be logged in this process (identity.mode stays
// 'off'), so every remote folder is permanently invisible per isFolderVisible/matchesCurrentIdentity
// above regardless of polling - polling them anyway just hits a folderfoo host that was never meant
// to be reachable this run (e.g. a `dev` host from a previous --folderfoo-mode session) and throws a
// raw fetch/ECONNREFUSED error on every resync, since pollOne only swallows FolderfooAuthError.
// Gates the actual network poll, not just the post-sync attachment repair (onAttachmentSync
// above already had this check, but only for its own callback — pollOne itself ran regardless).
// A folder connected under a different --folderfoo-mode/identity than the one currently logged in
// (e.g. a leftover `dev` source from a prior session while this run is `cloud`) is invisible to
// every tool already; without this it was still polled every interval tick and on every
// resyncAll, hitting whatever host:port it points at (often nothing, hence the raw
// fetch/ECONNREFUSED) for a source nothing can currently see anyway.
const isRemoteFolderVisible = (folder: RemoteFolder) => isFolderVisible(folder, identity.current());
const remoteSkillPoller: RemotePollerHandle | undefined =
  config.folderfooMode !== 'off' && config.remoteSkillFolders.length > 0
    ? startRemotePolling(
        db,
        skillSpec,
        config.remoteSkillFolders,
        config.baseDir,
        (folder) => onAttachmentSync('skills', folder),
        isRemoteFolderVisible,
        () => identity.clearUsername()
      )
    : undefined;
const remoteMemoryPoller: RemotePollerHandle | undefined =
  config.folderfooMode !== 'off' && config.remoteMemoryFolders.length > 0
    ? startRemotePolling(
        db,
        memorySpec,
        config.remoteMemoryFolders,
        config.baseDir,
        (folder) => onAttachmentSync('memory_docs', folder),
        isRemoteFolderVisible,
        () => identity.clearUsername()
      )
    : undefined;

// Forces one immediate poll of every remote source at process start, instead
// of leaving the cache to show whatever was last synced until the first
// fixed interval tick (up to POLL_INTERVAL_MS later) - this is effectively
// "login" for a background server: a fresh process (laptop wake, editor
// reopened) is exactly when another device's writes are most likely to be
// unseen locally yet.
remoteSkillPoller?.resyncAll().catch((err) => console.error('[memory-bucket] initial remote skill resync failed:', err));
remoteMemoryPoller?.resyncAll().catch((err) => console.error('[memory-bucket] initial remote memory resync failed:', err));

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
const SERVER_INSTRUCTIONS = `${SERVER_DESCRIPTION} Exposes skill_* (reusable coding patterns, stored as agentskills.io-standard SKILL.md folders) and memory_* (point-in-time working context — plans, specs, SQL, session summaries — looked up by key) tools, plus shared relocate/bucket_search/bucket_*_folder tools. Use skill_search/memory_search/bucket_search for full-text search over body content (not just metadata) — bucket_search when you don't know which bucket something landed in. Use bucket_list_folders to see what named source directories (folders) are configured before passing a folder argument elsewhere, and bucket_create_folder/bucket_delete_folder to register or unregister one (bucket_delete_folder works for both local and remote folders). bucket_list_remote_folders/bucket_connect_remote_folder connect a folderfoo folder as a new source, once the user is logged in via the web UI. Most operations have a _bulk_ variant (bulk_get/bulk_create/bulk_update/bulk_delete/bulk_rename, relocate_bulk) that take a list and return per-item success/failure — prefer these over looping single calls when acting on more than one item. A memory doc's key can be changed in place via memory_update(id, key: ...) — no separate rename tool needed. Before calling any *_create/*_update/relocate tool, call skill_get("memory-bucket-authoring") first to learn the exact frontmatter schema — don't guess the shape. Also exposes memory_channel_read/memory_channel_post/list_memory_channels — a SEPARATE, ephemeral in-memory layer for live cross-agent coordination (a shared scratchpad/discussion channel by name), never written to disk and never indexed by memory_search/bucket_search; do not confuse these with the persisted memory_* docs above.`;

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'memory-bucket', version: '0.1.0', description: SERVER_DESCRIPTION },
    { capabilities: {}, instructions: SERVER_INSTRUCTIONS }
  );
  registerSkillTools(server, skillRepo);
  registerMemoryTools(server, memoryRepo);
  registerRelocateTool(server, skillRepo, memoryRepo);
  registerSearchTool(server, db);
  registerBucketFolderTools(server, config, skillRepo, memoryRepo, db, skillSpec, memorySpec, identity);
  registerBucketShareTools(server, config, skillRepo, memoryRepo, db);
  registerAttachmentTools(server, attachmentRepo);
  registerUiTool(server, PORT);
  registerMemoryChannelTools(server);
  return server;
}

startChannelSweep((name) => console.error(`[memory-bucket] sweeping idle memory channel: ${name}`));

const app = express();
app.use(express.json());
app.use(buildWebRouter(db, config, skillRepo, memoryRepo, skillSpec, memorySpec, identity, { skill: remoteSkillPoller, memory: remoteMemoryPoller }, attachmentRepo));
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
    const suffix = config.folderfooMode === 'off' ? ' (folderfoo integration off — not synced, ignored)' : '';
    console.error(
      `[memory-bucket] remote (folderfoo) skill folders${suffix}: ${config.remoteSkillFolders.map((f) => `${f.name}@${f.server}`).join(', ') || '(none)'}`
    );
    console.error(
      `[memory-bucket] remote (folderfoo) memory folders${suffix}: ${config.remoteMemoryFolders.map((f) => `${f.name}@${f.server}`).join(', ') || '(none)'}`
    );
  }
});

process.on('SIGINT', () => {
  remoteSkillPoller?.stop();
  remoteMemoryPoller?.stop();
  db.close();
  process.exit(0);
});
