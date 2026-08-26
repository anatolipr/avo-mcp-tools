import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrCreateTenant as getOrCreateTenantFor, tenants, startIdleSweep, createHttpServer, attachWebSocketServer } from 'mcp-tenant-lib';
import { initialHelloState } from './types.js';
import { registerHelloTools } from './tools/register.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is <pkg>/src when run via tsx (dev/test) and <pkg>/dist/src once
// built for publishing.
const packageRoot = __dirname.endsWith(`${path.sep}dist${path.sep}src`)
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8766;

const getOrCreateTenant = (id: string) => getOrCreateTenantFor(id, undefined, { ...initialHelloState });

// The 'default' tenant backs direct access with no explicit ?tenant= param.
getOrCreateTenant('default');

startIdleSweep((id) => console.error(`[mcp] sweeping idle tenant: ${id}`));

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
  extraStaticMounts: { '/main.js': CLIENT_DIR },
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
