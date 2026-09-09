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
  const pending = t.call(undefined, 'insert_title', { title: 'hi' });
  const id = [...t.pendingCalls.keys()][0]!;
  t.resolveCall(id, 'ok');
  assert.equal(await pending, 'ok');
});

test('Tenant call/rejectCall round-trip rejects', async () => {
  const t = new Tenant('t1', undefined, {});
  const pending = t.call(undefined, 'insert_title', { title: 'hi' });
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
  assert.equal(registry.handles.size, 6);
  assert.ok(registry.handles.has('insert_title'));
  assert.ok(registry.handles.has('describe_tools'));
  assert.ok(registry.handles.has('identify_connection'));
  assert.ok(registry.handles.has('register_page_tool_by_path'));
  assert.ok(registry.handles.has('register_page_tool_by_code'));
  assert.ok(registry.handles.has('unregister_page_tool'));
});

test('calling a manifest tool sends a "call" WS message (by tool name) and resolves via resolveCall', async () => {
  const t = new Tenant('t1', undefined, {});

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
  t.registerConnection('conn1', fakeSocket as any);
  t.updateConnectionManifest('conn1', [
    { name: 'insert_title', description: 'sets title', params: { title: { type: 'string' } } },
  ]);

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  createManifestToolRegistry(mcp, () => t).sync();

  const result = await t.call('conn1', 'insert_title', { title: 'Hi' });
  assert.equal(result, 'title set to "Hi"');
});

test('call(undefined, ...) broadcasts to every socket on the tenant (legacy path)', async () => {
  const t = new Tenant('t1', undefined, {});
  let received = 0;
  const fakeSocket = {
    readyState: 1,
    OPEN: 1,
    send(raw: string) {
      const msg = JSON.parse(raw);
      if (msg.type === 'call') {
        received += 1;
        queueMicrotask(() => t.resolveCall(msg.id, 'ok'));
      }
    },
  };
  t.wsClients.add(fakeSocket as any);

  const result = await t.call(undefined, 'insert_title', { title: 'Hi' });
  assert.equal(result, 'ok');
  assert.equal(received, 1);
});

test('unsupported param type skips just that tool, others still register', () => {
  const t = new Tenant('t1', undefined, {});
  t.setToolManifest([
    { name: 'bad', description: 'x', params: { thing: { type: 'object' as any } } },
    { name: 'insert_title', description: 'd', params: {} },
  ]);
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  assert.doesNotThrow(() => registry.sync());
  assert.ok(!registry.handles.has('bad'));
  assert.ok(registry.handles.has('insert_title'));
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

  assert.equal(registry.handles.size, 6, 'the colliding page tool name should not add a second handle');

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

    const connectionId = [...tenants.get('manifest-test')!.connections.keys()][0]!;
    const pending = tenants.get('manifest-test')!.call(connectionId, 'insert_title', { title: 'hi' });
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

function fakeSocket(onCall: (msg: any) => void) {
  return {
    readyState: 1,
    OPEN: 1,
    send(raw: string) {
      const msg = JSON.parse(raw);
      if (msg.type === 'call') onCall(msg);
    },
  } as any;
}

test('two connections with non-overlapping tool names both get prefixed once a second connection registers', () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [{ name: 'submit_form', description: 'd', params: {} }], undefined, 'formalin');
  t.registerConnection('b', fakeSocket(() => {}));
  t.updateConnectionManifest('b', [{ name: 'clear_canvas', description: 'd', params: {} }], undefined, 'htmlpaint');

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  assert.ok(registry.handles.has('formalin__submit_form'));
  assert.ok(registry.handles.has('htmlpaint__clear_canvas'));
  assert.ok(!registry.handles.has('submit_form'), 'unprefixed name should not remain once multi-connection');
});

test('two connections with a colliding tool name both register under distinct prefixes', () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [{ name: 'get_state', description: 'd', params: {} }], undefined, 'formalin');
  t.registerConnection('b', fakeSocket(() => {}));
  t.updateConnectionManifest('b', [{ name: 'get_state', description: 'd', params: {} }], undefined, 'htmlpaint');

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  assert.ok(registry.handles.has('formalin__get_state'));
  assert.ok(registry.handles.has('htmlpaint__get_state'));
});

