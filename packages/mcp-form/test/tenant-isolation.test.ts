import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';

const PORT = 8901;
const BASE_URL = `http://localhost:${PORT}`;
let serverProcess: ChildProcess;
// A dedicated, throwaway persistence file per test run — without this the
// server would default to a fixed path keyed only by PORT (see
// MCP_FORM_PERSIST_FILE in server.ts), so tenant state from one run (e.g.
// "unit-test-resync-restores-state") would leak into the next and break
// assertions that expect a channel to be genuinely new.
const PERSIST_FILE = path.join(os.tmpdir(), `mcp-form-test-state-${randomUUID()}.json`);

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
  // `detached: true` makes this the leader of its own process group, so
  // `process.kill(-pid)` below can reach the real tsx/node process too —
  // `npx` spawns tsx as a child of itself, and plain `serverProcess.kill()`
  // only ever signals the npx wrapper, leaving the actual server (still
  // holding the port open) running as an orphan after the test file exits.
  serverProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), MCP_FORM_PERSIST_FILE: PERSIST_FILE },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
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
  if (serverProcess.pid) {
    try { process.kill(-serverProcess.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  fs.rmSync(PERSIST_FILE, { force: true });
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
  const previousPersistFile = process.env.MCP_FORM_PERSIST_FILE;
  let importedServer: Server | undefined;
  process.env.PORT = String(port);
  // Scoped to this test so it doesn't read/write the fixed
  // os.tmpdir()/mcp-form-state/tenants-8905.json path a real server would
  // default to — a leftover 'unit-test-tenant-a'/'unit-test-tenant-b' from
  // a prior run would otherwise make `getOrCreateTenant` return persisted
  // state instead of the fresh tenant this test expects.
  const testPersistFile = path.join(os.tmpdir(), `mcp-form-test-state-${randomUUID()}.json`);
  process.env.MCP_FORM_PERSIST_FILE = testPersistFile;

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
    if (previousPersistFile === undefined) delete process.env.MCP_FORM_PERSIST_FILE;
    else process.env.MCP_FORM_PERSIST_FILE = previousPersistFile;
    fs.rmSync(testPersistFile, { force: true });
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

  // Under defaultTenantMode: 'shared' (see server.ts), an unnamed session
  // would land on its own root connection (isolated already, just unnamed)
  // — joining a real channel here is what makes the two sessions share a
  // single, explicitly-named Tenant so the isolation being tested is
  // between the two *channels*, not an incidental side effect of each
  // being a distinct root connection.
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

test('get_form_url returns a root connection URL for a session that never joined a channel', async () => {
  const a = await connectClient();
  const result = await a.client.callTool({ name: 'get_form_url', arguments: {} });
  // mcp-form runs with defaultTenantMode: 'shared' (see server.ts) — an
  // unnamed session lands on a root connection named after the server's own
  // identity (Tenant id `root:mcp-form`, see getOrCreateRootTenant in
  // mcp-tenant-lib/src/http.ts), not a private per-session UUID and not the
  // old shared 'default' tenant (retired). Naming a channel via join_channel
  // is what gets a session its own distinct URL (see the "Pets" scenario
  // test below).
  //
  // Each unnamed session reserves its OWN root connection rather than
  // sharing one (see reserveRootName/getOrCreateRootTenant) — collisions on
  // the exact name "mcp-form" bump to "mcp-form2", "mcp-form3", etc, so with
  // other unnamed-session tests in this same file also claiming that name
  // pool, only the pattern (not the literal "root:mcp-form") is guaranteed
  // here.
  assert.match(textOf(result), /^http:\/\/localhost:8901\/t\/root:mcp-form\d*$/);
  await a.client.close();
});

test('join_channel gives a session its own URL, distinct from the shared root connection', async () => {
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

  // Each session must join its own channel first so there's a real, named
  // Tenant for the WS connections below to attach to by id.
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

  // `channel:conn` syntax (a colon) connects to the real named channel —
  // a bare `?tenant=unit-test-ws-scope-a` would instead mean a brand-new
  // ROOT connection (its own separate Tenant, per ws.ts), which would NOT
  // be the same Tenant that define_form above just wrote to.
  const wsA = await connectWs('unit-test-ws-scope-a:conn');
  const wsB = await connectWs('unit-test-ws-scope-b:conn');

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

test('WebSocket connection with a bare, unknown tenant name gets its own fresh root connection, not a shared default', { timeout: 5000 }, async () => {
  // A bare `?tenant=<name>` (no colon) is a ROOT connection (see ws.ts): its
  // own single-connection Tenant, keyed internally as `root:<name>`, always
  // freshly minted rather than looked up/recreated — there is no shared
  // 'default' tenant to silently fall back to anymore.
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=this-tenant-does-not-exist-yet`);
  const initMsg: any = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for an "init" message on the root connection')), 1000);
    ws.on('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString())); });
    ws.on('error', reject);
  });
  // A real, freshly-minted root connection (not a rejection, and not
  // silently joined to any shared tenant) responds with its own fresh init
  // state. Root connections are always newly created, never a reconnect to
  // an existing one, so `recreated` is always false here (contrast with the
  // "resync ... after a recreated tenant" test below, which uses a real
  // named channel where `recreated: true` is meaningful).
  assert.equal(initMsg.type, 'init');
  assert.equal(initMsg.recreated, false);
  ws.close();
});

test('a "resync" pushed from the browser after a recreated tenant restores schema/values/submitted', { timeout: 5000 }, async () => {
  // Verified purely over the WS wire against the spawned server subprocess
  // (see `before()`) rather than via an in-process `import('../src/server.js')`
  // — that import would construct an entirely separate `tenants` map living
  // in this test process, not the one the WS connection below actually
  // talks to (see the `getOrCreateTenant returns independent tenants...`
  // test above for that in-process pattern used correctly, on its own port).
  //
  // Uses `channel:conn` syntax to connect to a real, addressable named
  // channel — a bare `?tenant=<name>` would instead be a ROOT connection,
  // which is always freshly minted (never a `recreated: true` reconnect, see
  // the test above), so it couldn't exercise `recreated`/restoreState here.
  const channel = 'unit-test-resync-restores-state';
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=${channel}:conn`);
  const messages: any[] = [];
  const initMsg: any = await new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === 'init') resolve(msg);
    });
    ws.on('error', reject);
  });

  // First connection to a brand-new channel: still reported `recreated`
  // (it never existed), but there's nothing to push back — this mirrors
  // the client's own `this._fields.length > 0` guard, exercised here
  // directly against the server's resync handling instead of the guard.
  assert.equal(initMsg.recreated, true);

  const schema = { title: 'Recovered form', fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }] };
  const reinitPromise = new Promise<any>((resolve) => {
    const onMessage = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'reinit') { ws.off('message', onMessage); resolve(msg); }
    };
    ws.on('message', onMessage);
  });
  ws.send(JSON.stringify({ type: 'resync', schema, values: { note: 'recovered value' }, submitted: true, changedAt: Date.now() }));

  // restoreState broadcasts `reinit` (including back to the sender) once
  // the resync is applied — waiting for it confirms the server actually
  // processed the resync rather than guessing at a fixed delay.
  const reinit = await reinitPromise;
  assert.equal(reinit.schema.title, 'Recovered form');
  assert.equal(reinit.state.note, 'recovered value');
  assert.equal(reinit.submitted, true, 'resync should restore submitted state, not reset it like define_form does');

  ws.close();
});

