import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrCreateTenant as getOrCreateTenantForForm, tenants, startIdleSweep, createHttpServer, attachWebSocketServer } from 'mcp-tenant-lib';
import type { FormDef } from './types.js';
import { initialValuesFor } from './types.js';
import { makeRegisterFormTools } from './tools/register.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is <pkg>/src when run via tsx (dev/test) and <pkg>/dist/src once
// built — either way dist/client and config sit one level above the nearer
// of the two src/ dirs, so walk up until we're out of any src/ nesting.
const packageRoot = __dirname.endsWith(`${path.sep}dist${path.sep}src`)
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8765;

const initialFormDef = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'config', 'fields.json'), 'utf-8')
) as FormDef;

const getOrCreateTenant = (id: string) =>
  getOrCreateTenantForForm(id, initialFormDef, initialValuesFor(initialFormDef));

// The 'default' tenant backs plain browser access (no MCP session), so
// `npm start` + opening http://localhost:PORT keeps working standalone.
getOrCreateTenant('default');

startIdleSweep((id) => console.error(`[mcp] sweeping idle tenant: ${id}`));

const STATIC_DIR = path.join(packageRoot, 'dist', 'client');

const httpServer = createHttpServer({
  port: PORT,
  staticDir: STATIC_DIR,
  initialSchema: initialFormDef,
  initialValues: initialValuesFor(initialFormDef),
  identity: { name: 'mcp-form', version: '0.2.0' },
  registerFn: makeRegisterFormTools(initialFormDef),
  // A session that never calls join_channel lands on the shared 'default'
  // channel rather than a private per-session UUID — same tradeoff
  // js-bridge-mcp already makes (see its server.ts). Named channels are the
  // encouraged path (see join_channel/define_form's tool descriptions);
  // 'default' is the deliberate, anonymous, unscoped fallback for a
  // genuinely one-off form, not a private sandbox.
  defaultTenantMode: 'shared',
});

attachWebSocketServer(httpServer, PORT, initialFormDef, initialValuesFor(initialFormDef));

httpServer.listen(PORT, () => {
  console.error(`[mcp-form] UI available at http://localhost:${PORT}`);
});

export { getOrCreateTenant, tenants, httpServer };
