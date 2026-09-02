import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { getOrCreateTenant as getOrCreateTenantFor, tenants, startIdleSweep, startEmptySweep, createHttpServer, attachWebSocketServer } from 'mcp-tenant-lib';
import { initialHelloState } from './types.js';
import { registerHelloTools } from './tools/register.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is <pkg>/src when run via tsx (dev/test) and <pkg>/dist/src once
// built for publishing.
const packageRoot = __dirname.endsWith(`${path.sep}dist${path.sep}src`)
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8766;

// A stale js-bridge-mcp instance (e.g. left running from a previous editor
// session/reload) is the overwhelmingly common occupant of this port, and
// leaving it running would just make this new instance fail to bind. Free
// the port unconditionally before listening, macOS/Linux only.
function killWhateverIsOnPort(port: number) {
  let pids: string;
  try {
    pids = execSync(`lsof -ti tcp:${port}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return; // lsof exits non-zero when nothing is listening on the port
  }
  if (!pids) return;
  for (const pid of pids.split('\n')) {
    if (pid === String(process.pid)) continue;
    try {
      process.kill(Number(pid), 'SIGKILL');
      console.error(`[js-bridge-mcp] killed process ${pid} that was on port ${port}`);
    } catch {
      // already gone
    }
  }
}
killWhateverIsOnPort(PORT);

const getOrCreateTenant = (id: string) => getOrCreateTenantFor(id, undefined, { ...initialHelloState });

// The 'default' tenant backs direct access with no explicit ?tenant= param.
getOrCreateTenant('default');

startIdleSweep((id) => console.error(`[mcp] sweeping idle tenant: ${id}`));
// Separate, much shorter sweep for channels with zero live connections
// (tab closed, or the page deliberately left via leave_channel when
// switching channels) - see startEmptySweep's own doc comment for why this
// is a distinct mechanism from the idle sweep above.
startEmptySweep((id) => console.error(`[mcp] sweeping empty channel: ${id}`));

// main.js is fetched from here by absolute path (get_embed_snippet always
// embeds "<server>/main.js", see hello-tools.ts) regardless of what's
// mounted at "/" — the legacy page it's injected into is hosted separately
// (see legacy-page/, run via `npm run start:static`), not by this server.
// "/" itself serves the connected-apps dashboard (dist/dashboard) instead,
// so visiting the server's own URL shows something useful rather than
// "Not found".
const CLIENT_DIR = path.join(packageRoot, 'dist', 'client');
const DASHBOARD_DIR = path.join(packageRoot, 'dist', 'dashboard');

const httpServer = createHttpServer({
  port: PORT,
  staticDir: DASHBOARD_DIR,
  initialSchema: undefined,
  initialValues: initialHelloState,
  identity: { name: 'js-bridge-mcp', version: '0.1.0' },
  registerFn: registerHelloTools,
  // Each of these is a fixed-URL asset other pages import cross-origin by
  // absolute path (main.js via get_embed_snippet; tool-bus.js/connect.js
  // per their own header comments: shared infrastructure any host app
  // imports directly, e.g. "<server>/connect.js") - single-file mounts, not
  // a whole-directory one, so dist/client can't accidentally serve
  // anything else placed there later.
  extraStaticMounts: {
    '/main.js': CLIENT_DIR,
    '/tool-bus.js': CLIENT_DIR,
    '/connect.js': CLIENT_DIR,
  },
  // js-bridge-mcp typically bridges a single browser page per server; MCP
  // clients aren't expected to pin ?tenant= themselves (some, like VS Code
  // Copilot, open a fresh MCP session with no ?tenant= on every
  // reconnect/idle DELETE cycle). Sharing the one 'default' tenant keeps
  // every such session pointed at the same already-bridged browser tab
  // instead of each reconnect minting a new, empty tenant.
  defaultTenantMode: 'shared',
});

attachWebSocketServer(httpServer, PORT, undefined, initialHelloState);

httpServer.listen(PORT, () => {
  console.error(`[js-bridge-mcp] MCP + bridge server listening on http://localhost:${PORT}`);
  console.error(`[js-bridge-mcp] dashboard: http://localhost:${PORT}`);
  console.error(`[js-bridge-mcp] serve legacy-page/hello-world.html separately: npm run start:static`);
});

export { getOrCreateTenant, tenants, httpServer };
