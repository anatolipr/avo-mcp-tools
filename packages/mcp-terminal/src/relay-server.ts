#!/usr/bin/env node
// Human-relay front end: serves one local page whose window.__mcpTools/
// __mcpSummary are populated from the SAME ToolRegistry the MCP stdio server
// uses, then dynamically imports the human-mcp-relay popup (relay.js) from
// wherever it's hosted (default: htmlpaint.com's copy, override with
// --relay-url or a local path) - the exact same <human-mcp-relay> component
// htmlpaint.com/mindfoo use, unmodified, since it's already host-agnostic
// (reads window.__mcpTools/__mcpSummary, no host-app-specific code).
//
// Unlike js-bridge-mcp this never leaves the local machine and only ever
// serves ONE page to ONE browser tab for ONE local user, so none of that
// package's multi-tenant/WebSocket-tenant-id/prefixing machinery is needed -
// a single unauthenticated localhost WS connection is enough.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import open from 'open';
import { ToolRegistry } from './tools/registry.js';
import { parseArgs } from './cli-args.js';

async function main() {
  let args = parseArgs(process.argv.slice(2));
  let registry = new ToolRegistry({ sandboxRoot: args.sandboxRoot, allowExec: args.allowExec });

  let server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage(args.relayUrl, args.port));
      return;
    }
    if (req.url === '/client.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(renderClientScript(args.port));
      return;
    }
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        summary: registry.summary,
        tools: registry.tools.map(({ fn, ...rest }) => rest),
      }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  let wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => handleConnection(ws, registry));

  server.listen(args.port, async () => {
    let url = `http://localhost:${args.port}`;
    console.error(`[mcp-terminal] relay page: ${url}`);
    console.error(`[mcp-terminal] sandbox root: ${registry.sandbox.root}`);
    console.error(`[mcp-terminal] run_command: ${args.allowExec ? 'ENABLED' : 'disabled (pass --allow-exec to enable)'}`);
    console.error(`[mcp-terminal] relay popup loaded from: ${args.relayUrl}`);
    if (!args.noOpen) {
      await open(url).catch(() => {
        console.error(`[mcp-terminal] could not auto-open a browser - open ${url} manually.`);
      });
    }
  });
}

function handleConnection(ws: WebSocket, registry: ToolRegistry) {
  ws.on('message', async (raw) => {
    let msg: { id: number; tool: string; args: Record<string, unknown> };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // malformed frame, ignore
    }
    try {
      let data = await registry.call(msg.tool, msg.args || {});
      ws.send(JSON.stringify({ id: msg.id, ok: true, data }));
    } catch (e) {
      let error = e instanceof Error ? e.message : String(e);
      ws.send(JSON.stringify({ id: msg.id, ok: false, error }));
    }
  });
}

// The manifest sent to the browser is the same tool list as the MCP server's,
// minus `fn` (which never leaves Node - see BRIDGING.md's contract in
// js-bridge-mcp's README) - the client script below re-attaches an `fn` that
// round-trips the call over the WebSocket instead.
function renderPage(relayUrl: string, port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>mcp-terminal</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #111; color: #ddd; margin: 0; padding: 40px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .status { color: #6bcf6b; font-size: 13px; margin-bottom: 24px; }
  .status.disconnected { color: #ff6b6b; }
  code { background: #222; padding: 2px 6px; border-radius: 4px; }
  .hint { color: #888; font-size: 13px; margin-top: 24px; }
</style>
</head>
<body>
  <h1>mcp-terminal</h1>
  <div class="status" id="status">connecting...</div>
  <div class="hint">Press <code>Cmd/Ctrl+Shift+A</code> to open the relay popup once connected, then follow the primer instructions with your agent chat.</div>
  <script type="module">
    import './client.js';
    import(${JSON.stringify(relayUrl)});
  </script>
</body>
</html>`;
}

function renderClientScript(port: number): string {
  // Plain string (not a template literal file) so this stays a single
  // dependency-free file the http server can render inline - mirrors
  // js-bridge-mcp's dist/client/main.js role, just far simpler since there's
  // no tenant id / cross-origin concern for a same-origin localhost page.
  return `
let ws = new WebSocket('ws://localhost:${port}/ws');
let nextId = 1;
let pending = new Map();
let statusEl = document.getElementById('status');

ws.addEventListener('open', () => {
  statusEl.textContent = 'connected to mcp-terminal (localhost:${port})';
  statusEl.classList.remove('disconnected');
});
ws.addEventListener('close', () => {
  statusEl.textContent = 'disconnected - restart mcp-terminal and reload this page';
  statusEl.classList.add('disconnected');
});
ws.addEventListener('message', (event) => {
  let msg = JSON.parse(event.data);
  let resolver = pending.get(msg.id);
  if (!resolver) return;
  pending.delete(msg.id);
  if (msg.ok) resolver.resolve(msg.data);
  else resolver.reject(new Error(msg.error));
});

function callTool(name, args) {
  return new Promise((resolve, reject) => {
    let id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, tool: name, args }));
  });
}

async function loadManifest() {
  let res = await fetch('/manifest.json');
  let { tools, summary } = await res.json();
  window.__mcpSummary = summary;
  window.__mcpTools = tools.map((t) => ({
    ...t,
    fn: (args) => callTool(t.name, args),
  }));
}

loadManifest();
`;
}

main().catch((err) => {
  console.error('[mcp-terminal] fatal:', err);
  process.exit(1);
});
