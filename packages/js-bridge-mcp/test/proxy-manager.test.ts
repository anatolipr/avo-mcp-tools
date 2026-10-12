import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { startMockHttpUpstream } from './fixtures/mock-http-upstream.js';

// Distinct ports from manifest-driven-tools.test.ts (8907) and each other,
// so `npm test`'s glob (which runs every *.test.ts file, no isolation
// beyond separate processes-per-file) never collides.
const PORT = 8908;
const MOCK_HTTP_UPSTREAM_PORT = 8909;
const BASE_URL = `http://localhost:${PORT}`;
const STDIO_FIXTURE = fileURLToPath(new URL('./fixtures/mock-stdio-upstream.ts', import.meta.url));
const STDIO_FIXTURE_NESTED_PARAMS = fileURLToPath(new URL('./fixtures/mock-stdio-upstream-nested-params.ts', import.meta.url));
const STDIO_FIXTURE_RICH = fileURLToPath(new URL('./fixtures/mock-stdio-upstream-rich.ts', import.meta.url));

let serverProcess: ChildProcess;
let mockHttpUpstream: { close: () => Promise<void> };
// A private, per-run config file — without this, this test's spawned
// server would read/write the SAME .js-bridge-mcp-proxies.json every real
// dev run and every other test file's spawned server use (see server.ts's
// PROXY_CONFIG_PATH), leaking proxies across runs and racing concurrent
// test files.
const proxyConfigPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'js-bridge-mcp-proxy-test-')), 'proxies.json');

before(async () => {
  mockHttpUpstream = await startMockHttpUpstream(MOCK_HTTP_UPSTREAM_PORT);

  // Same detached-process-group handling as manifest-driven-tools.test.ts —
  // npx execs tsx as a grandchild, so killing just this pid would leak the
  // real server past the test run.
  serverProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), PROXY_CONFIG_PATH: proxyConfigPath, JS_BRIDGE_MCP_NO_OPEN: '1', TENANT_EMPTY_TIMEOUT_MS: '500', TENANT_EMPTY_SWEEP_INTERVAL_MS: '200' },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE_URL);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(async () => {
  if (serverProcess.pid) process.kill(-serverProcess.pid, 'SIGKILL');
  await mockHttpUpstream.close();
  fs.rmSync(path.dirname(proxyConfigPath), { recursive: true, force: true });
});

