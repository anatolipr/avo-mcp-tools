import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOrCreateTenant, tenants } from './tenant.js';
import { buildMcpServer, type RegisterToolsFn, type McpServerIdentity } from './mcp.js';

const UPLOAD_DIR = path.join(os.tmpdir(), 'mcp-form-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const sessions = new Map<string, StreamableHTTPServerTransport>();

export interface CreateHttpServerOptions<TSchema, TValues> {
  port: number;
  staticDir: string;
  initialSchema: TSchema;
  initialValues: TValues;
  identity: McpServerIdentity;
  registerFn: RegisterToolsFn<TSchema, TValues>;
}

export function createHttpServer<TSchema, TValues>({ port, staticDir, initialSchema, initialValues, identity, registerFn }: CreateHttpServerOptions<TSchema, TValues>) {
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
        const tenantId = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => tenantId,
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
            getOrCreateTenant(id, initialSchema, initialValues);
            console.error(`[mcp] session opened: ${id}`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            tenants.get(transport.sessionId)?.dispose();
            tenants.delete(transport.sessionId);
            console.error(`[mcp] session closed: ${transport.sessionId}`);
          }
        };
        const mcpInstance = buildMcpServer(identity, tenantId, getTenant, port, registerFn);
        await mcpInstance.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      if (sessionId && sessions.has(sessionId)) {
        if (req.method === 'DELETE') {
          tenants.get(sessionId)?.dispose();
          tenants.delete(sessionId);
          await new Promise((resolve) => setImmediate(resolve));
        }
        await sessions.get(sessionId)!.handleRequest(req, res);
        return;
      }

      res.writeHead(404); res.end('Unknown session');
      return;
    }

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

    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(staticDir, filePath);

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  });

  return httpServer;
}
