# Session-Based Multi-Tenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single shared `formDef`/`Store`/`submitBus` globals in `server.js` into per-MCP-session ("tenant") state, so multiple agents/users can talk to the same deployed process concurrently without seeing each other's form data, and correlate each tenant's browser tab via a tenant-scoped URL.

**Architecture:** Introduce a `Tenant` class that bundles what is currently global (`formDef`, `Store` instance, `submitBus`, and the set of WebSocket clients watching it). Keep a `Map<tenantId, Tenant>` keyed by the MCP session id (we generate this id ourselves via `randomUUID()` *before* creating the `StreamableHTTPServerTransport`, so it's known immediately and reused as the transport's `sessionIdGenerator` output). `get_form_url` returns `http://host:port/t/<tenantId>`; the browser reads the tenant id out of `location.pathname` and connects to `/ws?tenant=<tenantId>`. The WS handler and all broadcast helpers become tenant-scoped methods instead of iterating `wss.clients` globally. A `tenant=default` fallback preserves today's zero-config manual-testing workflow (opening `http://localhost:8765/` directly, no MCP session). Tenant state is disposed when its MCP session closes (`transport.onclose`).

**Tech Stack:** Node.js (`node:http`, `node:crypto`, `node:test`, `node:assert`), `ws`, `zod`, `@modelcontextprotocol/sdk` (server *and* client, for integration tests).

---

## Design decisions locked in by this plan

1. **Tenant id = MCP session id.** We generate the id ourselves with `randomUUID()` before constructing `StreamableHTTPServerTransport`, and pass `sessionIdGenerator: () => tenantId`. This means the id used in the `mcp-session-id` HTTP header is exactly the same value used as the tenant map key and embedded in the form URL — one identifier, no translation layer.
2. **Browser correlation via URL path, not cookies.** `get_form_url` returns `/t/<tenantId>`; the static file handler serves `public/index.html` for that path; the page's client-side JS extracts the id from `location.pathname` and appends it as a `?tenant=` query param on the WebSocket URL. This avoids needing cookies/CORS credential plumbing for a page that may be opened in an incognito tab or a different browser than the one running the agent's chat UI.
3. **Backward-compatible default tenant.** Visiting `/` (no `/t/<id>`) or connecting to `/ws` with no `tenant` query param maps to a fixed `'default'` tenant id, created eagerly at startup exactly like today's module-level globals. This keeps `node server.js` + open `http://localhost:8765` working with zero MCP client involved, for manual testing.
4. **Cleanup on session close.** `transport.onclose` already exists and removes the entry from the `sessions` map — extend it to also call `tenant.dispose()` (closes tenant's WS sockets, clears store subscribers and submit-bus listeners) and delete the tenant from the `tenants` map, so long-running deployments don't leak memory per closed session.
5. **No new dependencies.** Tests use Node's built-in `node:test` + `node:assert/strict` (Node 22 is in use — confirmed via `node -e "console.log(process.version)"` -> `v22.12.0`), and the already-installed `@modelcontextprotocol/sdk` client transport (`Client` + `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/*`, confirmed present in `node_modules/@modelcontextprotocol/sdk/dist/esm/client/`) to drive real MCP sessions against a real server process in integration tests.
6. **Out of scope for this plan:** auth/token-per-tenant, horizontal scaling across multiple processes (Redis pub/sub etc.), and per-tenant upload directories/quotas. These were flagged in the earlier discussion as follow-on hardening steps, not required to prove out session-based isolation.

---

## File Structure

- **Modify: `server.js`** — replace module-level `formDef`/`store`/`submitBus`/broadcast functions with a `Tenant` class and a `tenants` Map; thread `tenantId` through `buildMcpServer(tenantId)` and all its tool closures; update the HTTP handler to generate the tenant id up front, serve `/t/:id`, and route `/ws` by `?tenant=` query param; update `transport.onclose` to dispose tenants.
- **Modify: `public/index.html`** — WebSocket connect logic reads a tenant id from `location.pathname` and appends it to the `/ws` URL.
- **Create: `test/tenant-isolation.test.js`** — integration tests spawning the real server (via `child_process.spawn('node', ['server.js'])` on a scratch port) and driving two independent MCP client sessions plus raw WebSocket connections to prove isolation and cleanup.
- **Modify: `package.json`** — add a `"test": "node --test"` script.

---

### Task 1: Add the `Tenant` class and tenant registry

**Files:**
- Modify: `server.js:24-93` (replace the "mutable form definition", "Store", "submit bus", and "helpers to rebuild the form" sections)

- [ ] **Step 1: Write the failing test**

Create `test/tenant-isolation.test.js` with the first test, which starts the server on a scratch port and asserts that two separate MCP `initialize` calls receive two different `mcp-session-id` values (this alone doesn't require the `Tenant` class yet, but pins down the harness we'll reuse for every later test in this plan):

```javascript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 8901;
const BASE_URL = `http://localhost:${PORT}`;
let serverProcess;

before(async () => {
  serverProcess = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
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
  serverProcess.kill();
});

async function connectClient() {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE_URL));
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
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
```

- [ ] **Step 2: Run test to verify it fails (or passes trivially, confirming harness works)**

Run: `node --test test/tenant-isolation.test.js`
Expected: PASS — this test only exercises existing behavior (session ids are already unique per the SDK's default `randomUUID` generator), so it should already pass. This confirms the spawn/connect harness works before we build on it in later tasks with tests that *do* currently fail.

- [ ] **Step 3: Implement the `Tenant` class and registry in `server.js`**

Replace the block from `// 1. Mutable form definition...` through the end of `broadcastUpdate` (server.js lines 18-93) with:

