import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';

const PORT = 8907;
const BASE_URL = `http://localhost:${PORT}`;
let serverProcess: ChildProcess;

function textOf(result: Record<string, unknown>): string {
  const content = result.content as Array<{ text: string }>;
  return content[0]!.text;
}

before(async () => {
  serverProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
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

test('a fresh session only has the base tools until a page pushes its manifest', async () => {
  const a = await connectClient();
  const names = await toolNames(a.client);
  assert.deepEqual(names.sort(), ['channel_find', 'describe_tools', 'get_embed_snippet', 'identify_connection', 'join_channel', 'list_channels']);
  await a.client.close();
});

test('pushing a manifest over WS makes new named tools appear in tools/list, and calling one round-trips through the page', async () => {
  const a = await connectClient();
  // js-bridge-mcp runs with defaultTenantMode: 'shared' (src/server.ts) so
  // that an MCP client reconnecting with no ?tenant= (observed with VS Code
  // Copilot, which does this routinely) doesn't orphan an already-bridged
  // browser tab by landing on a fresh empty tenant each time. That means an
  // unpinned session's real tenant is 'default', not its own session id —
  // get_embed_snippet (hello-tools.ts) reflects this by embedding
  // tenant().id, which is 'default' here, not requireSessionId(a.transport).
  const tenantId = 'default';

  const ws = await connectWs(tenantId);
  const manifest = [
    {
      name: 'insert_title',
      description: 'Sets the title',
      params: { title: { type: 'string' } },
    },
  ];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'call' && msg.name === 'insert_title') {
      ws.send(JSON.stringify({ type: 'call_result', id: msg.id, result: `title set to "${msg.args.title}"` }));
    }
  });
  ws.send(JSON.stringify({ type: 'register_tools', tools: manifest }));

  await waitForTool(a.client, 'insert_title');

  const result = await a.client.callTool({ name: 'insert_title', arguments: { title: 'Hi there' } });
  assert.equal(textOf(result), 'title set to "Hi there"');

  ws.close();
  await a.client.close();
});

test('a manifest\'s summary is readable via describe_tools once registered', async () => {
  const a = await connectClient();
  const tenantId = 'default'; // see comment in the previous test — shared-tenant mode

  const ws = await connectWs(tenantId);
  ws.send(JSON.stringify({
    type: 'register_tools',
    tools: [{ name: 'insert_title', description: 'd', params: { title: { type: 'string' } } }],
    summary: 'This page is a hello-world demo with a title and a body.',
  }));

  await waitForTool(a.client, 'insert_title');

  const result = await a.client.callTool({ name: 'describe_tools', arguments: {} });
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.summary, 'This page is a hello-world demo with a title and a body.');
  assert.ok(payload.tools.some((t: any) => t.name === 'insert_title'));

  ws.close();
  await a.client.close();
});

test('two unpinned MCP sessions share the default tenant — a manifest registered from one is visible to the other', async () => {
  // This intentionally documents the opposite of what per-session-tenant
  // isolation would give you: js-bridge-mcp runs with defaultTenantMode:
  // 'shared' (see comment on the earlier WS tests) specifically so that a
  // client reconnecting with no ?tenant= keeps landing on the same tenant
  // as the browser tab that's already bridged there, instead of each
  // reconnect minting a fresh empty one. The tradeoff is that two
  // different unpinned agent sessions now see each other's tools rather
  // than staying isolated — get_embed_snippet's description was updated
  // to say so explicitly (hello-tools.ts).
  const a = await connectClient();
  const b = await connectClient();

  const wsA = await connectWs('default');
  wsA.send(JSON.stringify({
    type: 'register_tools',
    tools: [{ name: 'insert_title', description: 'd', params: { title: { type: 'string' } } }],
  }));

  await waitForTool(a.client, 'insert_title');
  await waitForTool(b.client, 'insert_title');

  wsA.close();
  await a.client.close();
  await b.client.close();
});