test('connections with the same/no label get ordinal-suffixed slugs, first-connected keeps the bare slug', () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [{ name: 'insert_title', description: 'd', params: {} }], undefined, 'htmlpaint');
  t.registerConnection('b', fakeSocket(() => {}));
  t.updateConnectionManifest('b', [{ name: 'insert_title', description: 'd', params: {} }], undefined, 'htmlpaint');

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  assert.ok(registry.handles.has('htmlpaint__insert_title'));
  assert.ok(registry.handles.has('htmlpaint2__insert_title'));
});

test('renameConnection re-slugs that connection\'s tool prefix without touching its manifest/summary', () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [{ name: 'get_document', description: 'd', params: {} }], 'orig summary', 'mindfoo');
  t.registerConnection('b', fakeSocket(() => {}));
  t.updateConnectionManifest('b', [{ name: 'get_document', description: 'd', params: {} }], undefined, 'mindfoo');

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  assert.ok(registry.handles.has('mindfoo__get_document'));
  assert.ok(registry.handles.has('mindfoo2__get_document'));

  t.renameConnection('b', 'mindfoo dev');
  registry.sync();

  assert.ok(registry.handles.has('mindfoo__get_document'));
  assert.ok(!registry.handles.has('mindfoo2__get_document'));
  assert.ok(registry.handles.has('mindfoo_dev__get_document'));
  // manifest/summary of the renamed connection are untouched by the rename
  assert.strictEqual(t.connections.get('b')!.manifest[0]!.name, 'get_document');
  assert.strictEqual(t.connections.get('a')!.summary, 'orig summary');
});

test('unlabeled connections fall back to tab/tab2 slugs', () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [{ name: 'insert_title', description: 'd', params: {} }]);
  t.registerConnection('b', fakeSocket(() => {}));
  t.updateConnectionManifest('b', [{ name: 'insert_title', description: 'd', params: {} }]);

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  assert.ok(registry.handles.has('tab__insert_title'));
  assert.ok(registry.handles.has('tab2__insert_title'));
});

test('a targeted call(connectionId, ...) reaches only that connection\'s socket', async () => {
  const t = new Tenant('t1', undefined, {});
  let aCalls = 0;
  let bCalls = 0;
  t.registerConnection('a', fakeSocket((msg) => { aCalls += 1; t.resolveCall(msg.id, 'from-a'); }));
  t.registerConnection('b', fakeSocket(() => { bCalls += 1; }));

  const result = await t.call('a', 'insert_title', { title: 'hi' });
  assert.equal(result, 'from-a');
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 0, 'the other connection should not have received the call');
});

test('removeConnection prunes that connection\'s tools and demotes a remaining solo connection back to unprefixed', () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [{ name: 'insert_title', description: 'd', params: {} }], undefined, 'formalin');
  t.registerConnection('b', fakeSocket(() => {}));
  t.updateConnectionManifest('b', [{ name: 'clear_canvas', description: 'd', params: {} }], undefined, 'htmlpaint');

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();
  assert.ok(registry.handles.has('formalin__insert_title'));
  assert.ok(registry.handles.has('htmlpaint__clear_canvas'));

  t.removeConnection('b');
  registry.sync();
  assert.ok(!registry.handles.has('htmlpaint__clear_canvas'), 'removed connection\'s tool should be pruned');
  assert.ok(!registry.handles.has('formalin__insert_title'), 'stale prefixed name should be removed');
  assert.ok(registry.handles.has('insert_title'), 'remaining solo connection should be unprefixed again');
});

test('describe_tools reports a connections[] shape at 2+ connections, flat shape at 0-1', async () => {
  const t = new Tenant('t1', undefined, {});
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  const flatBefore: any = await (registry.handles.get('describe_tools') as any).handler({}, {});
  const flatPayload = JSON.parse(flatBefore.content[0].text);
  assert.ok('summary' in flatPayload && 'tools' in flatPayload, 'no connections: flat shape');

  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [{ name: 'insert_title', description: 'd', params: {} }], 'form summary', 'formalin');
  t.registerConnection('b', fakeSocket(() => {}));
  t.updateConnectionManifest('b', [{ name: 'clear_canvas', description: 'd', params: {} }], 'paint summary', 'htmlpaint');
  registry.sync();

  const multi: any = await (registry.handles.get('describe_tools') as any).handler({}, {});
  const payload = JSON.parse(multi.content[0].text);
  assert.equal(payload.connections.length, 2);
  const formalin = payload.connections.find((c: any) => c.label === 'formalin');
  assert.equal(formalin.toolPrefix, 'formalin');
  assert.equal(formalin.summary, 'form summary');
  assert.ok(formalin.tools.some((tool: any) => tool.name === 'formalin__insert_title'));
});

