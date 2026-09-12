import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { getRootTenant } from 'mcp-tenant-lib';
import { addProxy, getProxyConfig, listProxies, pauseProxy, removeProxy, restartProxy, resumeProxy, updateProxy } from './proxy-manager.js';
import type { ProxyConfig } from './types.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * CRUD + pause/restart for proxy configs, mounted under /api/proxies. This
 * is js-bridge-mcp-specific (proxy-manager doesn't exist in mcp-tenant-lib's
 * other consumers, e.g. mcp-form), so unlike /api/dashboard it is NOT part
 * of the shared createHttpServer request handler — see server.ts for how
 * this gets spliced in ahead of it.
 */
export async function handleProxyAdminRoutes(req: IncomingMessage, res: ServerResponse, port: number): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (url.pathname === '/api/proxies' && req.method === 'GET') {
    sendJson(res, 200, listProxies());
    return true;
  }

  if (url.pathname === '/api/proxies' && req.method === 'POST') {
    let body: Omit<ProxyConfig, 'id' | 'paused'>;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return true;
    }
    if (!body.slug || !body.transport) {
      sendJson(res, 400, { ok: false, error: 'missing required field "slug" or "transport"' });
      return true;
    }
    const config = await addProxy(body);
    sendJson(res, 200, { ok: true, config });
    return true;
  }

  const idMatch = url.pathname.match(/^\/api\/proxies\/([^/]+)$/);
  if (idMatch && req.method === 'GET') {
    const config = getProxyConfig(decodeURIComponent(idMatch[1]!));
    if (!config) { sendJson(res, 404, { error: 'proxy not found' }); return true; }
    sendJson(res, 200, config);
    return true;
  }

  if (idMatch && req.method === 'PATCH') {
    let body: Omit<ProxyConfig, 'id'>;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return true;
    }
    if (!body.slug || !body.transport) {
      sendJson(res, 400, { ok: false, error: 'missing required field "slug" or "transport"' });
      return true;
    }
    const config = await updateProxy(decodeURIComponent(idMatch[1]!), body);
    if (!config) { sendJson(res, 404, { ok: false, error: 'proxy not found' }); return true; }
    sendJson(res, 200, { ok: true, config });
    return true;
  }

  if (idMatch && req.method === 'DELETE') {
    const ok = await removeProxy(decodeURIComponent(idMatch[1]!));
    sendJson(res, ok ? 200 : 404, { ok });
    return true;
  }

  const actionMatch = url.pathname.match(/^\/api\/proxies\/([^/]+)\/(pause|resume|restart)$/);
  if (actionMatch && req.method === 'POST') {
    const [, id, action] = actionMatch as unknown as [string, string, 'pause' | 'resume' | 'restart'];
    const fn = action === 'pause' ? pauseProxy : action === 'resume' ? resumeProxy : restartProxy;
    const ok = await fn(decodeURIComponent(id));
    sendJson(res, ok ? 200 : 404, { ok });
    return true;
  }

  // Hub-page support: a plain-HTTP view of one proxy's tool manifest, for a
  // browser page (not an MCP client) to merge into window.__mcpTools. Every
  // proxy is a root connection now (see proxy-manager.ts), always
  // single-connection, but its manifest is stored under the RAW upstream
  // tool names (translateTools stopped pre-baking "<slug>__" once the
  // universal always-prefix mechanism in manifest-tools.ts took over) — so
  // this route re-applies the same "<slug>__" prefix by hand to match what
  // a real MCP client's tools/list actually sees, rather than reading
  // manifest-tools.ts's buildDescribePayload/computeSlugs directly (not
  // part of mcp-tenant-lib's public export surface, and overkill for a
  // guaranteed-single-connection tenant).
  const manifestMatch = url.pathname.match(/^\/api\/proxies\/channel\/([^/]+)\/manifest$/);
  if (manifestMatch && req.method === 'GET') {
    const slug = decodeURIComponent(manifestMatch[1]!);
    const tenant = getRootTenant(slug);
    if (!tenant) { sendJson(res, 404, { error: 'proxy not found' }); return true; }
    const tools = tenant.toolManifest.map((t) => ({ ...t, name: `${slug}__${t.name}` }));
    sendJson(res, 200, { tools });
    return true;
  }

  // Hub-page support: lets a plain browser page (no MCP session, no
  // WebSocket) invoke one of a proxy's tools by its prefixed name (as
  // returned by the /manifest route above), forwarding through the exact
  // same Tenant.call(...) a real MCP tool call already goes through
  // server-side (see manifest-tools.ts's sync(), which closes over the
  // specific connectionId per manifest entry the same way). The manifest
  // stores tools under their RAW upstream name (see the /manifest route's
  // comment), so the "<slug>__" prefix is stripped back off here before
  // dispatching, mirroring proxy-manager.ts's own directCall handler.
  // connectionId must be resolved explicitly — Tenant.call's `undefined`
  // broadcast path only iterates wsClients, which a directCall-backed proxy
  // connection is never added to (see registerDirectConnection), so
  // `undefined` here would silently reach no one and time out.
  const callMatch = url.pathname.match(/^\/api\/proxies\/channel\/([^/]+)\/call\/([^/]+)$/);
  if (callMatch && req.method === 'POST') {
    const slug = decodeURIComponent(callMatch[1]!);
    const tenant = getRootTenant(slug);
    if (!tenant) { sendJson(res, 404, { error: 'proxy not found' }); return true; }
    const [connectionId] = tenant.connections.keys();
    if (!connectionId) { sendJson(res, 404, { error: 'proxy has no live connection' }); return true; }
    let args: unknown;
    try {
      args = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return true;
    }
    const prefixedName = decodeURIComponent(callMatch[2]!);
    const toolName = prefixedName.startsWith(`${slug}__`) ? prefixedName.slice(slug.length + 2) : prefixedName;
    try {
      const result = await tenant.call(connectionId, toolName, args);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      sendJson(res, 422, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  return false;
}

/**
 * Splices handleProxyAdminRoutes ahead of createHttpServer's own request
 * handler. Node fires 'request' listeners in registration order and always
 * invokes every one of them for the same req/res, so rather than adding a
 * second listener (which would run AFTER the shared handler and be unable to
 * pre-empt it), this removes the existing listener and re-adds it wrapped: a
 * proxy-admin route short-circuits before the shared handler ever runs;
 * anything else falls through unchanged.
 */
/**
 * mcp-tenant-lib's static file server (createHttpServer, shared with
 * mcp-form) has no SPA-style fallback: a directory mount only serves
 * index.html for the mount's exact root, and treats any subpath as a literal
 * file lookup that 404s if nothing exists there. /hub/:slug (see
 * hub/index.html's client-side routing) needs every such subpath to load the
 * same index.html, so rather than teach the shared library a new "SPA mode"
 * (which mcp-form has no need for), this rewrites the request's own url in
 * place before it ever reaches createHttpServer's handler — indistinguishable
 * from a request for "/hub" by the time it gets there.
 */
function rewriteHubSubpathToIndex(req: IncomingMessage, port: number): void {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (/^\/hub\/[^/]+$/.test(url.pathname)) req.url = '/hub';
}

export function installProxyAdminRoutes(httpServer: Server, port: number) {
  const [originalListener] = httpServer.listeners('request') as ((req: IncomingMessage, res: ServerResponse) => void)[];
  if (!originalListener) throw new Error('installProxyAdminRoutes: httpServer has no existing "request" listener to wrap');
  httpServer.removeAllListeners('request');
  httpServer.on('request', async (req, res) => {
    try {
      if (await handleProxyAdminRoutes(req, res, port)) return;
    } catch (err: any) {
      // addProxy/updateProxy throw on invalid input (e.g. a bad slug) rather
      // than returning a result — without this catch, that throw inside an
      // async 'request' listener becomes an unhandled rejection with no
      // listener anywhere in the chain, which Node treats as fatal and takes
      // the whole server down over one bad admin-UI submission.
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: err?.message ?? String(err) });
      return;
    }
    rewriteHubSubpathToIndex(req, port);
    originalListener(req, res);
  });
}
