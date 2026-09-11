import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockHttpUpstream } from './fixtures/mock-http-upstream.js';

// Distinct ports from manifest-driven-tools.test.ts (8907) and each other,
// so `npm test`'s glob (which runs every *.test.ts file, no isolation
// beyond separate processes-per-file) never collides.
const PORT = 8908;
const MOCK_HTTP_UPSTREAM_PORT = 8909;
const BASE_URL = `http://localhost:${PORT}`;
const STDIO_FIXTURE = fileURLToPath(new URL('./fixtures/mock-stdio-upstream.ts', import.meta.url));

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
    env: { ...process.env, PORT: String(PORT), PROXY_CONFIG_PATH: proxyConfigPath },
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