async function addProxy(body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
  const res = await fetch(`${BASE_URL}/api/proxies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const { ok, config, error } = await res.json();
  assert.ok(ok, `addProxy failed: ${error}`);
  return config;
}

async function waitForConnected(id: string, timeoutMs = 5000): Promise<{ connected: boolean; toolCount: number; lastError?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const proxies: any[] = await fetch(`${BASE_URL}/api/proxies`).then((r) => r.json());
    const p = proxies.find((p) => p.id === id);
    if (p?.connected) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`proxy "${id}" did not connect within ${timeoutMs}ms`);
}

async function connectMcpClient() {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE_URL));
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await transport.terminateSession();
    await originalClose();
  };
  return client;
}

test('a stdio proxy connects, discovers its tool with the slug prefix baked in, and is callable end-to-end via the real MCP session', async () => {
  const config = await addProxy({ slug: 'stdiofake', transport: 'stdio', command: 'npx', args: ['tsx', STDIO_FIXTURE] });
  const status = await waitForConnected(config.id);
  assert.equal(status.toolCount, 1);

  const client = await connectMcpClient();
  try {
    await client.callTool({ name: 'join_channel', arguments: { channel: 'stdiofake' } });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('stdiofake__get_tickets'), `expected stdiofake__get_tickets in ${JSON.stringify(names)}`);

    const result: any = await client.callTool({ name: 'stdiofake__get_tickets', arguments: { day: 'monday' } });
    assert.match(result.content[0].text, /tickets for monday/);
  } finally {
    await client.close();
    await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
  }
});

test('a tool with array-of-string and array-of-object params (e.g. server-filesystem\'s read_multiple_files/edit_file shape) registers and is callable end-to-end', async () => {
  const config = await addProxy({ slug: 'batchfake', transport: 'stdio', command: 'npx', args: ['tsx', STDIO_FIXTURE_NESTED_PARAMS] });
  const status = await waitForConnected(config.id);
  assert.equal(status.toolCount, 1);
  assert.deepEqual(status.skippedTools ?? [], []);

  const client = await connectMcpClient();
  try {
    await client.callTool({ name: 'join_channel', arguments: { channel: 'batchfake' } });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'batchfake__batch_tickets');
    assert.ok(tool, `expected batchfake__batch_tickets in ${JSON.stringify(tools.map((t) => t.name))}`);
    assert.equal((tool!.inputSchema as any).properties.ids.type, 'array');
    assert.equal((tool!.inputSchema as any).properties.edits.type, 'array');
    assert.equal((tool!.inputSchema as any).properties.edits.items.type, 'object');

    const result: any = await client.callTool({
      name: 'batchfake__batch_tickets',
      arguments: { ids: ['T-1', 'T-2'], edits: [{ field: 'status', value: 'closed' }] },
    });
    assert.match(result.content[0].text, /applied 1 edit\(s\) to \[T-1, T-2\]/);
  } finally {
    await client.close();
    await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
  }
});

test('an HTTP (streamableHttp) proxy connects and is callable via the hub-style HTTP call endpoint', async () => {
  const config = await addProxy({ slug: 'httpfake', transport: 'streamableHttp', url: `http://localhost:${MOCK_HTTP_UPSTREAM_PORT}` });
  const status = await waitForConnected(config.id);
  assert.equal(status.toolCount, 1);

  const manifestRes = await fetch(`${BASE_URL}/api/proxies/channel/httpfake/manifest`).then((r) => r.json());
  assert.equal(manifestRes.tools[0].name, 'httpfake__echo');

  const callRes = await fetch(`${BASE_URL}/api/proxies/channel/httpfake/call/httpfake__echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  }).then((r) => r.json());
  assert.equal(callRes.ok, true);
  assert.match(callRes.result.content[0].text, /echo: hi/);

  await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
});

test('pausing a proxy makes its tools vanish from the manifest; resuming brings them back', async () => {
  const config = await addProxy({ slug: 'pausefake', transport: 'stdio', command: 'npx', args: ['tsx', STDIO_FIXTURE] });
  await waitForConnected(config.id);

  await fetch(`${BASE_URL}/api/proxies/${config.id}/pause`, { method: 'POST' });
  const pausedManifest = await fetch(`${BASE_URL}/api/proxies/channel/pausefake/manifest`).then((r) => r.json());
  assert.deepEqual(pausedManifest.tools, []);

  await fetch(`${BASE_URL}/api/proxies/${config.id}/resume`, { method: 'POST' });
  await waitForConnected(config.id);
  const resumedManifest = await fetch(`${BASE_URL}/api/proxies/channel/pausefake/manifest`).then((r) => r.json());
  assert.equal(resumedManifest.tools.length, 1);

  await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
});

test('restarting a proxy mints a fresh connection id, so a call issued right before restart fails cleanly instead of hanging or silently retrying', async () => {
  const config = await addProxy({ slug: 'restartfake', transport: 'stdio', command: 'npx', args: ['tsx', STDIO_FIXTURE] });
  await waitForConnected(config.id);

  const callPromise = fetch(`${BASE_URL}/api/proxies/channel/restartfake/call/restartfake__get_tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day: 'tuesday' }),
  }).then((r) => r.json());

  await fetch(`${BASE_URL}/api/proxies/${config.id}/restart`, { method: 'POST' });

  const result = await callPromise;
  // Two failure shapes are both correct outcomes here, depending on exactly
  // when the admin-routes.ts handler resolves the channel's connection id
  // relative to restartProxy's removeConnection/re-registerDirectConnection:
  // either it resolves an id BEFORE the restart removes it (routes into
  // Tenant.call's reconnect-grace-then-reject path, {ok:false, error:
  // "...no longer connected"}), or AFTER (finds zero live connections
  // immediately, {error: "channel has no live connection"}). What actually
  // matters per the settled restart requirement — no hang, no silent retry,
  // a clear failure — holds either way; this only rules out success/hang.
  assert.notEqual(result.ok, true);
  assert.ok(
    /no longer connected/.test(result.error ?? '') || /no live connection/.test(result.error ?? ''),
    `expected a clear connection-gone error, got: ${JSON.stringify(result)}`,
  );

  await waitForConnected(config.id);
  await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
});