```javascript
// ---------------------------------------------------------------------------
// 1. Tenant -- bundles the form definition, store, submit bus, and connected
//    WebSocket clients for one MCP session (or the 'default' tenant used by
//    plain browser access with no MCP session involved).
// ---------------------------------------------------------------------------
const initialConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config', 'fields.json'), 'utf-8')
);

class Store {
  #values = new Map();
  #subscribers = new Set();

  constructor(fieldConfigs) {
    for (const f of fieldConfigs) {
      if (f.type === 'html_output') continue;
      this.#values.set(f.name, f.default ?? '');
    }
  }

  has(name) { return this.#values.has(name); }
  get(name) { return this.#values.get(name); }

  set(name, value) {
    this.#values.set(name, value);
    for (const fn of this.#subscribers) fn(name, value);
  }

  snapshot() { return Object.fromEntries(this.#values); }

  onChange(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  dispose() { this.#subscribers.clear(); }
}

class Tenant {
  constructor(id) {
    this.id = id;
    this.formDef = { title: initialConfig.title ?? '', fields: initialConfig.fields };
    this.store = new Store(this.formDef.fields);
    this.submitBus = new EventEmitter();
    this.submitBus.setMaxListeners(0);
    this.wsClients = new Set();
    this.store.onChange((field, value) => this.broadcastUpdate(field, value));
  }

  applyFormDef(def) {
    this.store.dispose();
    this.formDef = def;
    this.store = new Store(this.formDef.fields);
    this.store.onChange((field, value) => this.broadcastUpdate(field, value));
    this.broadcastReinit();
  }

  broadcastReinit() {
    const payload = JSON.stringify({ type: 'reinit', formDef: this.formDef, state: this.store.snapshot() });
    for (const client of this.wsClients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  broadcastUpdate(field, value) {
    const payload = JSON.stringify({ type: 'update', field, value });
    for (const client of this.wsClients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  dispose() {
    this.store.dispose();
    this.submitBus.removeAllListeners();
    for (const client of this.wsClients) client.close();
    this.wsClients.clear();
  }
}

const tenants = new Map();

function getOrCreateTenant(id) {
  let tenant = tenants.get(id);
  if (!tenant) {
    tenant = new Tenant(id);
    tenants.set(id, tenant);
  }
  return tenant;
}

// The 'default' tenant backs plain browser access (no MCP session), so
// `node server.js` + opening http://localhost:PORT keeps working standalone.
getOrCreateTenant('default');
```

- [ ] **Step 4: Run the test again to confirm nothing broke**

Run: `node --test test/tenant-isolation.test.js`
Expected: PASS (server still starts -- `Tenant`/`tenants` are additive so far; nothing references them yet outside this block, so the file should still load without errors). If it fails to start, check `node server.js` output directly (`PORT=8901 node server.js`) for a stack trace.