test('an older resync (stale tab) is ignored once a newer resync (freshly-edited tab) already landed', { timeout: 5000 }, async () => {
  // Simulates two browser tabs on the same channel both reconnecting after
  // a server restart: tab B was edited more recently than tab A, but tab
  // A's resync happens to reach the server first. The stale one (A) must
  // not clobber the fresher one (B) — see Tenant.restoreState. Verified
  // over the wire (see note in the test above re: in-process imports).
  // Uses `channel:conn` syntax for a real named channel — matches the
  // "two tabs on the same channel" scenario this test is modeling (a bare
  // tenant name would instead be a one-off root connection, unaffected by
  // this test's single-connection resync mechanics either way, but the
  // named-channel framing is the accurate one to model here).
  const channel = 'unit-test-resync-favors-freshest';
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=${channel}:conn`);
  const reinits: any[] = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'reinit') reinits.push(msg);
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const schemaA = { title: 'From tab A (stale)', fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }] };
  const schemaB = { title: 'From tab B (fresh)', fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }] };

  const staleChangedAt = Date.now() - 60_000; // tab A: edited a minute ago
  const freshChangedAt = Date.now(); // tab B: edited just now

  // Fresh resync (B) arrives first...
  ws.send(JSON.stringify({ type: 'resync', schema: schemaB, values: { note: 'from B' }, submitted: false, changedAt: freshChangedAt }));
  await new Promise((r) => setTimeout(r, 150));
  // ...then the stale one (A) arrives after it and must be ignored: no
  // second `reinit` should be broadcast for it at all.
  ws.send(JSON.stringify({ type: 'resync', schema: schemaA, values: { note: 'from A' }, submitted: false, changedAt: staleChangedAt }));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(reinits.length, 1, 'the stale resync must not trigger a second reinit broadcast');
  assert.equal(reinits[0].schema.title, 'From tab B (fresh)', 'the stale resync must not overwrite the fresher one');
  assert.equal(reinits[0].state.note, 'from B');

  ws.close();
});

test('WebSocket connection with a channel name containing invalid characters is sanitized and accepted, not rejected', { timeout: 5000 }, async () => {
  // A browser-supplied name (e.g. a human renaming a bridged tab via a
  // plain prompt(), like bulletino's connect flow) has no reason to know
  // mcp-tenant-lib's slug rule — ws.ts now coerces disallowed characters
  // into underscores (sanitizeChannelName) instead of hard-rejecting with
  // 4404, so the connection still succeeds under a close-enough name. See
  // the next test for the one case that's still rejected: a name with
  // NOTHING left after sanitizing.
  //
  // Sanitization/rejection only happens on the CHANNEL part (before a
  // colon) — a bare, colon-less tenant param is a root-connection name and
  // has no reject path at all (an empty/invalid name there just falls back
  // to a default), so `channel:conn` syntax is required to exercise it.
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=${encodeURIComponent('not a valid id!')}:conn`);
  const initMsg: any = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for an "init" message')), 1000);
    ws.on('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString())); });
    ws.on('close', (code) => { clearTimeout(timer); reject(new Error(`connection closed unexpectedly with code ${code}`)); });
    ws.on('error', reject);
  });
  assert.equal(initMsg.type, 'init');
  ws.close();
});