test('call() to a connection id that no longer exists rejects cleanly after the reconnect grace window', async () => {
  const t = new Tenant('t1', undefined, {});
  await assert.rejects(() => t.call('missing', 'insert_title', {}, 10_000, 20), /no longer connected/);
});

test('call() to a connection id that no longer exists resolves against a connection that reconnects within the grace window', async () => {
  const t = new Tenant('t1', undefined, {});
  const socket = { readyState: 1, OPEN: 1, send: (raw: string) => {
    const { id } = JSON.parse(raw);
    setImmediate(() => t.resolveCall(id, 'ok'));
  } } as any;

  const callPromise = t.call('missing', 'insert_title', {}, 10_000, 200);
  setTimeout(() => t.registerConnection('revived', socket), 50);

  assert.equal(await callPromise, 'ok');
});

test('register_page_tool_by_path sends a "__register_tool_by_path__" call and resolves via resolveCall', async () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket((msg) => {
    assert.equal(msg.name, '__register_tool_by_path__');
    assert.deepEqual(msg.args, { name: 'save', description: 'saves', path: 'myApp.save', params: {} });
    t.resolveCall(msg.id, 'registered "save" -> window.myApp.save');
  }));

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  const handle = registry.handles.get('register_page_tool_by_path')!;
  const result: any = await (handle as any).handler({ name: 'save', description: 'saves', path: 'myApp.save' }, {});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /registered "save"/);
});

test('register_page_tool_by_code reaches the browser immediately (no approval gate) and logs the registration', async () => {
  const t = new Tenant('t1', undefined, {});
  let sawCall = false;
  t.registerConnection('a', fakeSocket((msg) => {
    sawCall = true;
    assert.equal(msg.name, '__register_tool_by_code__');
    t.resolveCall(msg.id, 'registered "explore" from code');
  }));

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  const handle = registry.handles.get('register_page_tool_by_code')!;
  const result: any = await (handle as any).handler({ name: 'explore', description: 'discovery', code: 'return 1;' }, {});

  assert.equal(sawCall, true, 'should call the browser immediately, with no approval step');
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /registered "explore" from code/);
  assert.equal(t.recentToolRegistrations.length, 1);
  assert.equal(t.recentToolRegistrations[0]!.name, 'explore');
});

test('register_page_tool_by_code surfaces a browser-side rejection (e.g. bad code) as isError, and does not log it', async () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket((msg) => {
    assert.equal(msg.name, '__register_tool_by_code__');
    t.rejectCall(msg.id, 'code failed to compile: Unexpected token');
  }));

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  const handle = registry.handles.get('register_page_tool_by_code')!;
  const result: any = await (handle as any).handler({ name: 'explore', description: 'discovery', code: '((' }, {});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /code failed to compile/);
  assert.equal(t.recentToolRegistrations.length, 0, 'a failed registration must not be logged');
});

test('unregister_page_tool sends a "__unregister_tool__" call and surfaces a non-dynamic-tool rejection as isError', async () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket((msg) => {
    assert.equal(msg.name, '__unregister_tool__');
    assert.deepEqual(msg.args, { toolName: 'get_document' });
    t.rejectCall(msg.id, '"get_document" is not a currently-tracked dynamically-registered tool on this connection (already removed, never dynamic, or a host tool — host tools can never be unregistered remotely)');
  }));

  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  const handle = registry.handles.get('unregister_page_tool')!;
  const result: any = await (handle as any).handler({ toolName: 'get_document' }, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /host tools can never be unregistered/);
});

test('register_page_tool_by_path/by_code/unregister_page_tool report a clear error with no live connection', async () => {
  const t = new Tenant('t1', undefined, {});
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  const byPath: any = await (registry.handles.get('register_page_tool_by_path') as any).handler({ name: 'x', description: 'd', path: 'a.b' }, {});
  assert.equal(byPath.isError, true);
  assert.match(byPath.content[0].text, /No live connection/);

  const byCode: any = await (registry.handles.get('register_page_tool_by_code') as any).handler({ name: 'x', description: 'd', code: 'return 1;' }, {});
  assert.equal(byCode.isError, true);
  assert.match(byCode.content[0].text, /No live connection/);

  const unreg: any = await (registry.handles.get('unregister_page_tool') as any).handler({ toolName: 'x' }, {});
  assert.equal(unreg.isError, true);
  assert.match(unreg.content[0].text, /No live connection/);
});