- [ ] **Step 5: Commit**

```bash
git add server.js test/tenant-isolation.test.js
git commit -m "feat: introduce Tenant class and registry alongside existing globals"
```

---

### Task 2: Thread `tenantId` through the MCP tool server and wire up per-tenant HTTP sessions

**Files:**
- Modify: `server.js` (HTTP `/mcp` handler, `buildMcpServer` signature and every tool handler that currently references the old global `formDef`/`store`/`submitBus`)

- [ ] **Step 1: Write the failing test**

Add to `test/tenant-isolation.test.js` -- this proves two MCP sessions have isolated field values (will fail until Step 3 is done, because right now all tool calls still hit the single old global store):

```javascript
test('two MCP sessions have isolated field values', async () => {
  const a = await connectClient();
  const b = await connectClient();

  await a.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }] },
  });
  await b.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }] },
  });

  await a.client.callTool({ name: 'set_field', arguments: { field: 'note', value: 'from A' } });
  await b.client.callTool({ name: 'set_field', arguments: { field: 'note', value: 'from B' } });

  const aResult = await a.client.callTool({ name: 'get_field', arguments: { field: 'note' } });
  const bResult = await b.client.callTool({ name: 'get_field', arguments: { field: 'note' } });

  assert.equal(aResult.content[0].text, 'from A');
  assert.equal(bResult.content[0].text, 'from B');

  await a.client.close();
  await b.client.close();
});

test('get_form_url returns a tenant-scoped URL containing the session id', async () => {
  const a = await connectClient();
  const result = await a.client.callTool({ name: 'get_form_url', arguments: {} });
  assert.equal(result.content[0].text, `${BASE_URL}/t/${a.transport.sessionId}`);
  await a.client.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tenant-isolation.test.js`
Expected: FAIL on `'two MCP sessions have isolated field values'` -- both sessions currently read/write the same global `store`, so `aResult.content[0].text` will be `'from B'` (last writer wins) instead of `'from A'`. The `get_form_url` test also fails since it still returns the bare `BASE_URL`.

- [ ] **Step 3: Implement -- generate tenant id up front, pass it into `buildMcpServer`, rewrite tool bodies**

In the `/mcp` HTTP handler (server.js, inside the `if (req.method === 'POST' && !sessionId)` block), generate the id ourselves so it's available before the transport even starts, and pass it to `buildMcpServer`:

```javascript
    if (req.method === 'POST' && !sessionId) {
      const tenantId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => tenantId,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          getOrCreateTenant(id);
          console.error(`[mcp] session opened: ${id}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          tenants.get(transport.sessionId)?.dispose();
          tenants.delete(transport.sessionId);
          console.error(`[mcp] session closed: ${transport.sessionId}`);
        }
      };
      const mcpInstance = buildMcpServer(tenantId);
      await mcpInstance.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