test('WebSocket connection with a channel name that sanitizes to nothing is rejected with 4404', { timeout: 5000 }, async () => {
  // Uses `channel:conn` syntax — see the note in the test above: only the
  // channel part (before a colon) has a reject-on-empty-after-sanitizing
  // path; a bare, colon-less name is a root connection and always succeeds.
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=${encodeURIComponent('!!!')}:conn`);
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
  // `channel:conn` syntax connects to the real named channel `a` joined
  // above — a bare tenant param would instead open an unrelated root
  // connection, which wouldn't prove anything about this channel's clients.
  const wsA = await connectWs(`${channel}:conn`);

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
  const idlePersistFile = path.join(os.tmpdir(), `mcp-form-test-state-${randomUUID()}.json`);
  const idleServerProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(idlePort),
      MCP_FORM_PERSIST_FILE: idlePersistFile,
      TENANT_IDLE_TIMEOUT_MS: '300',
      TENANT_SWEEP_INTERVAL_MS: '100',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
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

    // `channel:conn` syntax attaches to the real per-session Tenant this MCP
    // session landed on (the server here runs with the default
    // defaultTenantMode: 'per-session', so its tenant id is a plain
    // randomUUID(), not a `root:`-prefixed name) — a bare, colon-less
    // tenant param would instead open an unrelated, brand-new root
    // connection, which would defeat the point of testing idle-disposal of
    // *this* session's own tenant.
    const ws = new WebSocket(`ws://localhost:${idlePort}/ws?tenant=${tenantId}:conn`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const closed = new Promise((resolve) => ws.on('close', resolve));
    await closed;
    assert.equal(ws.readyState, WebSocket.CLOSED);
  } finally {
    if (idleServerProcess.pid) {
      try { process.kill(-idleServerProcess.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    fs.rmSync(idlePersistFile, { force: true });
  }
});
