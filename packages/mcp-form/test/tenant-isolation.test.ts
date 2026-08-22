import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';

const PORT = 8901;
const BASE_URL = `http://localhost:${PORT}`;
let serverProcess: ChildProcess;

function textOf(result: Record<string, unknown>): string {
  const content = result.content as Array<{ text: string }>;
  return content[0]!.text;
}

function requireSessionId(transport: StreamableHTTPClientTransport): string {
  const id = transport.sessionId;
  if (!id) throw new Error('expected transport to have a sessionId');
  return id;
}

before(async () => {
  serverProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  // Wait for the HTTP server to accept connections.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE_URL);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(() => {
  serverProcess.kill();
});

async function connectClient() {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE_URL));
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await transport.terminateSession();
    await originalClose();
  };
  return { client, transport };
}

async function closeSession(sessionId: string) {
  const response = await fetch(new URL('/mcp', BASE_URL), {
    method: 'DELETE',
    headers: { 'mcp-session-id': sessionId },
  });
  assert.equal(response.ok, true);
}

test('two MCP sessions get distinct session ids', async () => {
  const a = await connectClient();
  const b = await connectClient();

  assert.ok(a.transport.sessionId, 'session A should have a session id');
  assert.ok(b.transport.sessionId, 'session B should have a session id');
  assert.notEqual(a.transport.sessionId, b.transport.sessionId);

  await a.client.close();
  await b.client.close();
});

test('getOrCreateTenant returns independent tenants with isolated stores', async () => {
  const port = 8905;
  const previousPort = process.env.PORT;
  let importedServer: Server | undefined;
  process.env.PORT = String(port);

  try {
    const { getOrCreateTenant, httpServer } = await import('../src/server.js');
    importedServer = httpServer;
    const tenantA = getOrCreateTenant('unit-test-tenant-a');
    const tenantB = getOrCreateTenant('unit-test-tenant-b');

    assert.notEqual(tenantA, tenantB);
    assert.notEqual(tenantA.store, tenantB.store);

    tenantA.applyState({ title: '', fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }] }, { note: '' });
    tenantA.store.set('note', 'from A');

    tenantB.applyState({ title: '', fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }] }, { note: '' });
    tenantB.store.set('note', 'from B');

    assert.equal(tenantA.store.get('note'), 'from A');
    assert.equal(tenantB.store.get('note'), 'from B');
    assert.equal(getOrCreateTenant('unit-test-tenant-a'), tenantA, 'same id should return the same tenant instance');
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (importedServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        importedServer!.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
});

test('two MCP sessions have isolated field values', async () => {
  const a = await connectClient();
  const b = await connectClient();

  await a.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }], wait: false },
  });
  await b.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }], wait: false },
  });

  await a.client.callTool({ name: 'set_field', arguments: { field: 'note', value: 'from A' } });
  await b.client.callTool({ name: 'set_field', arguments: { field: 'note', value: 'from B' } });

  const aResult = await a.client.callTool({ name: 'get_field', arguments: { field: 'note' } });
  const bResult = await b.client.callTool({ name: 'get_field', arguments: { field: 'note' } });

  assert.equal(textOf(aResult), 'from A');
  assert.equal(textOf(bResult), 'from B');

  await a.client.close();
  await b.client.close();
});

test('get_form_url returns a tenant-scoped URL containing the session id', async () => {
  const a = await connectClient();
  const result = await a.client.callTool({ name: 'get_form_url', arguments: {} });
  assert.equal(textOf(result), `${BASE_URL}/t/${requireSessionId(a.transport)}`);
  await a.client.close();
});

test('disposing a tenant while define_form waits for submit resolves with an error', { timeout: 5000 }, async () => {
  const a = await connectClient();
  const waitPromise = a.client.callTool({
    name: 'define_form',
    arguments: {
      fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }],
      wait: true,
    },
  });

  await new Promise((r) => setTimeout(r, 200));
  await closeSession(requireSessionId(a.transport));

  const result = await waitPromise;
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: the session was closed while waiting for submit');
});