```

Change `function buildMcpServer() {` to `function buildMcpServer(tenantId) {` and, at the top of the function body, add a helper to fetch the live tenant on every tool call (never cache it -- `applyFormDef` replaces `tenant.store`, so a stale reference would silently write to a discarded store):

```javascript
function buildMcpServer(tenantId) {
  const mcp = new McpServer({ name: 'mcp-form-demo', version: '0.2.0' });
  const tenant = () => tenants.get(tenantId) ?? getOrCreateTenant(tenantId);
```

Now update each tool body to go through `tenant()` instead of the old globals:

`get_form_url`:
```javascript
  mcp.tool(
    'get_form_url',
    'Returns the URL of the live browser form UI (e.g. http://localhost:8765/t/<id>). ' +
    'Call this and share the URL with the user whenever you are about to collect input via define_form, ' +
    'so they know where to open the form before you call wait_for_submit.',
    {},
    async () => ({
      content: [{ type: 'text', text: `http://localhost:${PORT}/t/${tenantId}` }],
    })
  );
```

`define_form` -- replace the two calls to the old globals with `tenant()` calls:
```javascript
    async ({ title, fields, wait }) => {
      tenant().applyFormDef({ title: title ?? '', fields });
      if (wait) {
        const raw = await new Promise((resolve) => {
          tenant().submitBus.once('submit', resolve);
        });
        const { __interrupted, ...values } = raw;
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: __interrupted ? 'interrupted' : 'submitted', values }, null, 2) }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Form updated with ${fields.length} field(s). Call wait_for_submit to wait for the user.`,
        }],
      };
    }
```

`wait_for_submit`:
```javascript
    async () => {
      const raw = await new Promise((resolve) => {
        tenant().submitBus.once('submit', resolve);
      });
      const { __interrupted, ...values } = raw;
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: __interrupted ? 'interrupted' : 'submitted', values }, null, 2) }],
      };
    }
```

`list_fields`:
```javascript
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify(
          tenant().formDef.fields.map((f) => f.type === 'html_output'
            ? { name: f.name, type: 'html_output' }
            : { ...f, value: tenant().store.get(f.name) }
          ),
          null, 2
        ),
      }],
    })
```

`get_field`:
```javascript
    async ({ field }) => {
      const t = tenant();
      if (!t.store.has(field)) {
        return { content: [{ type: 'text', text: `Error: field "${field}" does not exist in the current form` }], isError: true };
      }
      return { content: [{ type: 'text', text: String(t.store.get(field)) }] };
    }
```

`set_field`:
```javascript
    async ({ field, value }) => {
      const t = tenant();
      if (!t.store.has(field)) {
        return { content: [{ type: 'text', text: `Error: field "${field}" does not exist in the current form` }], isError: true };
      }
      t.store.set(field, value);
      return { content: [{ type: 'text', text: `${field} = ${value}` }] };
    }
```

Finally, delete the now-unused startup wiring line `store.onChange((field, value) => broadcastUpdate(field, value));` (this behavior moved into `Tenant`'s constructor/`applyFormDef`) and the old top-level `broadcastReinit`/`broadcastUpdate` functions and `formDef`/`store`/`submitBus` top-level `let`/`const` declarations, since `Tenant` now owns all of that (they should already be gone from Task 1's Step 3 replacement -- this step is a final sweep to make sure no leftover references remain; search with `grep -n "^let formDef\|^let store\|^const submitBus" server.js` and confirm no matches).

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `node --test test/tenant-isolation.test.js`
Expected: PASS -- all three tests green.

- [ ] **Step 5: Commit**

```bash
git add server.js test/tenant-isolation.test.js
git commit -m "feat: scope MCP tool handlers to per-session tenant state"
```

---

### Task 3: Route `/t/:tenantId` and `/ws?tenant=` on the HTTP/WebSocket server

**Files:**
- Modify: `server.js` (static file handler, `WebSocketServer` connection handler)

- [ ] **Step 1: Write the failing test**

Add to `test/tenant-isolation.test.js` -- verifies WS broadcasts are tenant-scoped (a change in tenant A's store must not reach a WS client connected with tenant B's id):

```javascript
import { WebSocket } from 'ws';

function connectWs(tenantId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?tenant=${tenantId}`);
    const messages = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

test('WebSocket broadcasts are scoped to the connecting tenant', async () => {
  const a = await connectClient();
  const b = await connectClient();

  await a.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }] },
  });
  await b.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }] },
  });

  const wsA = await connectWs(a.transport.sessionId);
  const wsB = await connectWs(b.transport.sessionId);

  await a.client.callTool({ name: 'set_field', arguments: { field: 'note', value: 'hello from A' } });
  await new Promise((r) => setTimeout(r, 200)); // let the broadcast land

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
  const res = await fetch(`${BASE_URL}/t/${a.transport.sessionId}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<html/i);
  await a.client.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tenant-isolation.test.js`
Expected: FAIL -- `/ws?tenant=` is not parsed yet (both WS clients currently join the same global broadcast, or the tenant-scoped `Tenant.wsClients` set added in Task 1 is never populated because nothing registers connections into it yet), and `/t/:tenantId` currently 404s since the static file handler only recognizes exact file paths.

- [ ] **Step 3: Implement routing**

In the static-file section of the HTTP handler (server.js, the block starting `let filePath = url.pathname === '/' ? '/index.html' : url.pathname;`), add a `/t/:id` rewrite before it:

```javascript
  let pathname = url.pathname;
  if (pathname.startsWith('/t/')) {
    pathname = '/'; // serve the same SPA shell; the tenant id lives in the URL for the client JS to read
  }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, 'public', filePath);
```

(This replaces the existing two lines that computed `filePath` directly from `url.pathname`.)

Update the `WebSocketServer` connection handler to resolve the tenant from the query string and register/unregister the socket on that tenant's `wsClients` set:

```javascript
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const wsUrl = new URL(req.url, `http://localhost:${PORT}`);
  const tenantId = wsUrl.searchParams.get('tenant') || 'default';
  const t = getOrCreateTenant(tenantId);

  t.wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'init', formDef: t.formDef, state: t.store.snapshot() }));

  ws.on('close', () => t.wsClients.delete(ws));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'set' && t.store.has(msg.field)) {
      t.store.set(msg.field, msg.value);
    }

    if (msg.type === 'submit') {
      t.submitBus.emit('submit', { __interrupted: false, ...t.store.snapshot() });
    }

    if (msg.type === 'interrupt') {
      t.submitBus.emit('submit', { __interrupted: true, ...t.store.snapshot() });
    }
  });
});
```

Remove the leftover top-level `store.onChange(...)` startup line if it's still present (it should already be gone -- see Task 2 Step 3's final sweep note).

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `node --test test/tenant-isolation.test.js`
Expected: PASS -- all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add server.js test/tenant-isolation.test.js
git commit -m "feat: route /t/:tenantId and /ws?tenant= to per-tenant state"
```

