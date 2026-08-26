import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOrCreateTenant } from './tenant.js';
import { buildMcpServer, type RegisterToolsFn, type McpServerIdentity } from './mcp.js';
import { handleDashboardRoutes } from './dashboard.js';

const UPLOAD_DIR = path.join(os.tmpdir(), 'mcp-form-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

const sessions = new Map<string, StreamableHTTPServerTransport>();

export interface CreateHttpServerOptions<TSchema, TValues> {
  port: number;
  staticDir: string;
  initialSchema: TSchema;
  initialValues: TValues;
  identity: McpServerIdentity;
  registerFn: RegisterToolsFn<TSchema, TValues>;
  /**
   * Which tenant an MCP session with no ?tenant= param on its server URL
   * lands on:
   *
   * - 'per-session' (default): a fresh randomUUID() tenant per session,
   *   same as every session getting its own isolated state — what
   *   mcp-form relies on so concurrent agents don't share form state
   *   (see tenant-isolation.test.ts).
   *
   * - 'shared': every unpinned session lands on the single 'default'
   *   tenant (same one the WS side and both packages' boot-time
   *   getOrCreateTenant('default') call already use for plain browser
   *   access). Appropriate when there's exactly one browser page bridged
   *   per server and MCP clients aren't expected to pin a tenant
   *   explicitly — some clients (observed with VS Code Copilot) open a
   *   brand-new MCP session on every reconnect/idle DELETE cycle with no
   *   ?tenant=, and under 'per-session' each such reconnect mints a new,
   *   empty tenant that orphans whatever browser tab was already bridged
   *   to the previous one.
   */
  defaultTenantMode?: 'per-session' | 'shared';
  /**
   * Extra static asset roots served ahead of `staticDir`, keyed by URL path
   * prefix. Two shapes:
   *  - A directory-style prefix (e.g. `{ '/dashboard': '.../dist/dashboard' }`)
   *    resolves requests under it relative to that directory, falling back
   *    to `index.html` for the bare prefix or a `/`-suffixed request — same
   *    convention as `staticDir`. Lets a consumer ship a second, independent
   *    static app (e.g. a monitoring dashboard) without colliding with
   *    `staticDir`'s own `index.html`.
   *  - A single-file prefix with an extension (e.g. `{ '/main.js': '.../dist/client' }`)
   *    serves exactly that one file (`dir/main.js`) for a request matching
   *    the prefix exactly — for a fixed-URL asset other pages already
   *    reference by that path regardless of what's mounted at `/`.
   */
  extraStaticMounts?: Record<string, string>;
}

export function createHttpServer<TSchema, TValues>({ port, staticDir, initialSchema, initialValues, identity, registerFn, defaultTenantMode = 'per-session', extraStaticMounts = {} }: CreateHttpServerOptions<TSchema, TValues>) {
  const getTenant = (id: string) => {
    const t = getOrCreateTenant(id, initialSchema, initialValues);
    t.touch();
    return t;
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (url.pathname === '/mcp') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'POST' && !sessionId) {
        // An MCP client that wants a stable identity across reconnects (its
        // own idle timeouts, extension host restarts, etc.) can always pin
        // one explicitly by including ?tenant=<id> on its configured server
        // URL — same convention the WS bridge already uses. Without that,
        // which tenant the session lands on depends on defaultTenantMode
        // (see CreateHttpServerOptions for the tradeoff).
        //
        // The MCP *session id* itself is always a fresh randomUUID() —
        // sessionIdGenerator must stay unique per transport (the `sessions`
        // map is keyed on it) so concurrent clients don't collide; only
        // which *tenant* the session operates on varies by mode.
        const requestedTenantId = url.searchParams.get('tenant');
        const tenantId = requestedTenantId || (defaultTenantMode === 'shared' ? 'default' : randomUUID());
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
            getOrCreateTenant(tenantId, initialSchema, initialValues);
            console.error(`[mcp] session opened: ${id} (tenant=${tenantId})`);
          },
        });
        transport.onclose = () => {
          // The transport closing only means this particular HTTP/SSE
          // connection ended — it does NOT mean the tenant (and any
          // browser tabs bridged to it over /ws) should be torn down.
          // Disposing here used to force-close every connected browser
          // tab the instant an MCP client reconnected/recycled its
          // connection, even though the tenant itself was still healthy.
          // Tenant disposal is now solely driven by the idle sweep (see
          // startIdleSweep) or an explicit DELETE (below), so a tenant —
          // and its live browser connections — survives MCP-side session
          // churn as long as it keeps seeing activity from either side.
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            console.error(`[mcp] session detached: ${transport.sessionId}`);
          }
        };
        const mcpInstance = buildMcpServer(identity, tenantId, getTenant, port, registerFn);
        await mcpInstance.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      if (sessionId && sessions.has(sessionId)) {
        if (req.method === 'DELETE') {
          // Mirrors transport.onclose above: a client-initiated DELETE ends
          // *this* MCP session, but some clients (observed with Copilot)
          // send it routinely between turns / on idle, not just on final
          // teardown. Disposing the tenant here used to force-close every
          // bridged browser tab and wipe its tool manifest on every such
          // DELETE, which surfaced to the agent as tools vanishing
          // ("Tool X not found") the moment it tried to call something
          // right after a DELETE-triggered reconnect cycle. Tenant
          // disposal is left to the idle sweep (see startIdleSweep) so
          // browser state survives MCP-side session churn from either
          // close path — the DELETE still reaches the transport below so
          // its own session bookkeeping (and transport.onclose, which
          // removes it from `sessions`) runs normally.
          console.error(`[mcp] session closing (explicit DELETE): ${sessionId}`);
        }
        await sessions.get(sessionId)!.handleRequest(req, res);
        return;
      }

      console.error(`[mcp] rejected ${req.method} for unknown session: ${sessionId ?? '(none)'}${url.searchParams.get('tenant') ? ` tenant=${url.searchParams.get('tenant')}` : ''}`);
      res.writeHead(404); res.end('Unknown session');
      return;
    }

    if (url.pathname.startsWith('/api/dashboard') && handleDashboardRoutes(req, res, port)) return;

    if (url.pathname === '/upload' && req.method === 'POST') {
      const contentType = req.headers['content-type'] ?? '';
      const boundaryMatch = contentType.match(/boundary=(.+)$/);
      if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }

      const boundary = Buffer.from('--' + boundaryMatch[1]);
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Find the filename from Content-Disposition header in the part
        const headerEnd = body.indexOf('\r\n\r\n');
        const headerSection = body.slice(0, headerEnd).toString();
        const nameMatch = headerSection.match(/filename="([^"]+)"/);
        const originalName = nameMatch ? nameMatch[1]! : 'upload';
        const ext = path.extname(originalName);
        const savedName = `${randomUUID()}${ext}`;
        const savedPath = path.join(UPLOAD_DIR, savedName);

        // Extract file bytes: after \r\n\r\n, before the closing boundary
        const fileStart = headerEnd + 4;
        const closingBoundary = Buffer.from('\r\n' + boundary.toString() + '--');
        let fileEnd = body.length;
        for (let i = fileStart; i <= body.length - closingBoundary.length; i++) {
          if (body.slice(i, i + closingBoundary.length).equals(closingBoundary)) {
            fileEnd = i;
            break;
          }
        }

        fs.writeFile(savedPath, body.slice(fileStart, fileEnd), (err) => {
          if (err) { res.writeHead(500); res.end('Write error'); return; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: savedPath, name: originalName }));
        });
      });
      return;
    }

    let pathname = url.pathname;
    if (pathname.startsWith('/t/')) {
      pathname = '/';
    }

    const mountEntry = Object.entries(extraStaticMounts).find(
      ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
    let filePath: string;
    if (mountEntry) {
      const [prefix, dir] = mountEntry;
      if (path.extname(prefix)) {
        // A prefix with a file extension (e.g. "/main.js") is a single-file
        // mount — `dir` is that file's parent directory, and any request
        // exactly matching `prefix` resolves straight to it, no index.html
        // fallback. Lets a consumer serve one fixed-URL asset (e.g. an
        // embed script referenced by other pages as "<server>/main.js")
        // from a build directory that also happens to hold other files.
        filePath = path.join(dir, path.basename(prefix));
      } else {
        const rest = pathname.slice(prefix.length);
        filePath = path.join(dir, rest === '' || rest === '/' ? '/index.html' : rest);
      }
    } else {
      filePath = path.join(staticDir, pathname === '/' ? '/index.html' : pathname);
    }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  });

  return httpServer;
}
