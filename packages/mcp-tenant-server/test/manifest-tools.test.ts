import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { WebSocket } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Tenant, tenants } from '../src/tenant.js';
import { createManifestToolRegistry } from '../src/manifest-tools.js';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws.js';
import { getOrCreateTenant } from '../src/tenant.js';

test('Tenant.setToolManifest stores the manifest and is readable back', () => {
  const t = new Tenant('t1', undefined, {});
  const manifest = [{ name: 'foo', description: 'd', params: {} }];
  t.setToolManifest(manifest);
  assert.deepEqual(t.toolManifest, manifest);
});

test('Tenant call/resolveCall round-trip resolves with the page result', async () => {
  const t = new Tenant('t1', undefined, {});
  const pending = t.call('insert_title', { title: 'hi' });
  const id = [...t.pendingCalls.keys()][0]!;
  t.resolveCall(id, 'ok');
  assert.equal(await pending, 'ok');
});

test('Tenant call/rejectCall round-trip rejects', async () => {
  const t = new Tenant('t1', undefined, {});
  const pending = t.call('insert_title', { title: 'hi' });
  const id = [...t.pendingCalls.keys()][0]!;
  t.rejectCall(id, 'boom');
  await assert.rejects(pending, /boom/);
});

test('createManifestToolRegistry registers a tool per manifest entry with correct zod param types, plus the built-in describe_tools', () => {
  const t = new Tenant('t1', undefined, {});
  t.setToolManifest([
    { name: 'insert_title', description: 'sets title', params: { title: { type: 'string' } } },
  ]);
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();
  assert.equal(registry.handles.size, 2);
  assert.ok(registry.handles.has('insert_title'));
  assert.ok(registry.handles.has('describe_tools'));
});

test('calling a manifest tool sends a "call" WS message (by tool name) and resolves via resolveCall', async () => {
  const t = new Tenant('t1', undefined, {});
  t.setToolManifest([
    { name: 'insert_title', description: 'sets title', params: { title: { type: 'string' } } },
  ]);
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  createManifestToolRegistry(mcp, () => t).sync();

  const fakeSocket = {
    readyState: 1,
    OPEN: 1,
    send(raw: string) {
      const msg = JSON.parse(raw);
      if (msg.type === 'call') {
        assert.equal(msg.name, 'insert_title');
        queueMicrotask(() => t.resolveCall(msg.id, `title set to "${msg.args.title}"`));
      }
    },
  };
  t.wsClients.add(fakeSocket as any);

  const result = await t.call('insert_title', { title: 'Hi' });
  assert.equal(result, 'title set to "Hi"');
});

test('unsupported param type throws a clear error', () => {
  const t = new Tenant('t1', undefined, {});
  t.setToolManifest([
    { name: 'bad', description: 'x', params: { thing: { type: 'object' as any } } },
  ]);
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  assert.throws(() => registry.sync(), /unsupported param type/i);
});

test('re-registering a manifest removes stale tools and adds new ones', () => {
  const t = new Tenant('t1', undefined, {});
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });

  t.setToolManifest([{ name: 'insert_title', description: 'd', params: {} }]);
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();
  assert.ok(registry.handles.has('insert_title'));

  t.setToolManifest([{ name: 'insert_main', description: 'd2', params: {} }]);
  registry.sync();
  assert.ok(!registry.handles.has('insert_title'), 'stale tool should be removed');
  assert.ok(registry.handles.has('insert_main'));
  assert.ok(registry.handles.has('describe_tools'), 'describe_tools should never be treated as stale');
});

test('describe_tools returns the page summary and a compact tool index, and shadows a page tool of the same name', async () => {
  const t = new Tenant('t1', undefined, {});
  t.setToolManifest(
    [
      { name: 'insert_title', description: 'sets title', params: {} },
      { name: 'describe_tools', description: 'a page tool that should be shadowed', params: {} },
    ],
    'This page is a hello-world demo.'
  );
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  assert.equal(registry.handles.size, 2, 'the colliding page tool name should not add a second handle');

  const handle = registry.handles.get('describe_tools')!;
  const result: any = await (handle as any).handler({}, {});
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.summary, 'This page is a hello-world demo.');
  assert.ok(payload.tools.some((e: any) => e.name === 'insert_title'));
});

test('WS "register_tools" message updates the tenant manifest; "call_result" resolves a pending call', async () => {
  const port = 18901;
  const httpServer = createHttpServer({
    port,
    staticDir: os.tmpdir(),
    initialSchema: undefined,
    initialValues: {},
    identity: { name: 'test', version: '0.0.1' },
    registerFn: () => {},
  });
  attachWebSocketServer(httpServer, port, undefined, {});
  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  getOrCreateTenant('manifest-test', undefined, {});

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws?tenant=manifest-test`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const manifest = [{ name: 'insert_title', description: 'd', params: { title: { type: 'string' as const } } }];
    ws.send(JSON.stringify({ type: 'register_tools', tools: manifest }));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepEqual(tenants.get('manifest-test')?.toolManifest, manifest);

    const pending = tenants.get('manifest-test')!.call('insert_title', { title: 'hi' });
    const callMsg = await new Promise<any>((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
    assert.equal(callMsg.type, 'call');
    assert.equal(callMsg.name, 'insert_title');
    ws.send(JSON.stringify({ type: 'call_result', id: callMsg.id, result: 'done' }));
    assert.equal(await pending, 'done');

    ws.close();
  } finally {
    tenants.get('manifest-test')?.dispose();
    tenants.delete('manifest-test');
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
