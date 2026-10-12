import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import open from 'open';
import {
  getOrCreateTenant as getOrCreateTenantFor, tenants, startIdleSweep, startEmptySweep, createHttpServer, attachWebSocketServer,
  setDynamicToolStore, createFileDynamicToolStore, setToolCallLogConfig, getToolCallLogConfig,
} from 'mcp-tenant-lib';
import { initialHelloState } from './types.js';
import { registerHelloTools } from './tools/register.js';
import { initProxyManager, shutdownProxyManager } from './proxy/proxy-manager.js';
import { installProxyAdminRoutes } from './proxy/admin-routes.js';
import { initAdminChannel } from './proxy/admin-channel.js';
import { isLoopbackAddress, resolveSecurityOptions } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is <pkg>/src when run via tsx (dev/test) and <pkg>/dist/src once
// built for publishing.
const packageRoot = __dirname.endsWith(`${path.sep}dist${path.sep}src`)
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8766;
const IDENTITY_NAME = 'js-bridge-mcp';

function readPackageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const VERSION = readPackageVersion();
const security = resolveSecurityOptions();
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const forceKillPort = process.argv.includes('--force-kill-port') || TRUTHY.has((process.env.JS_BRIDGE_MCP_FORCE_KILL_PORT ?? '').toLowerCase());
// Off by default: with it on, a tool an agent registered on a page
// (register_page_tool_by_path/_by_code) is saved to disk and registered again
// the next time that page connects under the same name, across page reloads
// and server restarts. Its code still only runs when the tool is called.
const persistPageTools = process.argv.includes('--persist-page-tools') || TRUTHY.has((process.env.JS_BRIDGE_MCP_PERSIST_PAGE_TOOLS ?? '').toLowerCase());
const PAGE_TOOLS_PATH = process.env.PAGE_TOOLS_PATH ?? path.join(os.homedir(), '.js-bridge-mcp-page-tools.json');

/** Starting values for the tool call log (the /calls window changes them at runtime); a missing or non-numeric variable leaves the built-in default. */
function applyCallLogEnv() {
  const limit = Number(process.env.JS_BRIDGE_MCP_CALL_LOG_LIMIT);
  const ttlMinutes = Number(process.env.JS_BRIDGE_MCP_CALL_LOG_TTL_MINUTES);
  setToolCallLogConfig({
    limit: process.env.JS_BRIDGE_MCP_CALL_LOG_LIMIT && Number.isFinite(limit) ? limit : undefined,
    ttlMs: process.env.JS_BRIDGE_MCP_CALL_LOG_TTL_MINUTES && Number.isFinite(ttlMinutes) ? ttlMinutes * 60_000 : undefined,
  });
}

function pidsOnPort(port: number): number[] {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return [...new Set(out.split('\n').map((line) => Number(line.trim())).filter((pid) => pid > 0 && pid !== process.pid))];
  } catch {
    return []; // lsof exits non-zero when nothing is listening on the port (or isn't installed, e.g. Windows)
  }
}

function commandOutput(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(800) });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

/**
 * Is whatever holds `port` an (older) js-bridge-mcp? Asked over HTTP first:
 * /api/identity exists from 0.7.0 on, and every earlier build's /main.js
 * bundle carries this server's "[js-bridge-mcp]" log prefix. A hung instance
 * answers neither, so the process itself is inspected next: its command line
 * (an npx/global install runs ".../js-bridge-mcp"), or — for a `tsx
 * src/server.ts` dev run, whose command line is only a relative path — a
 * server entrypoint in the command line AND this package as its working
 * directory. The working directory alone is not enough: any unrelated tool
 * started from this folder would match.
 */
