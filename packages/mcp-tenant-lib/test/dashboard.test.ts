import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { WebSocket } from 'ws';
import { Tenant, tenants, getOrCreateTenant } from '../src/tenant.js';
import { getConnectionToolList, buildDashboardSnapshot } from '../src/dashboard.js';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws.js';

test('getConnectionToolList returns undefined for an unknown channel or connection', () => {
  assert.equal(getConnectionToolList('no-such-channel', 'conn1'), undefined);

  const t = new Tenant('t1', undefined, {});
  tenants.set('known-channel', t);
  try {
    assert.equal(getConnectionToolList('known-channel', 'no-such-conn'), undefined);
  } finally {
    tenants.delete('known-channel');
  }
});

test('getConnectionToolList maps a connection\'s manifest, defaulting an absent source to "host"', () => {
  const t = new Tenant('t1', undefined, {});
  tenants.set('known-channel', t);
  const fakeSocket = { readyState: 1, OPEN: 1, send() {} } as any;
  t.registerConnection('conn1', fakeSocket);
  t.updateConnectionManifest('conn1', [
    { name: 'insert_title', description: 'sets title', params: {} },
    { name: 'save_current_note', description: 'saves', params: {}, source: 'dynamic' },
  ]);

  try {
    const tools = getConnectionToolList('known-channel', 'conn1');
    assert.deepEqual(tools, [
      { name: 'insert_title', description: 'sets title', source: 'host', origin: undefined },
      { name: 'save_current_note', description: 'saves', source: 'dynamic', origin: undefined },
    ]);
  } finally {
    tenants.delete('known-channel');
  }
});

test('dashboard REST routes: GET tools list, POST register-by-path/register-by-code, DELETE unregister', async () => {
  const port = 18904;
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
  getOrCreateTenant('dash-test', undefined, {});

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws?tenant=dash-test`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const manifest = [{ name: 'insert_title', description: 'd', params: {} }];
    ws.send(JSON.stringify({ type: 'register_tools', tools: manifest }));
    await new Promise((r) => setTimeout(r, 100));

    const connectionId = [...tenants.get('dash-test')!.connections.keys()][0]!;
    const base = `http://localhost:${port}/api/dashboard/channels/dash-test/connections/${connectionId}`;

    // GET tools list
    const listRes = await fetch(`${base}/tools`);
    assert.equal(listRes.status, 200);
    const listBody: any = await listRes.json();
    assert.deepEqual(listBody.tools, [{ name: 'insert_title', description: 'd', source: 'host' }]);

    // Drive the ws side to always resolve a call successfully, so the REST
    // route's Tenant.call(...) round trip has something to resolve against.
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'call') {
        ws.send(JSON.stringify({ type: 'call_result', id: msg.id, result: `ok:${msg.name}` }));
      }
    });

    // POST register-by-path
    const byPathRes = await fetch(`${base}/tools/register-by-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'save', description: 'saves', path: 'myApp.save' }),
    });
    assert.equal(byPathRes.status, 200);
    const byPathBody: any = await byPathRes.json();
    assert.equal(byPathBody.ok, true);
    assert.equal(byPathBody.result, 'ok:__register_tool_by_path__');

    // POST register-by-code
    const byCodeRes = await fetch(`${base}/tools/register-by-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'explore', description: 'discovery', code: 'return 1;' }),
    });
    assert.equal(byCodeRes.status, 200);
    const byCodeBody: any = await byCodeRes.json();
    assert.equal(byCodeBody.ok, true);
    assert.equal(byCodeBody.result, 'ok:__register_tool_by_code__');

    // POST register-by-path with a missing field -> 400
    const badRes = await fetch(`${base}/tools/register-by-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'save' }),
    });
    assert.equal(badRes.status, 400);

    // DELETE unregister
    const delRes = await fetch(`${base}/tools/save`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const delBody: any = await delRes.json();
    assert.equal(delBody.ok, true);
    assert.equal(delBody.result, 'ok:__unregister_tool__');

    ws.close();
  } finally {
    tenants.get('dash-test')?.dispose();
    tenants.delete('dash-test');
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

test('dashboard REST routes surface a browser-side rejection as 422', async () => {
  const port = 18905;
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
  getOrCreateTenant('dash-test-422', undefined, {});

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws?tenant=dash-test-422`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'register_tools', tools: [] }));
    await new Promise((r) => setTimeout(r, 100));

    const connectionId = [...tenants.get('dash-test-422')!.connections.keys()][0]!;
    const base = `http://localhost:${port}/api/dashboard/channels/dash-test-422/connections/${connectionId}`;

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'call') {
        ws.send(JSON.stringify({ type: 'call_result', id: msg.id, error: 'User declined to register this tool' }));
      }
    });

    const res = await fetch(`${base}/tools/register-by-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', description: 'd', code: 'return 1;' }),
    });
    assert.equal(res.status, 422);
    const body: any = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /User declined to register this tool/);

    ws.close();
  } finally {
    tenants.get('dash-test-422')?.dispose();
    tenants.delete('dash-test-422');
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

test('buildDashboardSnapshot includes recentToolRegistrations, empty by default and populated once logToolRegistration is called', () => {
  const t = new Tenant('t1', undefined, {});
  tenants.set('registrations-channel', t);
  try {
    const before = buildDashboardSnapshot().find((c) => c.channel === 'registrations-channel');
    assert.deepEqual(before?.recentToolRegistrations, []);

    t.logToolRegistration('explore', 'discovery', 'return 1;');
    const after = buildDashboardSnapshot().find((c) => c.channel === 'registrations-channel');
    assert.equal(after?.recentToolRegistrations.length, 1);
    assert.equal(after?.recentToolRegistrations[0]!.name, 'explore');
    assert.equal(after?.recentToolRegistrations[0]!.description, 'discovery');
    assert.equal(after?.recentToolRegistrations[0]!.code, 'return 1;');
  } finally {
    t.dispose();
    tenants.delete('registrations-channel');
  }
});
