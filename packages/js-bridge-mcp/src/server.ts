import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrCreateTenant as getOrCreateTenantFor, tenants, startIdleSweep, createHttpServer, attachWebSocketServer } from '@avo-mcp-tools/mcp-tenant-server';
import { initialHelloState } from './types.js';
import { registerHelloTools } from './tools/register.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8766;

const getOrCreateTenant = (id: string) => getOrCreateTenantFor(id, undefined, { ...initialHelloState });

// The 'default' tenant backs direct access with no explicit ?tenant= param.
getOrCreateTenant('default');

startIdleSweep((id) => console.error(`[mcp] sweeping idle tenant: ${id}`));

// Only main.js is ever fetched from here — the legacy page this bundle is
// injected into is hosted separately (see legacy-page/, run via
// `npm run start:static`), not by this server.
const STATIC_DIR = path.join(__dirname, '..', 'dist', 'client');

const httpServer = createHttpServer({
  port: PORT,
  staticDir: STATIC_DIR,
  initialSchema: undefined,
  initialValues: initialHelloState,
  identity: { name: 'js-bridge-mcp', version: '0.1.0' },
  registerFn: registerHelloTools,
});

attachWebSocketServer(httpServer, PORT, undefined, initialHelloState);

httpServer.listen(PORT, () => {
  console.error(`[js-bridge-mcp] MCP + bridge server listening on http://localhost:${PORT}`);
  console.error(`[js-bridge-mcp] serve legacy-page/hello-world.html separately: npm run start:static`);
});

export { getOrCreateTenant, tenants, httpServer };