test('identify_connection reports a clear error with no live connection (same convention, previously untested)', async () => {
  const t = new Tenant('t1', undefined, {});
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();

  const result: any = await (registry.handles.get('identify_connection') as any).handler({}, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No live connection/);
});

test('a same-labeled reconnect gets its dynamic (origin-bearing) tools replayed via register_page_tool_by_code', () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [
    { name: 'insert_title', description: 'host tool', params: {} },
    { name: 'save_note', description: 'dynamic by code', params: {}, source: 'dynamic', origin: { kind: 'code', code: 'return 1;' } },
  ], undefined, 'mypage');

  t.removeConnection('a');

  const calls: any[] = [];
  t.registerConnection('b', fakeSocket((msg) => calls.push(msg)));
  // Simulates the reloaded page's first register_tools: fresh JS runtime,
  // so only its host tool survives — no dynamic tools of its own yet.
  t.updateConnectionManifest('b', [{ name: 'insert_title', description: 'host tool', params: {} }], undefined, 'mypage');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, '__register_tool_by_code__');
  assert.deepEqual(calls[0].args, { name: 'save_note', description: 'dynamic by code', code: 'return 1;' });
});

test('a same-labeled reconnect gets its dynamic (origin-bearing) tools replayed via register_page_tool_by_path', () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [
    { name: 'save_note', description: 'dynamic by path', params: {}, source: 'dynamic', origin: { kind: 'path', path: 'myApp.save' } },
  ], undefined, 'mypage');

  t.removeConnection('a');

  const calls: any[] = [];
  t.registerConnection('b', fakeSocket((msg) => calls.push(msg)));
  t.updateConnectionManifest('b', [], undefined, 'mypage');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, '__register_tool_by_path__');
  assert.deepEqual(calls[0].args, { name: 'save_note', description: 'dynamic by path', path: 'myApp.save' });
});

test('replay is skipped for an unlabeled connection, and for a label still shared by another live connection', () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [
    { name: 'save_note', description: 'dynamic', params: {}, source: 'dynamic', origin: { kind: 'path', path: 'myApp.save' } },
  ]); // no label

  t.removeConnection('a');

  const calls: any[] = [];
  t.registerConnection('b', fakeSocket((msg) => calls.push(msg)));
  t.updateConnectionManifest('b', []); // no label either — nothing to stash under
  assert.equal(calls.length, 0, 'unlabeled connections must not stash/replay dynamic tools');

  // Two live connections sharing a label: closing one should not stash
  // (the label is still ambiguous while the other is live).
  t.registerConnection('c', fakeSocket(() => {}));
  t.updateConnectionManifest('c', [
    { name: 'save_note2', description: 'dynamic', params: {}, source: 'dynamic', origin: { kind: 'path', path: 'myApp.save2' } },
  ], undefined, 'shared');
  t.registerConnection('d', fakeSocket(() => {}));
  t.updateConnectionManifest('d', [], undefined, 'shared');

  t.removeConnection('c');
  const calls2: any[] = [];
  t.registerConnection('e', fakeSocket((msg) => calls2.push(msg)));
  t.updateConnectionManifest('e', [], undefined, 'shared');
  assert.equal(calls2.length, 0, 'a label still in use by another live connection must not stash/replay');
});

test('replaying a dynamic tool consumes the stash so a later reconnect under the same label is not replayed twice', () => {
  const t = new Tenant('t1', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}));
  t.updateConnectionManifest('a', [
    { name: 'save_note', description: 'dynamic', params: {}, source: 'dynamic', origin: { kind: 'path', path: 'myApp.save' } },
  ], undefined, 'mypage');
  t.removeConnection('a');

  const calls: any[] = [];
  t.registerConnection('b', fakeSocket((msg) => calls.push(msg)));
  t.updateConnectionManifest('b', [], undefined, 'mypage');
  assert.equal(calls.length, 1);

  t.removeConnection('b');
  t.registerConnection('c', fakeSocket((msg) => calls.push(msg)));
  t.updateConnectionManifest('c', [], undefined, 'mypage');
  assert.equal(calls.length, 1, 'stash should have been consumed by the first replay, nothing left for a second reconnect');
});