test('a stale config entry with an invalid slug (predating isValidChannelName enforcement) is not started, and surfaces its error via list_proxies instead of producing a silent, unjoinable channel', async () => {
  const invalidConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'js-bridge-mcp-proxy-test-invalid-'));
  const invalidConfigPath = path.join(invalidConfigDir, 'proxies.json');
  const invalidId = 'preexisting-invalid-slug-id';
  fs.writeFileSync(invalidConfigPath, JSON.stringify([
    { id: invalidId, slug: 'has spaces', transport: 'stdio', command: 'npx', args: ['tsx', STDIO_FIXTURE], paused: false },
  ]));

  const port = 8910;
  const invalidServer = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), PROXY_CONFIG_PATH: invalidConfigPath, JS_BRIDGE_MCP_NO_OPEN: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  });
  try {
    const base = `http://localhost:${port}`;
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(base);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const proxies: any[] = await fetch(`${base}/api/proxies`).then((r) => r.json());
    const entry = proxies.find((p) => p.id === invalidId);
    assert.ok(entry, 'expected the invalid-slug entry to still be listed');
    assert.equal(entry.connected, false);
    assert.equal(entry.toolCount, 0);
    assert.match(entry.lastError ?? '', /not a valid proxy slug/);

    // The point of the whole check: no channel exists under the raw slug, so
    // there's nothing for join_channel to ever find, unjoinable or not.
    const manifestRes = await fetch(`${base}/api/proxies/channel/${encodeURIComponent('has spaces')}/manifest`);
    assert.notEqual(manifestRes.status, 200);
  } finally {
    if (invalidServer.pid) process.kill(-invalidServer.pid, 'SIGKILL');
    fs.rmSync(invalidConfigDir, { recursive: true, force: true });
  }
});