test('disposing a tenant while wait_for_submit waits resolves with an error', { timeout: 5000 }, async () => {
  const a = await connectClient();
  await a.client.callTool({
    name: 'define_form',
    arguments: {
      fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }],
      wait: false,
    },
  });

  const waitPromise = a.client.callTool({
    name: 'wait_for_submit',
    arguments: {},
  });

  await new Promise((r) => setTimeout(r, 200));
  await closeSession(requireSessionId(a.transport));

  const result = await waitPromise;
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: the session was closed while waiting for submit');
});

function connectWs(tenantId: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=${tenantId}`);
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

test('WebSocket broadcasts are scoped to the connecting tenant', async () => {
  const a = await connectClient();
  const b = await connectClient();

  await a.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }], wait: false },
  });
  await b.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }], wait: false },
  });

  const wsA = await connectWs(requireSessionId(a.transport));
  const wsB = await connectWs(requireSessionId(b.transport));

  await a.client.callTool({ name: 'set_field', arguments: { field: 'note', value: 'hello from A' } });
  await new Promise((r) => setTimeout(r, 200));

  const aUpdates = wsA.messages.filter((m) => m.type === 'update');
  const bUpdates = wsB.messages.filter((m) => m.type === 'update');
  assert.equal(aUpdates.length, 1);
  assert.equal(aUpdates[0].value, 'hello from A');
  assert.equal(bUpdates.length, 0, 'tenant B should not see tenant A\'s field updates');

  wsA.ws.close();
  wsB.ws.close();
  await a.client.close();
  await b.client.close();
});

test('GET /t/:tenantId serves the form page', async () => {
  const a = await connectClient();
  const res = await fetch(`${BASE_URL}/t/${requireSessionId(a.transport)}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<html/i);
  await a.client.close();
});

test('WebSocket connection with an unknown tenant id is rejected, not silently joined to default', { timeout: 5000 }, async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=this-tenant-does-not-exist`);
  const closeCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for the unknown-tenant WebSocket to close'));
    }, 1000);

    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on('error', reject);
  });

  assert.equal(closeCode, 4404);
});

test('mcp-form.ts reads the tenant id from the URL path and connects with it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/client/mcp-form.ts', import.meta.url),
    'utf-8',
  );

  assert.match(src, /location\.pathname\.startsWith\('\/t\/'\)/, 'expected client-side code to branch on /t/ URLs');
  assert.match(
    src,
    /location\.pathname\.slice\('\/t\/'\.length\)\.split\('\/'\)\[0\]/,
    'expected client-side code to extract the tenant id segment from the path',
  );
  assert.match(src, /encodeURIComponent\(tenantId\)/, 'expected client-side code to URL-encode the tenant id');
  assert.match(src, /event\.code === 4404/, 'expected client-side code to stop reconnecting on unknown tenants');
});

test('closing an MCP session disposes its tenant and closes its WebSocket clients', { timeout: 5000 }, async () => {
  const a = await connectClient();
  await a.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }], wait: false },
  });
  const tenantId = requireSessionId(a.transport);
  const wsA = await connectWs(tenantId);

  const closed = new Promise((resolve) => wsA.ws.on('close', resolve));
  await a.client.close();

  await closed;
  assert.equal(wsA.ws.readyState, WebSocket.CLOSED);
});

test('idle tenants are automatically disposed after a TTL, even without explicit session close', { timeout: 10000 }, async () => {
  const idlePort = 8906;
  const idleServerProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(idlePort),
      TENANT_IDLE_TIMEOUT_MS: '300',
      TENANT_SWEEP_INTERVAL_MS: '100',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    const idleBaseUrl = `http://localhost:${idlePort}`;
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(idleBaseUrl);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const transport = new StreamableHTTPClientTransport(new URL('/mcp', idleBaseUrl));
    const client = new Client({ name: 'idle-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const tenantId = transport.sessionId;

    const ws = new WebSocket(`ws://localhost:${idlePort}/ws?tenant=${tenantId}`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const closed = new Promise((resolve) => ws.on('close', resolve));
    await closed;
    assert.equal(ws.readyState, WebSocket.CLOSED);
  } finally {
    idleServerProcess.kill();
  }
});
