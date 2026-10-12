import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { startMockOAuthUpstream, GOOD_CODE } from './fixtures/mock-oauth-upstream.js';

// Result passthrough, annotations, progress + cancellation, lazy proxies,
// OAuth proxies, the tool call log and persisted page tools — everything
// here needs a real server, a real MCP session and a real upstream.
// Ports distinct from the other test files (8907, 8908, 8909, and 8910 for proxy-manager's second server).
const PORT = 8912;
const OAUTH_UPSTREAM_PORT = 8913;
const BASE_URL = `http://localhost:${PORT}`;
const FEATURES_FIXTURE = fileURLToPath(new URL('./fixtures/mock-stdio-upstream-features.ts', import.meta.url));
const RICH_FIXTURE = fileURLToPath(new URL('./fixtures/mock-stdio-upstream-rich.ts', import.meta.url));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'js-bridge-mcp-features-test-'));
const proxyConfigPath = path.join(tmpDir, 'proxies.json');
const oauthStorePath = path.join(tmpDir, 'proxies-oauth.json');
const pageToolsPath = path.join(tmpDir, 'page-tools.json');

let serverProcess: ChildProcess;
let oauthUpstream: Awaited<ReturnType<typeof startMockOAuthUpstream>>;

before(async () => {
  oauthUpstream = await startMockOAuthUpstream(OAUTH_UPSTREAM_PORT);
  serverProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT),
      PROXY_CONFIG_PATH: proxyConfigPath,
      PAGE_TOOLS_PATH: pageToolsPath,
      JS_BRIDGE_MCP_PERSIST_PAGE_TOOLS: '1',
      JS_BRIDGE_MCP_CALL_LOG_LIMIT: '300',
      JS_BRIDGE_MCP_NO_OPEN: '1',
      TENANT_EMPTY_TIMEOUT_MS: '300',
      TENANT_EMPTY_SWEEP_INTERVAL_MS: '100',
    },
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
  await oauthUpstream.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(pathname: string, init?: RequestInit): Promise<any> {
  return fetch(`${BASE_URL}${pathname}`, init).then((r) => r.json());
}

async function addProxy(body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
  const { ok, config, error } = await api('/api/proxies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(ok, `addProxy failed: ${error}`);
  return config;
}

async function proxyStatus(id: string): Promise<any> {
  return (await api('/api/proxies')).find((p: any) => p.id === id);
}

async function waitForConnected(id: string, timeoutMs = 8000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await proxyStatus(id);
    if (status?.connected) return status;
    await sleep(100);
  }
  throw new Error(`proxy "${id}" did not connect within ${timeoutMs}ms: ${JSON.stringify(await proxyStatus(id))}`);
}

async function connectMcpClient(name = 'test-client') {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE_URL));
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const close = async () => {
    await transport.terminateSession();
    await client.close();
  };
  return { client, sessionId: transport.sessionId!, close };
}

async function waitForTool(client: Client, name: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name);
    if (tool) return tool;
    await sleep(50);
  }
  throw new Error(`tool "${name}" did not appear in tools/list within ${timeoutMs}ms`);
}

/**
 * A fake bridged page: a root connection named `name` that registers
 * `tools`, and answers the register/unregister calls the way main.ts does —
 * by re-sending its manifest with the dynamic tool added or removed.
 */
