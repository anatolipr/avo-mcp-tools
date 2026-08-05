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

test('a fresh session only has get_embed_snippet and describe_tools until a page pushes its manifest', async () => {
  const a = await connectClient();
  const names = await toolNames(a.client);
  assert.deepEqual(names.sort(), ['describe_tools', 'get_embed_snippet', 'wait_for_connection']);
  await a.client.close();
});

test('pushing a manifest over WS makes new named tools appear in tools/list, and calling one round-trips through the page', async () => {
  const a = await connectClient();
  const tenantId = requireSessionId(a.transport);

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
  const tenantId = requireSessionId(a.transport);

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

test('manifests are isolated per tenant — a second session with no manifest still only sees get_embed_snippet', async () => {
  const a = await connectClient();
  const b = await connectClient();

  const wsA = await connectWs(requireSessionId(a.transport));
  wsA.send(JSON.stringify({
    type: 'register_tools',
    tools: [{ name: 'insert_title', description: 'd', params: { title: { type: 'string' } } }],
  }));

  await waitForTool(a.client, 'insert_title');

  const bNames = await toolNames(b.client);
  assert.deepEqual(bNames.sort(), ['describe_tools', 'get_embed_snippet', 'wait_for_connection']);

  wsA.close();
  await a.client.close();
  await b.client.close();
});

test('wait_for_connection resolves once a page registers its manifest, with its label/summary/tools', async () => {
  const a = await connectClient();
  const tenantId = requireSessionId(a.transport);

  const waitPromise = a.client.callTool({ name: 'wait_for_connection', arguments: {} });

  const ws = await connectWs(tenantId);
  ws.send(JSON.stringify({
    type: 'register_tools',
    tools: [{ name: 'insert_title', description: 'Sets the title', params: { title: { type: 'string' } } }],
    summary: 'This page is a mind-mapping tool.',
    appLabel: 'mindfoo',
  }));

  const result = await waitPromise;
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.label, 'mindfoo');
  assert.equal(payload.summary, 'This page is a mind-mapping tool.');
  assert.ok(payload.tools.some((t: any) => t.name === 'insert_title'));

  ws.close();
  await a.client.close();
});