test('PATCHing a proxy with an invalid slug returns a 400 JSON error instead of crashing the server (addProxy/updateProxy throw on invalid input, and the request handler must catch it)', async () => {
  const config = await addProxy({ slug: 'patchtargetfake', transport: 'stdio', command: 'npx', args: ['tsx', STDIO_FIXTURE] });
  await waitForConnected(config.id);

  const res = await fetch(`${BASE_URL}/api/proxies/${config.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'has spaces', transport: 'stdio', command: 'npx', args: ['tsx', STDIO_FIXTURE] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /not a valid proxy slug/);

  // The server process must still be alive and serving requests afterward.
  const stillUp = await fetch(BASE_URL);
  assert.ok(stillUp.ok || stillUp.status < 500, 'server did not survive the invalid PATCH');

  await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
});

test('list_proxies reflects current state (connected, paused, toolCount)', async () => {
  const config = await addProxy({ slug: 'listedfake', transport: 'stdio', command: 'npx', args: ['tsx', STDIO_FIXTURE] });
  await waitForConnected(config.id);

  const client = await connectMcpClient();
  try {
    const result: any = await client.callTool({ name: 'list_proxies', arguments: {} });
    const proxies = JSON.parse(result.content[0].text);
    const entry = proxies.find((p: any) => p.id === config.id);
    assert.ok(entry, 'list_proxies did not include the newly added proxy');
    assert.equal(entry.connected, true);
    assert.equal(entry.toolCount, 1);
  } finally {
    await client.close();
    await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
  }
});

test('a tool whose schema has an enum, a union and a free-form object is registered (not skipped) and callable with all three', async () => {
  const config = await addProxy({ slug: 'richfake', transport: 'stdio', command: 'npx', args: ['tsx', STDIO_FIXTURE_RICH] });
  const status: any = await waitForConnected(config.id);
  assert.equal(status.toolCount, 2);
  assert.deepEqual(status.skippedTools, []);

  const client = await connectMcpClient();
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'richfake__search');
    assert.ok(tool, `expected richfake__search in ${JSON.stringify(tools.map((t) => t.name))}`);
    const props = (tool!.inputSchema as any).properties;
    assert.deepEqual(props.mode.enum, ['fast', 'deep']);
    assert.match(props.filter.description, /id or name/);

    const result: any = await client.callTool({
      name: 'richfake__search',
      arguments: { mode: 'deep', filter: 7, meta: { nested: { ok: true } } },
    });
    // A proxied result arrives as the upstream's whole tool result, JSON-encoded.
    assert.equal(JSON.parse(result.content[0].text).content[0].text, 'search deep filter=7 meta={"nested":{"ok":true}}');

    const rejected: any = await client.callTool({ name: 'richfake__search', arguments: { mode: 'sideways' } }).catch((err) => ({ isError: true, content: [{ text: String(err) }] }));
    assert.equal(rejected.isError, true, 'a value outside the enum must be rejected');
  } finally {
    await client.close();
    await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
  }
});

test('a proxy whose upstream process dies is reported as disconnected, loses its tools, then reconnects on its own', async () => {
  const config = await addProxy({ slug: 'crashfake', transport: 'stdio', command: 'npx', args: ['tsx', STDIO_FIXTURE_RICH] });
  await waitForConnected(config.id);

  await fetch(`${BASE_URL}/api/proxies/channel/crashfake/call/crashfake__crash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  let sawDisconnected: any;
  for (let i = 0; i < 40 && !sawDisconnected; i++) {
    const proxies: any[] = await fetch(`${BASE_URL}/api/proxies`).then((r) => r.json());
    const p = proxies.find((p) => p.id === config.id);
    if (!p.connected) sawDisconnected = p;
    else await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(sawDisconnected, 'proxy never reported connected:false after its upstream exited');
  assert.match(sawDisconnected.lastError ?? '', /upstream connection closed/);
  assert.equal(sawDisconnected.toolCount, 0);

  const back = await waitForConnected(config.id, 8000);
  assert.equal(back.toolCount, 2);
  const manifest = await fetch(`${BASE_URL}/api/proxies/channel/crashfake/manifest`).then((r) => r.json());
  assert.equal(manifest.tools.length, 2);

  await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
});

test('a proxy config that could never start (stdio with no command, bad transport, non-http url) is rejected with 400 and not persisted', async () => {
  const before: any[] = await fetch(`${BASE_URL}/api/proxies`).then((r) => r.json());
  for (const body of [
    { slug: 'nocommand', transport: 'stdio' },
    { slug: 'badtransport', transport: 'carrier-pigeon', command: 'npx' },
    { slug: 'badurl', transport: 'sse', url: 'not a url' },
    { slug: 'badargs', transport: 'stdio', command: 'npx', args: 'tsx file.ts' },
  ]) {
    const res = await fetch(`${BASE_URL}/api/proxies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal((await res.json()).ok, false);
  }
  const after: any[] = await fetch(`${BASE_URL}/api/proxies`).then((r) => r.json());
  assert.equal(after.length, before.length);
  assert.ok(!fs.readFileSync(proxyConfigPath, 'utf-8').includes('nocommand'));
});

test('the proxy config file is written owner-only (it holds env/header secrets)', { skip: process.platform === 'win32' }, async () => {
  const config = await addProxy({ slug: 'modefake', transport: 'streamableHttp', url: `http://localhost:${MOCK_HTTP_UPSTREAM_PORT}` });
  assert.equal(fs.statSync(proxyConfigPath).mode & 0o777, 0o600);
  await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
});

test('admin__view_mcp_proxy returns the full config, and admin__edit_mcp_proxy keeps headers/timeout it was not given', async () => {
  const url = `http://localhost:${MOCK_HTTP_UPSTREAM_PORT}`;
  const client = await connectMcpClient();
  let id: string | undefined;
  try {
    const added: any = await client.callTool({
      name: 'admin__add_mcp_proxy',
      arguments: { slug: 'headerfake', transport: 'streamableHttp', url, headers: 'Authorization: Bearer a:b\nX-Team: core', timeoutSeconds: 90 },
    });
    assert.notEqual(added.isError, true, added.content?.[0]?.text);

    const viewed = JSON.parse(((await client.callTool({ name: 'admin__view_mcp_proxy', arguments: { slug: 'headerfake' } })) as any).content[0].text);
    id = viewed.id;
    assert.equal(viewed.url, url);
    assert.deepEqual(viewed.headers, { Authorization: 'Bearer a:b', 'X-Team': 'core' });
    assert.equal(viewed.callTimeoutMs, 90_000);
    assert.equal(viewed.connected, true, 'status fields must still be present alongside the config');

    await client.callTool({
      name: 'admin__edit_mcp_proxy',
      arguments: { slug: 'headerfake', newSlug: 'headerfake', transport: 'streamableHttp', url, description: 'edited' },
    });
    const afterEdit = await fetch(`${BASE_URL}/api/proxies/${id}`).then((r) => r.json());
    assert.equal(afterEdit.description, 'edited');
    assert.deepEqual(afterEdit.headers, { Authorization: 'Bearer a:b', 'X-Team': 'core' });
    assert.equal(afterEdit.callTimeoutMs, 90_000);

    await client.callTool({
      name: 'admin__edit_mcp_proxy',
      arguments: { slug: 'headerfake', newSlug: 'headerfake', transport: 'streamableHttp', url, headers: '', timeoutSeconds: 0 },
    });
    const cleared = await fetch(`${BASE_URL}/api/proxies/${id}`).then((r) => r.json());
    assert.equal(cleared.headers, undefined);
    assert.equal(cleared.callTimeoutMs, undefined);
  } finally {
    await client.close();
    if (id) await fetch(`${BASE_URL}/api/proxies/${id}`, { method: 'DELETE' });
  }
});

test('a paused proxy whose empty root tenant has been swept still answers its manifest route with no tools, not a 404', async () => {
  const config = await addProxy({ slug: 'sweptfake', transport: 'streamableHttp', url: `http://localhost:${MOCK_HTTP_UPSTREAM_PORT}` });
  await waitForConnected(config.id);
  await fetch(`${BASE_URL}/api/proxies/${config.id}/pause`, { method: 'POST' });
  // TENANT_EMPTY_TIMEOUT_MS / _SWEEP_INTERVAL_MS are shortened for this server (see before()).
  await new Promise((r) => setTimeout(r, 1500));
  const res = await fetch(`${BASE_URL}/api/proxies/channel/sweptfake/manifest`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).tools, []);
  const unknown = await fetch(`${BASE_URL}/api/proxies/channel/neverconfigured/manifest`);
  assert.equal(unknown.status, 404);
  await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
});

function rawRequest(options: http.RequestOptions, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a web page on a foreign origin cannot add a proxy, call a proxied tool, or open an MCP session', async () => {
  const evil = { Origin: 'https://evil.example' };
  const stdioBody = JSON.stringify({ slug: 'pwned', transport: 'stdio', command: 'touch', args: ['/tmp/pwned'] });

  // The exact shape of the attack: a no-cors "simple request", so no preflight.
  const add = await fetch(`${BASE_URL}/api/proxies`, { method: 'POST', headers: { ...evil, 'Content-Type': 'text/plain' }, body: stdioBody });
  assert.equal(add.status, 403);
  const proxies: any[] = await fetch(`${BASE_URL}/api/proxies`).then((r) => r.json());
  assert.ok(!proxies.some((p) => p.slug === 'pwned'));

  const call = await fetch(`${BASE_URL}/api/proxies/channel/admin/call/admin__list_mcp_proxies`, { method: 'POST', headers: { ...evil, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(call.status, 403);

  const preflight = await fetch(`${BASE_URL}/mcp`, { method: 'OPTIONS', headers: { ...evil, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 403);
  const mcp = await fetch(`${BASE_URL}/mcp`, { method: 'POST', headers: { ...evil, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(mcp.status, 403);

  assert.equal((await fetch(`${BASE_URL}/api/dashboard`, { headers: evil })).status, 403);
  assert.equal((await fetch(`${BASE_URL}/api/proxies`, { headers: { Origin: 'null' } })).status, 403);
});

test('a DNS-rebinding request (loopback socket, foreign Host header) is rejected', async () => {
  const res = await rawRequest({ path: '/api/proxies', method: 'GET', headers: { Host: `evil.example:${PORT}` } });
  assert.equal(res.status, 403);
  assert.match(res.body, /--allow-remote/);
});

test('everything that worked before still works: no Origin, a localhost page, a browser extension, 127.0.0.1 and [::1] hosts', async () => {
  assert.equal((await fetch(`${BASE_URL}/api/proxies`)).status, 200);
  assert.equal((await fetch(`${BASE_URL}/api/proxies`, { headers: { Origin: 'http://localhost:5173' } })).status, 200);
  assert.equal((await fetch(`${BASE_URL}/api/proxies`, { headers: { Origin: `http://127.0.0.1:${PORT}` } })).status, 200);
  assert.equal((await fetch(`${BASE_URL}/api/dashboard`, { headers: { Origin: 'chrome-extension://abcdefghijklmnop' } })).status, 200);
  assert.equal((await rawRequest({ path: '/api/proxies', method: 'GET', headers: { Host: `127.0.0.1:${PORT}` } })).status, 200);
  assert.equal((await rawRequest({ path: '/api/proxies', method: 'GET', headers: { Host: `[::1]:${PORT}` } })).status, 200);

  const preflight = await fetch(`${BASE_URL}/mcp`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);

  const identity = await fetch(`${BASE_URL}/api/identity`).then((r) => r.json());
  assert.equal(identity.name, 'js-bridge-mcp');
  assert.match(identity.version, /^\d+\.\d+\.\d+/);
});

test('a page on any origin can still bridge in: the WebSocket and the static bridge assets are not origin-restricted', async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=foreignpage`, { origin: 'https://some-hosted-app.example' });
  const init: any = await new Promise((resolve, reject) => {
    ws.on('message', (raw) => resolve(JSON.parse(raw.toString())));
    ws.on('error', reject);
  });
  assert.equal(init.type, 'init');
  assert.equal(init.resolvedName, 'foreignpage');
  ws.close();

  for (const asset of ['/connect.js', '/tool-bus.js', '/main.js', '/']) {
    const res = await fetch(`${BASE_URL}${asset}`, { headers: { Origin: 'https://some-hosted-app.example' } });
    assert.notEqual(res.status, 403, `${asset} must stay reachable from any origin`);
  }
});
