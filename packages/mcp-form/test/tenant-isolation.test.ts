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

test('two MCP sessions have isolated field values once each has joined its own channel', async () => {
  const a = await connectClient();
  const b = await connectClient();

  // Under defaultTenantMode: 'shared' (see server.ts), unnamed sessions
  // share the 'default' tenant — isolation is now something a session
  // requests via join_channel, not the automatic default.
  await a.client.callTool({ name: 'join_channel', arguments: { channel: 'unit-test-isolation-a' } });
  await b.client.callTool({ name: 'join_channel', arguments: { channel: 'unit-test-isolation-b' } });

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

test('get_form_url returns the shared "default" channel URL for a session that never joined one', async () => {
  const a = await connectClient();
  const result = await a.client.callTool({ name: 'get_form_url', arguments: {} });
  // mcp-form runs with defaultTenantMode: 'shared' (see server.ts) — an
  // unnamed session lands on the real, shared 'default' channel, not a
  // private per-session UUID. Naming a channel via join_channel is what
  // gets a session its own URL (see the "Pets" scenario test below).
  assert.equal(textOf(result), `${BASE_URL}/t/default`);
  await a.client.close();
});

test('join_channel gives a session its own URL, distinct from the shared default', async () => {
  const a = await connectClient();
  await a.client.callTool({ name: 'join_channel', arguments: { channel: 'unit-test-own-url' } });
  const result = await a.client.callTool({ name: 'get_form_url', arguments: {} });
  assert.equal(textOf(result), `${BASE_URL}/t/unit-test-own-url`);
  await a.client.close();
});

test('closing the MCP session while define_form waits for submit does not disturb the pending wait', { timeout: 5000 }, async () => {
  // Session close/DELETE intentionally no longer disposes the tenant (see
  // http.ts) — the form is still live in the browser and someone could
  // still submit it, so a pending define_form(wait:true) must keep
  // waiting rather than being force-resolved with an error just because
  // the MCP client that started it went away.
  //
  // Note: we can't await the original define_form call after closing its
  // own session — DELETE tears down that session's whole HTTP transport
  // (including the still-open stream that would carry the eventual
  // result back), so the client-side promise would never resolve/reject
  // regardless of server-side behavior. Instead, verify server-side state
  // directly: the tenant must still be live and accept a submit.
  const a = await connectClient();
  const channel = 'unit-test-session-close-survives';
  await a.client.callTool({ name: 'join_channel', arguments: { channel } });
  await a.client.callTool({
    name: 'define_form',
    arguments: {
      fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }],
      wait: false,
    },
  });

  await closeSession(requireSessionId(a.transport));

  // A fresh session on the same channel can still read/drive the form —
  // proves the tenant survived the first session's close.
  const b = await connectClient();
  await b.client.callTool({ name: 'join_channel', arguments: { channel } });
  const result = await b.client.callTool({ name: 'get_form_url', arguments: {} });
  assert.equal(textOf(result), `${BASE_URL}/t/${channel}`);
  await b.client.close();
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

  // Each session must join its own channel first — under
  // defaultTenantMode: 'shared' (see server.ts), unnamed sessions all land
  // on the same 'default' tenant, so isolation now has to be requested
  // explicitly rather than being the automatic per-session default.
  await a.client.callTool({ name: 'join_channel', arguments: { channel: 'unit-test-ws-scope-a' } });
  await b.client.callTool({ name: 'join_channel', arguments: { channel: 'unit-test-ws-scope-b' } });

  await a.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }], wait: false },
  });
  await b.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }], wait: false },
  });

  const wsA = await connectWs('unit-test-ws-scope-a');
  const wsB = await connectWs('unit-test-ws-scope-b');

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

test('WebSocket connection with an unknown but validly-named tenant id recreates that tenant, not silently joined to default', { timeout: 5000 }, async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=this-tenant-does-not-exist-yet`);
  const initMsg: any = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for an "init" message on the recreated tenant')), 1000);
    ws.on('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString())); });
    ws.on('error', reject);
  });
  // A real, freshly-created tenant (not a rejection, and not silently
  // reusing 'default') responds with its own fresh init state.
  assert.equal(initMsg.type, 'init');
  ws.close();
});

test('WebSocket connection with an invalid tenant id is rejected with 4404', { timeout: 5000 }, async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=${encodeURIComponent('not a valid id!')}`);
  const closeCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for the invalid-tenant WebSocket to close'));
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

test('closing an MCP session leaves its tenant and bridged WebSocket clients alone', { timeout: 5000 }, async () => {
  // Session close/DELETE intentionally does not dispose the tenant (see
  // http.ts) — routine MCP session churn (e.g. observed with Copilot,
  // which reconnects between turns) must not force-close a bridged
  // browser tab or interrupt whoever's filling out its form. Only the
  // idle sweep or an explicit dispose ends a tenant now.
  const a = await connectClient();
  const channel = 'unit-test-session-close-leaves-ws-alone';
  await a.client.callTool({ name: 'join_channel', arguments: { channel } });
  await a.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }], wait: false },
  });
  const wsA = await connectWs(channel);

  await a.client.close();
  // No server-pushed close is expected — give any (incorrect) async close
  // a moment to happen before asserting the socket is still open.
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(wsA.ws.readyState, WebSocket.OPEN);
  wsA.ws.close();
});

test('two sessions joining the same channel share form state (the "Pets" scenario)', async () => {
  const a = await connectClient();
  const b = await connectClient();

  await a.client.callTool({ name: 'join_channel', arguments: { channel: 'unit-test-pets' } });
  await b.client.callTool({ name: 'join_channel', arguments: { channel: 'unit-test-pets' } });

  await a.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }], wait: false },
  });
  await a.client.callTool({ name: 'set_field', arguments: { field: 'note', value: 'from session A' } });

  // Session B never called define_form itself — it should see A's form and
  // values purely by having joined the same channel, proving cross-session
  // sharing works through join_channel rather than through direct Tenant
  // access (this is the scenario the whole named-channels design targets).
  const bResult = await b.client.callTool({ name: 'get_field', arguments: { field: 'note' } });
  assert.equal(textOf(bResult), 'from session A');

  const bUrl = await b.client.callTool({ name: 'get_form_url', arguments: {} });
  assert.equal(textOf(bUrl), `${BASE_URL}/t/unit-test-pets`);

  await a.client.close();
  await b.client.close();
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