async function isStaleJsBridgeInstance(port: number, pid: number): Promise<boolean> {
  const identity = await fetchText(`http://127.0.0.1:${port}/api/identity`);
  try {
    if (JSON.parse(identity).name === IDENTITY_NAME) return true;
  } catch { /* not JSON — an older build, or something else entirely */ }
  if ((await fetchText(`http://127.0.0.1:${port}/main.js`)).includes('[js-bridge-mcp]')) return true;
  const command = commandOutput('ps', ['-p', String(pid), '-o', 'command=']);
  if (command.includes(IDENTITY_NAME)) return true;
  return /server\.(ts|js)\b/.test(command) && commandOutput('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).includes(IDENTITY_NAME);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stale js-bridge-mcp instance (e.g. left running from a previous editor
 * session/reload) is the overwhelmingly common occupant of this port, and
 * leaving it running would just make this new instance fail to bind — so it
 * is replaced. Anything that is NOT recognizably js-bridge-mcp is left alone
 * (this used to SIGKILL whatever was there, e.g. an unrelated dev server
 * that happened to pick the same port); --force-kill-port restores that.
 * SIGTERM first so the old instance can stop its stdio proxy children (see
 * the shutdown handler below), SIGKILL only if it doesn't exit. macOS/Linux
 * only — pidsOnPort finds nothing without lsof.
 */
async function freePortFromStaleInstance(port: number) {
  for (const pid of pidsOnPort(port)) {
    if (!forceKillPort && !(await isStaleJsBridgeInstance(port, pid))) {
      const command = commandOutput('ps', ['-p', String(pid), '-o', 'command=']) || 'unknown command';
      console.error(
        `[js-bridge-mcp] port ${port} is in use by process ${pid} (${command}), which does not look like js-bridge-mcp — not killing it. ` +
        `Stop it, set PORT to a free port, or pass --force-kill-port (or set JS_BRIDGE_MCP_FORCE_KILL_PORT=1) to kill it anyway.`
      );
      // Exit rather than try to listen: binding can still "succeed" next to a
      // listener on a narrower address (it on 127.0.0.1, this on every
      // interface), leaving two servers answering the same port.
      process.exit(1);
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      continue; // already gone
    }
    for (let i = 0; i < 20 && isAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* exited in between */ }
      for (let i = 0; i < 10 && isAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.error(`[js-bridge-mcp] stopped process ${pid} that was on port ${port}`);
  }
}
await freePortFromStaleInstance(PORT);

const getOrCreateTenant = (id: string) => getOrCreateTenantFor(id, undefined, { ...initialHelloState });

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
// proxy-ui/{admin,hub} are hand-written static HTML+JS, not compiled by tsc
// - copied into dist/proxy-ui by vite's copyClientExtras (vite.config.ts),
// same convention as tool-bus.js/connect.js, so they exist at this path
// whether run via tsx from src/ (dev) or from a published dist/ build.
const PROXY_UI_ROOT = path.join(packageRoot, __dirname.endsWith(`${path.sep}dist${path.sep}src`) ? 'dist/proxy-ui' : 'src/proxy-ui');
const ADMIN_UI_DIR = path.join(PROXY_UI_ROOT, 'admin');
const HUB_UI_DIR = path.join(PROXY_UI_ROOT, 'hub');
const CALLS_UI_DIR = path.join(PROXY_UI_ROOT, 'calls');
// Defaults to the home folder, not packageRoot: packageRoot varies with
// however this instance happens to be installed/run (npx cache dir, a
// reinstalled node_modules, a different checkout) and isn't guaranteed to
// persist or even be writable, so a packageRoot-relative path risked losing
// or forking proxy configs across runs. The home folder is stable and
// writable regardless of how/where js-bridge-mcp is invoked.
const PROXY_CONFIG_PATH = process.env.PROXY_CONFIG_PATH ?? path.join(os.homedir(), '.js-bridge-mcp-proxies.json');

const httpServer = createHttpServer({
  port: PORT,
  staticDir: DASHBOARD_DIR,
  initialSchema: undefined,
  initialValues: initialHelloState,
  identity: { name: IDENTITY_NAME, version: VERSION },
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
    '/admin': ADMIN_UI_DIR,
    '/hub': HUB_UI_DIR,
    '/calls': CALLS_UI_DIR,
  },
  // js-bridge-mcp typically bridges a single browser page per server; MCP
  // clients aren't expected to pin ?tenant= themselves (some, like VS Code
  // Copilot, open a fresh MCP session with no ?tenant= on every
  // reconnect/idle DELETE cycle). Sharing one root connection (named after
  // this server's identity, "js-bridge-mcp") keeps every such session
  // pointed at the same already-bridged browser tab instead of each
  // reconnect minting a new, empty tenant.
  defaultTenantMode: 'shared',
});

// Registered before attachWebSocketServer: ws forwards the http server's
// 'error' to its own emitter, which throws when nothing listens there —
// this one must run first to print a readable message.
httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[js-bridge-mcp] port ${PORT} is already in use — stop whatever holds it or set PORT to a free port`);
  } else {
    console.error(`[js-bridge-mcp] server error: ${err.message}`);
  }
  process.exit(1);
});

// Loopback-only unless --allow-remote: the socket is dropped before any HTTP
// or WebSocket handling, so nothing on the LAN can reach /mcp, /api/* or
// /ws. Enforced per-connection rather than by binding to 127.0.0.1 because
// "localhost" resolves to ::1 on some systems and 127.0.0.1 on others —
// listening on every interface and filtering here keeps both working for
// same-machine clients exactly as before.
httpServer.on('connection', (socket) => {
  if (!security.allowRemote && !isLoopbackAddress(socket.remoteAddress)) {
    console.error(`[js-bridge-mcp] refused connection from ${socket.remoteAddress} — pass --allow-remote (or set JS_BRIDGE_MCP_ALLOW_REMOTE=1) to accept non-local clients`);
    socket.destroy();
  }
});

attachWebSocketServer(httpServer, PORT, undefined, initialHelloState);
installProxyAdminRoutes(httpServer, PORT, security, { name: IDENTITY_NAME, version: VERSION });
initAdminChannel();
applyCallLogEnv();
if (persistPageTools) setDynamicToolStore(createFileDynamicToolStore(PAGE_TOOLS_PATH));
initProxyManager(PROXY_CONFIG_PATH, VERSION, { port: PORT });

// Closes upstream proxy clients before exiting, so stdio children (an `npx`
// MCP server per proxy) stop with this process instead of outliving it.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownProxyManager().finally(() => process.exit(0));
  });
}

httpServer.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.error(`[js-bridge-mcp] v${VERSION} — MCP + bridge server listening on ${url}`);
  console.error(`[js-bridge-mcp] dashboard: ${url}`);
  console.error(`[js-bridge-mcp] proxy admin: ${url}/admin`);
  console.error(`[js-bridge-mcp] proxy hub: ${url}/hub`);
  console.error(`[js-bridge-mcp] tool call log: ${url}/calls (keeps the last ${getToolCallLogConfig().limit} calls, ${Math.round(getToolCallLogConfig().ttlMs / 60_000)} min)`);
  console.error(
    persistPageTools
      ? `[js-bridge-mcp] page tools: persisted to ${PAGE_TOOLS_PATH} and registered again when the same page reconnects`
      : '[js-bridge-mcp] page tools: not persisted — pass --persist-page-tools (or set JS_BRIDGE_MCP_PERSIST_PAGE_TOOLS=1) to keep agent-registered page tools across reloads and restarts'
  );
  console.error(`[js-bridge-mcp] serve legacy-page/hello-world.html separately: npm run start:static`);
  console.error(
    security.allowRemote
      ? '[js-bridge-mcp] remote access: ON (--allow-remote) — any device that can reach this port can call /mcp and /api/*, including spawning processes via proxies'
      : '[js-bridge-mcp] remote access: off (this machine only) — pass --allow-remote (or set JS_BRIDGE_MCP_ALLOW_REMOTE=1) to accept other devices'
  );
  console.error(
    security.allowedOrigins.length
      ? `[js-bridge-mcp] extra web origins allowed to call /mcp and /api/*: ${security.allowedOrigins.join(', ')}`
      : '[js-bridge-mcp] web origins allowed to call /mcp and /api/*: localhost pages and browser extensions — pass --allow-origin <origin> (or set JS_BRIDGE_MCP_ALLOWED_ORIGINS) to add one; bridged pages (/ws, /main.js) need none'
  );
  if (!process.env.JS_BRIDGE_MCP_NO_OPEN) {
    open(url).catch(() => {
      console.error(`[js-bridge-mcp] could not auto-open browser — open ${url} manually`);
    });
  }
});

export { getOrCreateTenant, tenants, httpServer };
