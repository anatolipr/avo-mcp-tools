// A streamableHttp MCP server behind OAuth, used as a fake "upstream" by
// features.test.ts: answers 401 until it is sent the bearer token its own
// /token endpoint issues, and serves just enough metadata for the MCP SDK's
// client flow (protected-resource discovery, authorization-server metadata,
// dynamic client registration, PKCE code exchange). The human "approve"
// step is skipped: the test calls js-bridge-mcp's /oauth/callback itself
// with GOOD_CODE, which is all this server's /token endpoint accepts.
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const GOOD_CODE = 'good-code';
const ACCESS_TOKEN = 'good-token';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

export async function startMockOAuthUpstream(port: number): Promise<{ close: () => Promise<void>; tokenRequests: URLSearchParams[] }> {
  const issuer = `http://localhost:${port}`;
  const tokenRequests: URLSearchParams[] = [];
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${issuer}/mcp`, authorization_servers: [issuer] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const metadata = JSON.parse(await readBody(req));
      return json(res, 201, { ...metadata, client_id: 'mock-client', client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      tokenRequests.push(form);
      if (form.get('grant_type') === 'authorization_code' && form.get('code') === GOOD_CODE && form.get('code_verifier')) {
        return json(res, 200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: 'mock-refresh' });
      }
      return json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
    }
    if (url.pathname === '/mcp') {
      if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"` });
        res.end();
        return;
      }
      const server = new McpServer({ name: 'mock-oauth-upstream', version: '0.0.1' });
      server.tool('whoami', 'Says who is calling', { greeting: z.string() }, async ({ greeting }) => ({
        content: [{ type: 'text', text: `${greeting}, authorized caller` }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  return {
    tokenRequests,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve()))),
  };
}