async function connectPage(name: string, hostTools: any[], onCall?: (msg: any, ws: WebSocket) => void) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=${name}`);
  const received: any[] = [];
  let dynamic: any[] = [];
  const sendManifest = () => ws.send(JSON.stringify({ type: 'register_tools', tools: [...hostTools, ...dynamic], appLabel: name }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    if (msg.type !== 'call') return;
    if (msg.name === '__register_tool_by_code__') {
      dynamic.push({ name: msg.args.name, description: msg.args.description, params: msg.args.params ?? {}, source: 'dynamic', origin: { kind: 'code', code: msg.args.code } });
      ws.send(JSON.stringify({ type: 'call_result', id: msg.id, result: `registered "${msg.args.name}" from code` }));
      sendManifest();
    } else if (msg.name === '__unregister_tool__') {
      dynamic = dynamic.filter((t) => t.name !== msg.args.toolName);
      ws.send(JSON.stringify({ type: 'call_result', id: msg.id, result: `unregistered "${msg.args.toolName}"` }));
      sendManifest();
    } else {
      onCall?.(msg, ws);
    }
  });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  sendManifest();
  return { ws, received };
}

async function connectionIdFor(client: Client, toolPrefix: string): Promise<string> {
  const result: any = await client.callTool({ name: 'describe_tools', arguments: {} });
  const conn = JSON.parse(result.content[0].text).connections.find((c: any) => c.toolPrefix === toolPrefix);
  assert.ok(conn, `no connection with prefix "${toolPrefix}"`);
  return conn.id;
}

// ---- result passthrough, annotations, progress, cancellation (through a proxy) ----

test('a proxied tool keeps its isError flag, its image content and its annotations', async () => {
  const config = await addProxy({ slug: 'feat', transport: 'stdio', command: 'npx', args: ['tsx', FEATURES_FIXTURE] });
  await waitForConnected(config.id);
  const { client, close } = await connectMcpClient();
  try {
    const readTool = await waitForTool(client, 'feat__read_thing');
    assert.equal(readTool.annotations?.readOnlyHint, true);
    assert.equal(readTool.annotations?.title, 'Read thing');
    assert.equal((await waitForTool(client, 'feat__fail')).annotations?.readOnlyHint, undefined);

    const failed: any = await client.callTool({ name: 'feat__fail', arguments: {} });
    assert.equal(failed.isError, true, 'an upstream error must not arrive as a success');
    assert.equal(failed.content[0].text, 'upstream says no');

    const image: any = await client.callTool({ name: 'feat__image', arguments: {} });
    assert.deepEqual(image.content[0], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  } finally {
    await close();
  }
});

test('progress from a proxied tool reaches the MCP client, and a client cancel reaches the upstream', async () => {
  const { client, close } = await connectMcpClient();
  try {
    await waitForTool(client, 'feat__slow');
    const progress: any[] = [];
    const done: any = await client.callTool({ name: 'feat__slow', arguments: { ms: 20 } }, undefined, { onprogress: (p) => progress.push(p) });
    assert.equal(done.content[0].text, 'slow done');
    assert.deepEqual(progress.map((p) => [p.progress, p.total, p.message]), [[1, 2, 'halfway']]);

    assert.equal(((await client.callTool({ name: 'feat__was_cancelled', arguments: {} })) as any).content[0].text, 'false');
    const controller = new AbortController();
    const pending = client.callTool({ name: 'feat__slow', arguments: { ms: 20_000 } }, undefined, { signal: controller.signal });
    await sleep(300);
    controller.abort();
    await assert.rejects(pending);
    let cancelled = 'false';
    for (let i = 0; i < 30 && cancelled !== 'true'; i++) {
      await sleep(100);
      cancelled = ((await client.callTool({ name: 'feat__was_cancelled', arguments: {} })) as any).content[0].text;
    }
    assert.equal(cancelled, 'true', 'the upstream must be told the call was cancelled');
  } finally {
    await close();
  }
});

// ---- the same, for a bridged page ----

test('a page tool can declare annotations, report progress, return an image, and is told when its call is cancelled', async () => {
  const page = await connectPage('featpage', [
    { name: 'work', description: 'works', params: {}, annotations: { readOnlyHint: true } },
    { name: 'shot', description: 'screenshot', params: {} },
  ], (msg, ws) => {
    if (msg.name === 'shot') {
      ws.send(JSON.stringify({ type: 'call_result', id: msg.id, result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] } }));
    } // `work` never answers: the test cancels it
  });
  const { client, close } = await connectMcpClient();
  try {
    assert.equal((await waitForTool(client, 'featpage__work')).annotations?.readOnlyHint, true);

    const shot: any = await client.callTool({ name: 'featpage__shot', arguments: {} });
    assert.deepEqual(shot.content[0], { type: 'image', data: 'AAAA', mimeType: 'image/png' });

    const progress: any[] = [];
    // A second page whose tool does answer, after one progress report.
    const finishing = await connectPage('featpage2', [{ name: 'work', description: 'works', params: { finish: { type: 'boolean' } } }], (msg, ws) => {
      ws.send(JSON.stringify({ type: 'call_progress', id: msg.id, progress: 2, total: 4, message: 'half' }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'call_result', id: msg.id, result: 'worked' })), 50);
    });
    await waitForTool(client, 'featpage2__work');
    const done: any = await client.callTool({ name: 'featpage2__work', arguments: { finish: true } }, undefined, { onprogress: (p) => progress.push(p) });
    assert.equal(done.content[0].text, 'worked');
    assert.deepEqual(progress.map((p) => [p.progress, p.total, p.message]), [[2, 4, 'half']]);
    finishing.ws.close();

    const controller = new AbortController();
    const pending = client.callTool({ name: 'featpage__work', arguments: {} }, undefined, { signal: controller.signal });
    await sleep(200);
    controller.abort();
    await assert.rejects(pending);
    for (let i = 0; i < 30 && !page.received.some((m) => m.type === 'cancel_call'); i++) await sleep(50);
    const call = page.received.find((m) => m.type === 'call' && m.name === 'work');
    const cancel = page.received.find((m) => m.type === 'cancel_call');
    assert.ok(cancel, 'the page must receive cancel_call');
    assert.equal(cancel.id, call.id);
  } finally {
    await close();
    page.ws.close();
  }
});

// ---- lazy proxies ----

test('a lazy proxy exposes list_tools + call_tool instead of one tool per upstream tool, and switches back when lazy is turned off', async () => {
  const config = await addProxy({ slug: 'lazyfake', transport: 'stdio', command: 'npx', args: ['tsx', RICH_FIXTURE], lazy: true });
  const status = await waitForConnected(config.id);
  assert.equal(status.lazy, true);
  assert.equal(status.toolCount, 2, 'toolCount still counts the upstream tools');

  const { client, close } = await connectMcpClient();
  try {
    const listTool = await waitForTool(client, 'lazyfake__list_tools');
    await waitForTool(client, 'lazyfake__call_tool');
    const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('lazyfake__'));
    assert.deepEqual(names.sort(), ['lazyfake__call_tool', 'lazyfake__list_tools']);
    assert.match(listTool.description ?? '', /search, crash/);

    const listed = JSON.parse(((await client.callTool({ name: 'lazyfake__list_tools', arguments: {} })) as any).content[0].text);
    assert.deepEqual(listed.tools.map((t: any) => t.name), ['search', 'crash']);
    const one = JSON.parse(((await client.callTool({ name: 'lazyfake__list_tools', arguments: { tool: 'search' } })) as any).content[0].text);
    assert.deepEqual(one.inputSchema.properties.mode.enum, ['fast', 'deep']);

    const called: any = await client.callTool({ name: 'lazyfake__call_tool', arguments: { tool: 'search', args: { mode: 'fast', filter: 'x' } } });
    assert.equal(called.content[0].text, 'search fast filter="x" meta=undefined');
    const viaString: any = await client.callTool({ name: 'lazyfake__call_tool', arguments: { tool: 'search', args: '{"mode":"deep"}' } });
    assert.match(viaString.content[0].text, /^search deep/);

    const unknown: any = await client.callTool({ name: 'lazyfake__call_tool', arguments: { tool: 'nope' } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /not a tool of "lazyfake"/);
    const badArgs: any = await client.callTool({ name: 'lazyfake__call_tool', arguments: { tool: 'search', args: [1] } });
    assert.equal(badArgs.isError, true);

    // An edit that does not mention lazy keeps it.
    await client.callTool({ name: 'admin__edit_mcp_proxy', arguments: { slug: 'lazyfake', newSlug: 'lazyfake', transport: 'stdio', command: 'npx', args: `tsx ${RICH_FIXTURE.includes(' ') ? `"${RICH_FIXTURE}"` : RICH_FIXTURE}` } });
    assert.equal((await api(`/api/proxies/${config.id}`)).lazy, true);
    await waitForConnected(config.id);

    await client.callTool({ name: 'admin__edit_mcp_proxy', arguments: { slug: 'lazyfake', newSlug: 'lazyfake', transport: 'stdio', command: 'npx', args: `tsx ${RICH_FIXTURE.includes(' ') ? `"${RICH_FIXTURE}"` : RICH_FIXTURE}`, lazy: false } });
    await waitForConnected(config.id);
    await waitForTool(client, 'lazyfake__search');
    assert.ok(!(await client.listTools()).tools.some((t) => t.name === 'lazyfake__call_tool'));
  } finally {
    await close();
    await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
  }
});

// ---- OAuth proxies ----

test('an OAuth proxy reports an authorization link, connects after the callback, and keeps its tokens across a restart', async () => {
  const url = `http://localhost:${OAUTH_UPSTREAM_PORT}/mcp`;
  const config = await addProxy({ slug: 'oauthfake', transport: 'streamableHttp', url, oauth: true });
  try {
    const waiting = await proxyStatus(config.id);
    assert.equal(waiting.connected, false);
    assert.match(waiting.lastError, /Authorization required/);
    assert.ok(waiting.authUrl, 'a proxy waiting for approval must report authUrl');
    const authUrl = new URL(waiting.authUrl);
    assert.equal(authUrl.origin + authUrl.pathname, `http://localhost:${OAUTH_UPSTREAM_PORT}/authorize`);
    assert.equal(authUrl.searchParams.get('redirect_uri'), `${BASE_URL}/oauth/callback`);
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    const state = authUrl.searchParams.get('state');
    assert.ok(state);

    const wrongState = await fetch(`${BASE_URL}/oauth/callback?code=${GOOD_CODE}&state=not-a-real-state`);
    assert.equal(wrongState.status, 400);
    const denied = await fetch(`${BASE_URL}/oauth/callback?error=access_denied&error_description=${encodeURIComponent('<b>no</b>')}&state=${state}`);
    assert.equal(denied.status, 400);
    const deniedHtml = await denied.text();
    assert.ok(deniedHtml.includes('&lt;b&gt;no&lt;/b&gt;') && !deniedHtml.includes('<b>no</b>'), 'values from the query string must be escaped');
    const badCode = await fetch(`${BASE_URL}/oauth/callback?code=wrong&state=${state}`);
    assert.equal(badCode.status, 400);
    assert.equal((await proxyStatus(config.id)).connected, false);

    const approved = await fetch(`${BASE_URL}/oauth/callback?code=${GOOD_CODE}&state=${state}`);
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /Proxy authorized/);
    const connected = await waitForConnected(config.id);
    assert.equal(connected.toolCount, 1);
    assert.equal(connected.authUrl, undefined);
    assert.ok(oauthUpstream.tokenRequests.at(-1)!.get('code_verifier'), 'the code exchange must carry the PKCE verifier');

    const call = await api('/api/proxies/channel/oauthfake/call/oauthfake__whoami', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ greeting: 'hello' }) });
    assert.equal(call.result.content[0].text, 'hello, authorized caller');

    const stored = JSON.parse(fs.readFileSync(oauthStorePath, 'utf-8'));
    assert.equal(stored[config.id].tokens.access_token, 'good-token');
    if (process.platform !== 'win32') assert.equal(fs.statSync(oauthStorePath).mode & 0o777, 0o600);

    // The used state is single-use.
    assert.equal((await fetch(`${BASE_URL}/oauth/callback?code=${GOOD_CODE}&state=${state}`)).status, 400);

    await fetch(`${BASE_URL}/api/proxies/${config.id}/restart`, { method: 'POST' });
    const again = await waitForConnected(config.id);
    assert.equal(again.authUrl, undefined, 'stored tokens must be reused, with no second approval');
  } finally {
    await fetch(`${BASE_URL}/api/proxies/${config.id}`, { method: 'DELETE' });
  }
  assert.equal(JSON.parse(fs.readFileSync(oauthStorePath, 'utf-8'))[config.id], undefined, 'removing a proxy removes its tokens');
});

