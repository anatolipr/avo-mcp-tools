import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const PORT = 8907;
const BASE_URL = `http://localhost:${PORT}`;
let serverProcess: ChildProcess;
// A private, empty proxy config — without it this server would load (and
// spawn) whatever the developer running the tests has in their real
// ~/.js-bridge-mcp-proxies.json, and the base tool list below would vary.
const proxyConfigPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'js-bridge-mcp-manifest-test-')), 'proxies.json');

function textOf(result: Record<string, unknown>): string {
  const content = result.content as Array<{ text: string }>;
  return content[0]!.text;
}

before(async () => {
  // detached: true so this spawns its own process group - `npx` execs `npm
  // exec`, which execs the real tsx/node server as a GRANDCHILD, so a plain
  // serverProcess.kill() below only signals the npx wrapper and leaves that
  // grandchild running, still holding PORT open. Left unfixed, every test
  // run leaks a live orphan server; node --test's process for this file then
  // never exits on its own and eventually gets SIGKILLed by the runner after
  // its own timeout, surfacing as a mysterious late "test failed" with no
  // assertion detail even when every individual test already passed.
  serverProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), PROXY_CONFIG_PATH: proxyConfigPath, JS_BRIDGE_MCP_NO_OPEN: '1' },
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

after(() => {
  // Negative pid targets the whole process group (see detached: true above),
  // so this actually reaches the real tsx/node server, not just the npx
  // wrapper that spawned it.
  if (serverProcess.pid) process.kill(-serverProcess.pid, 'SIGKILL');
  fs.rmSync(path.dirname(proxyConfigPath), { recursive: true, force: true });
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

function connectWs(tenantId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=${tenantId}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
}

async function waitForTool(client: Client, name: string, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const names = await toolNames(client);
    if (names.includes(name)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`tool "${name}" did not appear in tools/list within ${timeoutMs}ms`);
}

// How a bridged page reaches a session today (these tests predate it and
// were rewritten): a bare ?tenant=<name> makes the page a ROOT connection
// called <name>, its tools are always prefixed "<name>__", and root tools
// are merged into every MCP session with no join_channel needed. Each test
// uses its own page name so one test's closing socket can't collide with
// the next one's connect and push it onto a suffixed name.

/** The connection id describe_tools reports for a root page — register/unregister_page_tool need it, since the page is not on the session's own tenant. */
async function connectionIdFor(client: Client, toolPrefix: string): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const payload = JSON.parse(textOf(await client.callTool({ name: 'describe_tools', arguments: {} })));
    const conn = payload.connections.find((c: any) => c.toolPrefix === toolPrefix);
    if (conn) return conn.id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no connection with tool prefix "${toolPrefix}" appeared in describe_tools`);
}

test('a fresh session only has the base tools until a page pushes its manifest', async () => {
  const a = await connectClient();
  const names = await toolNames(a.client);
  assert.deepEqual(names.sort(), [
    'admin__add_mcp_proxy',
    'admin__edit_mcp_proxy',
    'admin__list_mcp_proxies',
    'admin__pause_mcp_proxy',
    'admin__remove_mcp_proxy',
    'admin__restart_mcp_proxy',
    'admin__resume_mcp_proxy',
    'admin__tool_call_report',
    'admin__view_mcp_proxy',
    'channel_find',
    'describe_channel',
    'describe_connection',
    'describe_tools',
    'get_embed_snippet',
    'identify_connection',
    'join_channel',
    'list_channels',
    'list_proxies',
    'register_page_tool_by_code',
    'register_page_tool_by_path',
    'request_reconnect',
    'unregister_page_tool',
  ]);
  await a.client.close();
});

test('pushing a manifest over WS makes new prefixed tools appear in tools/list, and calling one round-trips through the page', async () => {
  const a = await connectClient();
  const ws = await connectWs('pageone');
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'call' && msg.name === 'insert_title') {
      ws.send(JSON.stringify({ type: 'call_result', id: msg.id, result: `title set to "${msg.args.title}"` }));
    }
  });
  ws.send(JSON.stringify({
    type: 'register_tools',
    tools: [{ name: 'insert_title', description: 'Sets the title', params: { title: { type: 'string' } } }],
  }));

  await waitForTool(a.client, 'pageone__insert_title');

  const result = await a.client.callTool({ name: 'pageone__insert_title', arguments: { title: 'Hi there' } });
  assert.equal(textOf(result), 'title set to "Hi there"');

  ws.close();
  await a.client.close();
});

test('a manifest\'s summary is readable via describe_tools once registered', async () => {
  const a = await connectClient();
  const ws = await connectWs('pagetwo');
  ws.send(JSON.stringify({
    type: 'register_tools',
    tools: [{ name: 'insert_title', description: 'd', params: { title: { type: 'string' } } }],
    summary: 'This page is a hello-world demo with a title and a body.',
  }));

  await waitForTool(a.client, 'pagetwo__insert_title');

  const payload = JSON.parse(textOf(await a.client.callTool({ name: 'describe_tools', arguments: {} })));
  const conn = payload.connections.find((c: any) => c.toolPrefix === 'pagetwo');
  assert.equal(conn.summary, 'This page is a hello-world demo with a title and a body.');
  assert.ok(conn.tools.some((t: any) => t.name === 'pagetwo__insert_title'));

  ws.close();
  await a.client.close();
});

test('two unpinned MCP sessions both see a root page\'s tools', async () => {
  const a = await connectClient();
  const b = await connectClient();

  const ws = await connectWs('pagethree');
  ws.send(JSON.stringify({
    type: 'register_tools',
    tools: [{ name: 'insert_title', description: 'd', params: { title: { type: 'string' } } }],
  }));

  await waitForTool(a.client, 'pagethree__insert_title');
  await waitForTool(b.client, 'pagethree__insert_title');

  ws.close();
  await a.client.close();
  await b.client.close();
});

test('get_embed_snippet (no join_channel) yields a snippet whose page is visible to the session that asked for it', async () => {
  const a = await connectClient();
  const snippet = textOf(await a.client.callTool({ name: 'get_embed_snippet', arguments: {} }));
  const moduleUrl = new URL(JSON.parse(snippet.slice('import('.length, -');'.length)));
  const tenantParam = moduleUrl.searchParams.get('tenant')!;
  // The raw tenant id ("root:js-bridge-mcp") used to be embedded here; the
  // WS side read its colon as "channel root, name js-bridge-mcp" and the
  // page's tools were visible to no one.
  assert.ok(!tenantParam.includes(':'), `snippet embeds a colon-bearing tenant "${tenantParam}"`);

  const ws = await connectWs(encodeURIComponent(tenantParam));
  ws.send(JSON.stringify({ type: 'register_tools', tools: [{ name: 'insert_title', description: 'd', params: {} }] }));
  await waitForTool(a.client, 'js_bridge_mcp__insert_title');

  ws.close();
  await a.client.close();
});

test('register_page_tool_by_path round-trips through the server-side reserved-name plumbing', async () => {
  const a = await connectClient();
  const ws = await connectWs('pagefour');
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'call' && msg.name === '__register_tool_by_path__') {
      ws.send(JSON.stringify({ type: 'call_result', id: msg.id, result: `registered "${msg.args.name}" -> window.${msg.args.path}` }));
    }
  });
  ws.send(JSON.stringify({ type: 'register_tools', tools: [] }));
  const id = await connectionIdFor(a.client, 'pagefour');

  const result = await a.client.callTool({
    name: 'register_page_tool_by_path',
    arguments: { id, name: 'save', description: 'saves', path: 'myApp.save' },
  });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /registered "save" -> window.myApp.save/);

  ws.close();
  await a.client.close();
});

/** True if `name` shows up in any recentToolRegistrations list anywhere in the dashboard snapshot — channels and root connections report it in different places. */
async function isRegistrationLogged(name: string): Promise<boolean> {
  const snapshot = await (await fetch(`${BASE_URL}/api/dashboard`)).json();
  let found = false;
  JSON.stringify(snapshot, (key, value) => {
    if (key === 'recentToolRegistrations' && Array.isArray(value) && value.some((r: any) => r.name === name)) found = true;
    return value;
  });
  return found;
}

test('register_page_tool_by_code registers immediately (no approval gate) and logs it for the dashboard', async () => {
  const a = await connectClient();
  const ws = await connectWs('pagefive');
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'call' && msg.name === '__register_tool_by_code__') {
      ws.send(JSON.stringify({ type: 'call_result', id: msg.id, result: `registered "${msg.args.name}" from code` }));
    }
  });
  ws.send(JSON.stringify({ type: 'register_tools', tools: [] }));
  const id = await connectionIdFor(a.client, 'pagefive');

  const result = await a.client.callTool({
    name: 'register_page_tool_by_code',
    arguments: { id, name: 'explore', description: 'discovery', code: 'return 1;' },
  });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /registered "explore" from code/);

  // Registration already happened by the time the tool call resolved — this
  // just confirms it also got logged for the dashboard's sticky-toast feed.
  const start = Date.now();
  while (!(await isRegistrationLogged('explore'))) {
    assert.ok(Date.now() - start < 3000, 'no tool-registration log entry for "explore" appeared within 3000ms');
    await new Promise((r) => setTimeout(r, 50));
  }

  ws.close();
  await a.client.close();
});

test('register_page_tool_by_code (browser-side rejection) surfaces as an MCP tool error and is not logged', async () => {
  const a = await connectClient();
  const ws = await connectWs('pagesix');
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'call' && msg.name === '__register_tool_by_code__') {
      ws.send(JSON.stringify({ type: 'call_result', id: msg.id, error: 'code failed to compile: Unexpected token' }));
    }
  });
  ws.send(JSON.stringify({ type: 'register_tools', tools: [] }));
  const id = await connectionIdFor(a.client, 'pagesix');

  const result = await a.client.callTool({
    name: 'register_page_tool_by_code',
    arguments: { id, name: 'explore3', description: 'discovery', code: '((' },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /code failed to compile/);
  assert.equal(await isRegistrationLogged('explore3'), false, 'a failed registration must not be logged');

  ws.close();
  await a.client.close();
});

test('unregister_page_tool surfaces a "not a tracked dynamic tool" rejection as an MCP tool error', async () => {
  const a = await connectClient();
  const ws = await connectWs('pageseven');
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'call' && msg.name === '__unregister_tool__') {
      ws.send(JSON.stringify({ type: 'call_result', id: msg.id, error: `"${msg.args.toolName}" is not a currently-tracked dynamically-registered tool on this connection (already removed, never dynamic, or a host tool — host tools can never be unregistered remotely)` }));
    }
  });
  ws.send(JSON.stringify({ type: 'register_tools', tools: [] }));
  const id = await connectionIdFor(a.client, 'pageseven');

  const result = await a.client.callTool({
    name: 'unregister_page_tool',
    arguments: { id, toolName: 'get_embed_snippet' },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /host tools can never be unregistered/);

  ws.close();
  await a.client.close();
});