---

### Task 4: Client-side tenant id correlation in `public/index.html`

**Files:**
- Modify: `public/index.html:417` (the `_connect()` method)

- [ ] **Step 1: Write the failing test**

Add to `test/tenant-isolation.test.js` -- an end-to-end check that opening `/t/:id` and letting the page's own JS connect actually joins the right tenant room. Since we don't have a browser automation tool wired into this test file, we approximate "the page's WS logic is correct" by asserting the client-side JS contains the tenant-id-parsing snippet:

```javascript
test('index.html connects its WebSocket using the tenant id from the URL path', async () => {
  const res = await fetch(`${BASE_URL}/t/some-tenant-id`);
  const html = await res.text();
  assert.match(
    html,
    /location\.pathname\.split\(['"]\/['"]\)/,
    'expected client-side JS to parse the tenant id out of location.pathname'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tenant-isolation.test.js`
Expected: FAIL -- `public/index.html` doesn't yet contain any `location.pathname` parsing logic.

- [ ] **Step 3: Implement**

In `public/index.html`, replace the `_connect()` method's WebSocket URL construction:

```javascript
      _connect() {
        const pathParts = location.pathname.split('/').filter(Boolean);
        const tenantId = pathParts[0] === 't' && pathParts[1] ? pathParts[1] : null;
        const wsUrl = tenantId
          ? `ws://${location.host}/ws?tenant=${encodeURIComponent(tenantId)}`
          : `ws://${location.host}/ws`;
        const ws = new WebSocket(wsUrl);
        this._ws = ws;
        ws.onopen  = () => { this._connected = true; };
        ws.onclose = () => {
          this._connected = false;
          // simple reconnect after 2 s
          setTimeout(() => this._connect(), 2000);
        };
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `node --test test/tenant-isolation.test.js`
Expected: PASS -- all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add public/index.html test/tenant-isolation.test.js
git commit -m "feat: parse tenant id from URL path in browser WebSocket client"
```

---

### Task 5: Session close cleans up tenant state

**Files:**
- Modify: none (this task only verifies behavior already implemented in Task 2 Step 3's `transport.onclose` update)
- Test: `test/tenant-isolation.test.js`

- [ ] **Step 1: Write the test**

```javascript
test('closing an MCP session disposes its tenant and closes its WebSocket clients', async () => {
  const a = await connectClient();
  await a.client.callTool({
    name: 'define_form',
    arguments: { fields: [{ name: 'note', label: 'Note', type: 'text', default: '' }] },
  });
  const tenantId = a.transport.sessionId;
  const wsA = await connectWs(tenantId);

  const closed = new Promise((resolve) => wsA.ws.on('close', resolve));
  await a.client.close(); // triggers DELETE /mcp session -> transport.onclose -> tenant.dispose()

  await closed; // the tenant's WS clients should be force-closed by dispose()
  assert.equal(wsA.ws.readyState, WebSocket.CLOSED);
});
```

- [ ] **Step 2: Run test to verify it passes (this behavior was already built in Task 2)**

Run: `node --test test/tenant-isolation.test.js`
Expected: PASS. If it fails, double check `transport.onclose` in server.js calls `tenants.get(transport.sessionId)?.dispose()` (added in Task 2 Step 3) -- this is the one place cleanup happens, so a failure here means that line was missed or removed.

- [ ] **Step 3: Commit**

```bash
git add test/tenant-isolation.test.js
git commit -m "test: verify tenant disposal on MCP session close"
```

---

### Task 6: Wire up `npm test` and do a final manual smoke check

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the test script**

```json
{
  "name": "mcp-form-demo",
  "version": "0.1.0",
  "type": "module",
  "description": "Tiny Lit web component with a signal-backed text field, synced live to an MCP server so an agent can read/write it.",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "stop": "kill -9 $(lsof -ti :${PORT:-8765}) 2>/dev/null && echo 'Server stopped' || echo 'No server running'",
    "test": "node --test test/"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  }
}
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: All 8 tests pass (the harness's `before`/`after` start and stop one server process shared across the whole file).

- [ ] **Step 3: Manual smoke check of the backward-compatible default tenant**

Run: `PORT=8902 node server.js &` then open `http://localhost:8902` in a browser -- confirm the form still renders and live-updates exactly as before, with no `/t/` prefix and no MCP session involved (this exercises the `'default'` tenant fallback from Task 3). Stop the server: `kill %1` or `npm run stop` with `PORT=8902`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add npm test script for tenant isolation suite"
```

---

### Task 7: Idle-timeout-based tenant cleanup (follow-up, added after initial review)

**Why:** Tasks 1-6 only dispose a tenant when its MCP session is explicitly terminated (`DELETE /mcp` or `transport.onclose` firing from an actual close/error). If a client (e.g. a chat agent) simply goes quiet -- the user navigates away, the process is killed, the network drops -- without ever sending a graceful termination, the tenant (and its `Store`, `EventEmitter` listeners, and any lingering WS clients) stays in the `tenants` map forever. This is a real memory leak for any long-running deployment. This task adds a periodic idle sweep that disposes tenants which have seen no activity for longer than a configurable TTL, independent of whether the underlying MCP transport ever signals closure.

**Files:**
- Modify: `server.js` (`Tenant` class gains activity tracking; add a periodic sweep; touch activity on every tool call and WS message)
- Test: `test/tenant-isolation.test.js` (append)

- [ ] **Step 1: Write the failing test**

Add to `test/tenant-isolation.test.js`. Since real-world TTLs (e.g. 30 minutes) are too slow to test directly, the sweep interval and idle TTL must be configurable via environment variables so tests can use tiny values. Add a test that spawns a SEPARATE server instance (on its own port) with a very short TTL/sweep interval, creates a tenant, waits past the TTL, and confirms the tenant's WS client gets force-closed (proving the sweep ran and disposed it) -- without ever sending an explicit `DELETE /mcp`:

```javascript
test('idle tenants are automatically disposed after a TTL, even without explicit session close', async () => {
  const idlePort = 8906;
  const idleServerProcess = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(idlePort),
      TENANT_IDLE_TIMEOUT_MS: '300',
      TENANT_SWEEP_INTERVAL_MS: '100',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    const idleBaseUrl = `http://localhost:${idlePort}`;
    for (let i = 0; i < 50; i++) {
      try { await fetch(idleBaseUrl); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }

    const transport = new StreamableHTTPClientTransport(new URL('/mcp', idleBaseUrl));
    const client = new Client({ name: 'idle-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const tenantId = transport.sessionId;

    const ws = new WebSocket(`ws://localhost:${idlePort}/ws?tenant=${tenantId}`);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    // Do NOT call client.close() / terminateSession() -- simulate an abandoned session.
    // Just wait past the idle TTL + at least one sweep interval.
    const closed = new Promise((resolve) => ws.on('close', resolve));
    await closed;
    assert.equal(ws.readyState, WebSocket.CLOSED);
  } finally {
    idleServerProcess.kill();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tenant-isolation.test.js`
Expected: FAIL (or hang/timeout) -- no sweep mechanism exists yet, so the WS connection never closes on its own.

- [ ] **Step 3: Implement activity tracking + periodic sweep**

In the `Tenant` class, add a `lastActivityAt` field and a `touch()` method:

```javascript
class Tenant {
  constructor(id) {
    this.id = id;
    this.formDef = { title: initialConfig.title ?? '', fields: initialConfig.fields };
    this.store = new Store(this.formDef.fields);
    this.submitBus = new EventEmitter();
    this.submitBus.setMaxListeners(0);
    this.wsClients = new Set();
    this.lastActivityAt = Date.now();
    this.store.onChange((field, value) => this.broadcastUpdate(field, value));
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  // ...applyFormDef/broadcastReinit/broadcastUpdate/dispose unchanged...
}
```

Call `.touch()` in two places:
1. Inside `buildMcpServer`'s `tenant()` accessor, so every MCP tool invocation counts as activity:
   ```javascript
   const tenant = () => {
     const t = tenants.get(tenantId) ?? getOrCreateTenant(tenantId);
     t.touch();
     return t;
   };
   ```
2. Inside the WebSocketServer `message` handler, so live form interaction counts as activity (add `t.touch();` as the first line inside `ws.on('message', (raw) => { ... })`, before the existing `JSON.parse` logic).

Add the sweep itself near where `tenants`/`getOrCreateTenant` are defined:

```javascript
const TENANT_IDLE_TIMEOUT_MS = process.env.TENANT_IDLE_TIMEOUT_MS
  ? Number(process.env.TENANT_IDLE_TIMEOUT_MS)
  : 30 * 60 * 1000; // 30 minutes default
const TENANT_SWEEP_INTERVAL_MS = process.env.TENANT_SWEEP_INTERVAL_MS
  ? Number(process.env.TENANT_SWEEP_INTERVAL_MS)
  : 5 * 60 * 1000; // 5 minutes default

function disposeTenant(id) {
  const transport = sessions.get(id);
  if (transport) {
    // Reuse the existing transport.onclose cleanup path (disposes tenant,
    // removes from both maps) instead of duplicating that logic here.
    transport.close();
  } else {
    tenants.get(id)?.dispose();
    tenants.delete(id);
  }
}

const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, tenant] of tenants) {
    if (id === 'default') continue; // never sweep the shared manual-testing tenant
    if (now - tenant.lastActivityAt > TENANT_IDLE_TIMEOUT_MS) {
      console.error(`[mcp] sweeping idle tenant: ${id}`);
      disposeTenant(id);
    }
  }
}, TENANT_SWEEP_INTERVAL_MS);
sweepInterval.unref(); // don't keep the process alive solely for this timer
```

Note: `disposeTenant`'s `sessions.get(id)` branch relies on `sessions`/`tenants` being declared before this code runs (they already are, per Tasks 1-2) -- and on `transport.close()` triggering the existing `onclose` handler synchronously-enough for the sweep's own bookkeeping to stay simple (it does not need to await anything here; `onclose` firing asynchronously is fine since the sweep's job is just to kick off disposal, not wait for it).

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `node --test test/tenant-isolation.test.js`
Expected: PASS -- all tests green, including the new idle-sweep test (which should take a bit over 300ms to complete given the test's configured TTL/interval, not real minutes).

- [ ] **Step 5 (SKIP THE GIT COMMIT):**

No commit step -- per this plan's execution constraint (user reviews and commits manually).

---

## Self-Review Notes

- **Spec coverage:** MCP-session-id-as-tenant-id (Task 2), tenant-scoped `get_form_url` (Task 2), tenant-scoped WS broadcast (Task 3), browser correlation via URL (Task 4), cleanup on session close (Task 5), backward-compatible default tenant (Task 3) -- all covered.
- **Explicitly out of scope, not silently dropped:** auth/tokens, multi-process/horizontal scaling, per-tenant upload quotas -- called out in "Design decisions" section 6 so the next planning pass knows where this plan's boundary is.
- **Type/signature consistency check:** `buildMcpServer(tenantId)` is called once with the tenant id, all tool closures use the same `tenant()` accessor function name and the same `Tenant` property names (`formDef`, `store`, `submitBus`, `wsClients`, `applyFormDef`, `broadcastUpdate`, `broadcastReinit`, `dispose`) introduced in Task 1 -- verified no task renames these later.