test('oauth on a stdio proxy, and a malformed oauth or lazy value, are rejected with 400', async () => {
  const post = (body: unknown) => fetch(`${BASE_URL}/api/proxies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ slug: 'bad1', transport: 'stdio', command: 'npx', oauth: true })).status, 400);
  assert.equal((await post({ slug: 'bad2', transport: 'streamableHttp', url: 'http://localhost:1/mcp', oauth: 'yes' })).status, 400);
  assert.equal((await post({ slug: 'bad3', transport: 'stdio', command: 'npx', lazy: 'yes' })).status, 400);
  assert.ok(!(await api('/api/proxies')).some((p: any) => /^bad\d$/.test(p.slug)));
});

// ---- tool call log ----

test('the tool call log separates MCP sessions, can be filtered, exported as a report, resized and cleared', async () => {
  await fetch(`${BASE_URL}/api/dashboard/calls`, { method: 'DELETE' });
  const a = await connectMcpClient('agent-a');
  const b = await connectMcpClient('agent-b');
  try {
    await waitForTool(a.client, 'feat__read_thing');
    await a.client.callTool({ name: 'feat__read_thing', arguments: {} });
    await a.client.callTool({ name: 'feat__fail', arguments: {} });
    await b.client.callTool({ name: 'feat__read_thing', arguments: {} });

    const all = await api('/api/dashboard/calls');
    assert.equal(all.entries.length, 3);
    assert.deepEqual(all.config, { limit: 300, ttlMinutes: 60 });
    const sessionA = all.sessions.find((s: any) => s.sessionId === a.sessionId);
    assert.deepEqual([sessionA.client, sessionA.calls, sessionA.errors], ['agent-a 1.0.0', 2, 1]);
    assert.equal(all.sessions.find((s: any) => s.sessionId === b.sessionId).calls, 1);
    assert.deepEqual(all.entries.map((e: any) => [e.connection, e.tool, e.ok]), [['feat', 'read_thing', true], ['feat', 'fail', false], ['feat', 'read_thing', true]]);

    assert.equal((await api(`/api/dashboard/calls?session=${b.sessionId}`)).entries.length, 1);
    assert.equal((await api('/api/dashboard/calls?status=error')).entries[0].error, 'upstream says no');
    assert.equal((await api('/api/dashboard/calls?tool=READ')).entries.length, 2);

    const reportRes = await fetch(`${BASE_URL}/api/dashboard/calls?format=report&download=1&session=${a.sessionId}`);
    assert.match(reportRes.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(reportRes.headers.get('content-disposition') ?? '', /attachment; filename="tool-call-report-/);
    const report = await reportRes.text();
    assert.match(report, /2 call\(s\) to 2 tool\(s\) across 1 MCP session/);
    assert.match(report, /## feat__fail/);
    assert.match(report, /1× upstream says no/);
    assert.match(report, /Description: Always fails/);

    // The same report for an agent, limited to its own session.
    const own: any = await b.client.callTool({ name: 'admin__tool_call_report', arguments: { session: 'current' } });
    assert.match(own.content[0].text, /1 call\(s\) to 1 tool\(s\) across 1 MCP session/);

    const resized = await api('/api/dashboard/calls/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 2, ttlMinutes: 5 }) });
    assert.deepEqual(resized.config, { limit: 2, ttlMinutes: 5 });
    assert.equal((await api('/api/dashboard/calls')).entries.length, 2, 'shrinking the limit drops the oldest calls');
    assert.equal((await fetch(`${BASE_URL}/api/dashboard/calls/config`, { method: 'POST', body: '{nope' })).status, 400);

    const cleared = await api(`/api/dashboard/calls?session=${b.sessionId}`, { method: 'DELETE' });
    assert.equal(cleared.ok, true);
    assert.ok(!(await api('/api/dashboard/calls')).entries.some((e: any) => e.sessionId === b.sessionId));

    const page = await fetch(`${BASE_URL}/calls`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Tool calls/);
    const foreign = await fetch(`${BASE_URL}/api/dashboard/calls`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403, 'the log holds tool arguments: a foreign web page must not read it');
  } finally {
    await api('/api/dashboard/calls/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 300, ttlMinutes: 60 }) });
    await a.close();
    await b.close();
  }
});

test('the call log stream pings when a call is logged', async () => {
  const { client, close } = await connectMcpClient();
  const controller = new AbortController();
  try {
    const res = await fetch(`${BASE_URL}/api/dashboard/calls/stream`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read(); // the ping sent on connect
    await waitForTool(client, 'feat__read_thing');
    await client.callTool({ name: 'feat__read_thing', arguments: {} });
    const { value } = await Promise.race([reader.read(), sleep(3000).then(() => ({ value: undefined }))]);
    assert.ok(value, 'expected a change ping after a tool call');
  } finally {
    controller.abort();
    await close();
  }
});

// ---- persisted page tools ----

test('with --persist-page-tools, a tool an agent registered on a page is registered again when that page reconnects, and unregistering removes it for good', async () => {
  const hostTools = [{ name: 'host_tool', description: 'host', params: {} }];
  const first = await connectPage('persistapp', hostTools);
  const { client, close } = await connectMcpClient();
  try {
    await waitForTool(client, 'persistapp__host_tool');
    const id = await connectionIdFor(client, 'persistapp');
    const registered: any = await client.callTool({
      name: 'register_page_tool_by_code',
      arguments: { id, name: 'count_rows', description: 'counts rows', code: 'return args.n;', params: { n: { type: 'number' } } },
    });
    assert.notEqual(registered.isError, true, registered.content?.[0]?.text);
    await waitForTool(client, 'persistapp__count_rows');
    const saved = JSON.parse(fs.readFileSync(pageToolsPath, 'utf-8'));
    assert.equal(saved['root:persistapp|persistapp'].tools[0].name, 'count_rows');
    if (process.platform !== 'win32') assert.equal(fs.statSync(pageToolsPath).mode & 0o777, 0o600);

    // Close the page and wait until its tenant is swept, so only the file can bring the tool back.
    first.ws.close();
    for (let i = 0; i < 40 && (await api('/api/dashboard')).root.some((r: any) => r.name === 'persistapp'); i++) await sleep(100);
    await sleep(600);

    const second = await connectPage('persistapp', hostTools);
    const tool = await waitForTool(client, 'persistapp__count_rows');
    assert.equal((tool.inputSchema as any).properties.n.type, 'number', 'the replayed tool must keep its params');
    const replay = second.received.find((m) => m.type === 'call' && m.name === '__register_tool_by_code__');
    assert.equal(replay.args.code, 'return args.n;');

    const id2 = await connectionIdFor(client, 'persistapp');
    await client.callTool({ name: 'unregister_page_tool', arguments: { id: id2, toolName: 'count_rows' } });
    for (let i = 0; i < 40 && JSON.parse(fs.readFileSync(pageToolsPath, 'utf-8'))['root:persistapp|persistapp']; i++) await sleep(50);
    assert.equal(JSON.parse(fs.readFileSync(pageToolsPath, 'utf-8'))['root:persistapp|persistapp'], undefined);
    second.ws.close();
  } finally {
    await close();
  }
});
