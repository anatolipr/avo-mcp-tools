import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FormDef } from '@mcp-form-demo/mcp-tenant-server';
import { getOrCreateTenant as getOrCreateTenantForForm, tenants, startIdleSweep, createHttpServer, attachWebSocketServer } from '@mcp-form-demo/mcp-tenant-server';
import { registerFormTools } from './tools/register.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8765;

const initialFormDef = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'fields.json'), 'utf-8')
) as FormDef;

const getOrCreateTenant = (id: string) => getOrCreateTenantForForm(id, initialFormDef);

// The 'default' tenant backs plain browser access (no MCP session), so
// `npm start` + opening http://localhost:PORT keeps working standalone.
getOrCreateTenant('default');

startIdleSweep((id) => console.error(`[mcp] sweeping idle tenant: ${id}`));

const STATIC_DIR = path.join(__dirname, '..', 'dist', 'client');

const httpServer = createHttpServer({
  port: PORT,
  staticDir: STATIC_DIR,
  initialFormDef,
  registerFn: registerFormTools,
});

attachWebSocketServer(httpServer, PORT, initialFormDef);

httpServer.listen(PORT, () => {
  console.error(`[mcp-form-demo] UI available at http://localhost:${PORT}`);
});

export { getOrCreateTenant, tenants, httpServer };
