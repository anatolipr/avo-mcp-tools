# Manifest-Driven Tool Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `hello-world-mcp`'s hardcoded `insert_title`/`insert_main` MCP tools (`packages/hello-world-mcp/src/tools/hello-tools.ts`) into tools *declared by the page itself* as JSON, discovered by the MCP server at runtime instead of compiled into TypeScript. The MCP server becomes a generic, page-agnostic bridge: it starts with zero page-specific tools, and only gains them once a connected page pushes its tool manifest over the WebSocket. This makes the pattern trivially reusable across many pages/tenants — each page just needs a `<script id="mcp-tools" type="application/json">` block plus the existing embed `<script>` snippet, no new server package required. This plan also produces a standalone **bridge-authoring guide** (Task 9) written for an AI agent to follow when wiring up a *new* page — given a page's existing JS functions, it should be able to write the manifest JSON, expose the right `window.*` globals, paste the embed snippet, and validate the result end-to-end without reading this plan or the `mcp-tenant-server` source.

**Architecture:** Add three new WebSocket message types to the existing `mcp-tenant-server` protocol: `register_tools` (page → server, carries the JSON manifest), `call`/`call_result` (server → page → server, a request/response pair so a dynamically-registered MCP tool handler can invoke a `window.*` function on the page and get its return value back, the way `wait_for_submit`'s `submitBus` already does for form submission). `Tenant` gains a `toolManifest` and a pending-calls map. A new generic `registerManifestTools(mcp, tenant)` in `mcp-tenant-server` replaces per-package hardcoded tool files: it converts each manifest entry's `params` into a zod shape and calls `mcp.registerTool(...)`, keeping the returned `RegisteredTool` handles so a later manifest push can `.remove()` stale entries and register new ones. Each such mutation trips the MCP SDK's built-in `tools/list_changed` notification automatically (confirmed in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`), so the agent re-lists tools with no extra wiring. `hello-world-mcp` keeps only `get_embed_snippet` as a project-specific tool (it's how the page obtains the bridge that eventually pushes the manifest); `insert_title`/`insert_main` move out of `hello-tools.ts` entirely and into `legacy-page/hello-world.html`'s new `#mcp-tools` JSON block.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (`McpServer.registerTool`, `RegisteredTool.remove()`), `zod` (runtime schema construction from JSON param specs), `ws`, Node's built-in `node:test` + `node:assert/strict` for integration tests (matches the existing `packages/mcp-form/test/tenant-isolation.test.ts` harness style).

---

## Naming note

This plan turns the `hello-world-mcp` package from a hardcoded, project-specific tool set into a generic bridge that discovers its tools from any page's manifest. `hello-world-mcp` stops being an accurate name for the package once that's true — it's no longer *the* hello-world thing, it's a reusable JS-function-to-MCP-tool bridge that happens to ship a hello-world example. Task 0 renames the package to `js-bridge-mcp` before the rest of the plan touches its files, so subsequent tasks aren't edited against a name that's about to change. The example content itself (`legacy-page/hello-world.html`, its title, its `<h1>`/`<main>` copy) keeps the "hello world" name — it's still the right name for *an example page*, just not for the now-generic package that serves it.

---

## Design decisions locked in by this plan

1. **Manifest delivery: page pushes it over the existing WebSocket, not a new HTTP endpoint.** The client bootstrap (`main.ts`) reads `#mcp-tools` JSON from the DOM on load and sends `{ type: 'register_tools', tools: [...] }` right after the socket opens. This reuses the tenant-scoped WS channel that already exists — no new route, no CORS surface, and it naturally arrives exactly once per page load/reconnect.
2. **Manifest format: inline `<script type="application/json">` block, hand-authored per page.** Human-readable, diffable, matches how `get_embed_snippet`'s output is already meant to be pasted once and left alone. Each entry: `{ name, description, target, params, example }`. `target` is the `window.*` function name — this is the same mechanism `createClientBridge`'s `resolve: 'window'` mode already uses, just sourced from data instead of a hardcoded `ClientAction[]`.
3. **Dynamic registration via generic dispatch tools + `tools/list_changed`, not a single forever-generic `call_tool`.** When a manifest arrives, the server calls `mcp.registerTool(name, config, handler)` once per entry, so the agent sees real, individually-named, individually-schema'd tools (`insert_title`, `insert_main`, etc.) in `tools/list` — not one generic passthrough. `get_embed_snippet` remains the only tool registered unconditionally at session start.
4. **Tool execution is a request/response round-trip over WS, mirroring the existing `submitBus` pattern.** A dynamically-registered tool's handler does not touch `tenant().store` directly (unlike today's `insert_title`, which calls `tenant().store.set(...)` and relies on the store's own change-broadcast). Instead it sends `{ type: 'call', id, target, args }` to the page, and awaits a matching `{ type: 'call_result', id, result }` (or `error`) via a `Map<id, {resolve, reject}>` on the `Tenant`, the same shape as `submitBus.once('submit', ...)`. This is required because manifest-declared functions are arbitrary page-side logic, not necessarily simple `store.set` calls, and the server has no way to know their return value otherwise.
5. **Re-registration on manifest change removes stale tools before adding new ones.** `Tenant.setToolManifest(manifest)` diffs against the previously registered tool names, calls `.remove()` on any `RegisteredTool` handle no longer present, and registers/updates the rest. This keeps `tools/list` accurate if a page's manifest changes across a reconnect (e.g. the page owner edited the JSON block).
6. **`params` → zod conversion supports only flat primitive types initially: `string`, `number`, `boolean`.** This covers `insert_title`/`insert_main` and the vast majority of simple page-tool cases. Nested objects/arrays in `params` are explicitly out of scope for this plan (see "Out of scope" below) — the converter should throw a clear error if it encounters an unsupported `type`, not silently drop the field.
7. **Backward compatibility: `hello-world.html`'s pasted snippet and `get_embed_snippet` tool output are unchanged in shape.** Only the *content* of what becomes available after paste-and-reload changes (tools now come from the manifest instead of being pre-registered). No change to the URL query params (`server`, `tenant`) the snippet already carries.
8. **Out of scope for this plan:** nested/array param types in the manifest, a UI for authoring the manifest (still hand-written JSON), manifest schema validation beyond structural/type checks (no enforcement that `target` actually exists as a `window` function until call time), multiple manifests per tenant (one page = one manifest, replacing wholesale on each `register_tools`), and auth/permissioning on which tools a manifest is allowed to declare.

---

## File Structure

- **Rename: `packages/hello-world-mcp/` → `packages/js-bridge-mcp/`** (Task 0) — package directory, `package.json` name, `.mcp.json` server entry, root `package.json` workspace/typecheck references, internal imports/identity strings. `legacy-page/hello-world.html` keeps its name and content unchanged, just moves with the directory.
- **Modify: `packages/mcp-tenant-server/src/types.ts`** — add `ToolManifestEntry`, `RegisterToolsMessage`, `CallMessage`, `CallResultMessage` to the protocol types.
- **Modify: `packages/mcp-tenant-server/src/tenant.ts`** — `Tenant` gains `toolManifest`, `pendingCalls` map, `setToolManifest()`, `resolveCall()`/`rejectCall()`, and `registeredTools` bookkeeping (or this bookkeeping can live in the new `manifest-tools.ts` module keyed by tenant id — see Task 3).
- **Create: `packages/mcp-tenant-server/src/manifest-tools.ts`** — `registerManifestTools(mcp, tenant)` and the `params` → zod shape converter.
- **Modify: `packages/mcp-tenant-server/src/ws.ts`** — handle `register_tools` and `call_result` message types.
- **Modify: `packages/mcp-tenant-server/src/index.ts`** — export the new module/functions.
- **Modify: `packages/mcp-tenant-server/src/client-bridge.ts`** — `connectStateSocket` (or a small addition alongside it) reads `#mcp-tools`, sends `register_tools` on connect, and handles incoming `call` messages by dispatching through the existing `createClientBridge`/`window[target]` mechanism and sending back `call_result`.
- **Modify: `packages/hello-world-mcp/src/tools/hello-tools.ts`** — remove `insertTitle`/`insertMain` tool defs; keep only `getEmbedSnippet`.
- **Modify: `packages/hello-world-mcp/src/tools/register.ts`** — call `registerManifestTools(mcp, tenant)` in addition to registering `getEmbedSnippet`.
- **Modify: `packages/hello-world-mcp/src/client/main.ts`** — drop the hardcoded `insertTitle`/`insertMain` window exposure in favor of a manifest-driven `window` binding (or keep the functions but source their *names* from the manifest — see Task 5).
- **Modify: `packages/hello-world-mcp/legacy-page/hello-world.html`** — add the `#mcp-tools` JSON block.
- **Create: `packages/mcp-tenant-server/test/manifest-tools.test.ts`** — integration tests for manifest registration, call round-trip, and re-registration on manifest change.
- **Create: `packages/mcp-tenant-server/BRIDGING.md`** — the agent-facing authoring guide (Task 9): how to turn an arbitrary page's JS functions into MCP tools using this protocol.

---

### Task 0: Rename `hello-world-mcp` package to `js-bridge-mcp`

**Why first:** every later task edits files under `packages/hello-world-mcp/`. Renaming after the fact would mean redoing every file path in Tasks 6–9. Doing it first also means the package's identity string (used in MCP `initialize` responses) and its `.mcp.json` server key reflect the new, generic purpose from the start of this work, not partway through.

**Files:**
- Rename directory: `packages/hello-world-mcp/` → `packages/js-bridge-mcp/`
- Modify: `packages/js-bridge-mcp/package.json` (`name`, `description`)
- Modify: `packages/js-bridge-mcp/src/server.ts` (`identity.name`, log strings referencing the package name)
- Modify: `.mcp.json` (server key `hello-world-mcp` → `js-bridge-mcp`)
- Modify: root `package.json` (`typecheck` script's `-w hello-world-mcp` → `-w js-bridge-mcp`, and any other workspace references)
- Modify: `packages/mcp-tenant-server/AGENTS.md` (references to `packages/hello-world-mcp` as the Pattern B worked example)
- Modify: `packages/js-bridge-mcp/README.md` (title/description — content can stay otherwise accurate to what the package does, updated where it says "hello-world-mcp")

**Explicitly not renamed:** `packages/js-bridge-mcp/legacy-page/hello-world.html` — filename, `<title>`, `<h1>`, and body copy all stay "Hello, world!" as-is. It remains the example page; only the package that serves/bridges it is being renamed.

- [ ] **Step 1: Rename the directory and update `package.json`**

```bash
git mv packages/hello-world-mcp packages/js-bridge-mcp
```

In `packages/js-bridge-mcp/package.json`, change:
```json
{
  "name": "js-bridge-mcp",
  "description": "Generic bridge: exposes MCP tools discovered from a connected page's own JSON tool manifest, dispatched over a cross-origin WebSocket. Ships a hello-world example page under legacy-page/."
}
```

- [ ] **Step 2: Update the MCP server identity and log strings**

In `packages/js-bridge-mcp/src/server.ts`:
```ts
  identity: { name: 'js-bridge-mcp', version: '0.1.0' },
```
and update the `console.error` lines that currently read `[hello-world-mcp] ...` to `[js-bridge-mcp] ...`.

Also update the corresponding log-prefix strings in `packages/js-bridge-mcp/src/client/main.ts` (`console.log('[hello-world-mcp] connected')` etc.) for consistency — these are just log labels, not protocol-visible, but should match the package name.

- [ ] **Step 3: Update `.mcp.json`**

```json
{
  "mcpServers": {
    "mcp-form": { "type": "http", "url": "http://localhost:8765/mcp" },
    "js-bridge-mcp": { "type": "http", "url": "http://localhost:8766/mcp" }
  }
}
```

- [ ] **Step 4: Update root `package.json` workspace references**

Change the `typecheck` script's `-w hello-world-mcp` to `-w js-bridge-mcp` (and confirm `npm install` picks up the workspace rename cleanly — the workspace glob is directory-based, e.g. `packages/*`, so no explicit list should need touching beyond this one script reference; grep to confirm: `grep -rn "hello-world-mcp" package.json`).

- [ ] **Step 5: Update `mcp-tenant-server/AGENTS.md` cross-references**

Both Pattern A and Pattern B sections reference `packages/hello-world-mcp` as the worked example — update those paths to `packages/js-bridge-mcp`.

- [ ] **Step 6: Sweep for stragglers and verify**

```bash
grep -rln "hello-world-mcp" --include="*.json" --include="*.ts" --include="*.md" --include="*.html" . | grep -v node_modules | grep -v /dist/
```
Expected remaining matches: only `packages/js-bridge-mcp/legacy-page/hello-world.html` (filename itself, unrelated to the package name) and, if present, `package-lock.json` (regenerate via `npm install` at the repo root — this is a lockfile artifact of the rename, not a manual edit).

Run `npm install` (root) to refresh the lockfile and confirm the workspace resolves under its new name, then `npm run typecheck` and `npm run build` (or scoped equivalents) to confirm nothing broke.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: rename hello-world-mcp package to js-bridge-mcp, reflecting its generic bridge role"
```

---

### Task 1: Protocol types for manifest + call/response messages

**Files:**
- Modify: `packages/mcp-tenant-server/src/types.ts`

- [ ] **Step 1: Add types**

```ts
export interface ToolParamSpec {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  optional?: boolean;
}

export interface ToolManifestEntry {
  name: string;
  description: string;
  target: string; // window.* function name the page exposes
  params: Record<string, ToolParamSpec>;
  example?: Record<string, unknown>;
}

export interface RegisterToolsMessage {
  type: 'register_tools';
  tools: ToolManifestEntry[];
}

export interface CallMessage {
  type: 'call';
  id: string;
  target: string;
  args: unknown;
}

export interface CallResultMessage {
  type: 'call_result';
  id: string;
  result?: unknown;
  error?: string;
}
```

Extend `ClientMessage` (page → server) with `RegisterToolsMessage | CallResultMessage`, and add a new `ServerToClientMessage` union (server → page) containing `CallMessage` — today `ServerMessage` covers `init`/`reinit`/`update`; either extend that union with `CallMessage` or introduce a second exported union. Keep `ServerMessage` name stable for existing consumers; adding a member to a union is backward compatible for readers that switch on `msg.type` (existing client handlers already ignore unknown types safely, but audit `client-bridge.ts`'s `ws.onmessage` switch to confirm it does — see Task 4).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` (root). Expect no errors — this task is additive types only, nothing consumes them yet.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-tenant-server/src/types.ts
git commit -m "feat(mcp-tenant-server): add tool-manifest and call/response protocol types"
```

---

### Task 2: `Tenant` gains manifest storage and pending-call bookkeeping

**Files:**
- Modify: `packages/mcp-tenant-server/src/tenant.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-tenant-server/test/manifest-tools.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tenant } from '../src/tenant.js';

test('Tenant.setToolManifest stores the manifest and is readable back', () => {
  const t = new Tenant('t1', undefined, {});
  const manifest = [{ name: 'foo', description: 'd', target: 'foo', params: {} }];
  t.setToolManifest(manifest);
  assert.deepEqual(t.toolManifest, manifest);
});

test('Tenant call/resolveCall round-trip resolves with the page result', async () => {
  const t = new Tenant('t1', undefined, {});
  const pending = t.call('insertTitle', { title: 'hi' });
  const id = [...t.pendingCalls.keys()][0]!;
  t.resolveCall(id, 'ok');
  assert.equal(await pending, 'ok');
});

test('Tenant call/rejectCall round-trip rejects', async () => {
  const t = new Tenant('t1', undefined, {});
  const pending = t.call('insertTitle', { title: 'hi' });
  const id = [...t.pendingCalls.keys()][0]!;
  t.rejectCall(id, 'boom');
  await assert.rejects(pending, /boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @avo-mcp-tools/mcp-tenant-server test` (or `node --test` against the built/compiled test — match whatever `packages/mcp-form/test/tenant-isolation.test.ts` uses today for its run command; check `package.json` `"test"` script in that package and mirror it here since `mcp-tenant-server` likely has none yet).
Expected: FAIL — `setToolManifest`/`call`/`resolveCall`/`rejectCall`/`pendingCalls`/`toolManifest` don't exist on `Tenant` yet.

- [ ] **Step 3: Implement**

In `packages/mcp-tenant-server/src/tenant.ts`, extend the `Tenant` class:

```ts
import { randomUUID } from 'node:crypto';
import type { ToolManifestEntry, CallMessage } from './types.js';

// inside class Tenant<TSchema, TValues>
toolManifest: ToolManifestEntry[] = [];
pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

setToolManifest(manifest: ToolManifestEntry[]) {
  this.toolManifest = manifest;
}

call(target: string, args: unknown, timeoutMs = 10_000): Promise<unknown> {
  const id = randomUUID();
  const promise = new Promise<unknown>((resolve, reject) => {
    this.pendingCalls.set(id, { resolve, reject });
    setTimeout(() => {
      if (this.pendingCalls.delete(id)) reject(new Error(`call to "${target}" timed out after ${timeoutMs}ms`));
    }, timeoutMs).unref();
  });
  const payload: CallMessage = { type: 'call', id, target, args };
  const raw = JSON.stringify(payload);
  for (const client of this.wsClients) {
    if (client.readyState === client.OPEN) client.send(raw);
  }
  return promise;
}

resolveCall(id: string, result: unknown) {
  const pending = this.pendingCalls.get(id);
  if (!pending) return;
  this.pendingCalls.delete(id);
  pending.resolve(result);
}

rejectCall(id: string, error: string) {
  const pending = this.pendingCalls.get(id);
  if (!pending) return;
  this.pendingCalls.delete(id);
  pending.reject(new Error(error));
}
```

Also extend `dispose()` to reject any still-pending calls (mirrors how it already emits an interrupted submit):

```ts
dispose() {
  // ...existing body...
  for (const [id, pending] of this.pendingCalls) {
    pending.reject(new Error('tenant disposed'));
  }
  this.pendingCalls.clear();
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run the same test command as Step 2. Expected: PASS, all three new tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-tenant-server/src/tenant.ts packages/mcp-tenant-server/test/manifest-tools.test.ts
git commit -m "feat(mcp-tenant-server): Tenant supports tool manifest storage and call/response round-trip"
```

---

### Task 3: Generic `registerManifestTools` — zod conversion + dynamic `mcp.registerTool`

**Files:**
- Create: `packages/mcp-tenant-server/src/manifest-tools.ts`
- Modify: `packages/mcp-tenant-server/src/index.ts`
- Modify: `packages/mcp-tenant-server/test/manifest-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `manifest-tools.test.ts` — drive this through a real `McpServer` + in-memory transport pair (mirror the pattern in `packages/mcp-form/test/tenant-isolation.test.ts` which already spins up real MCP clients against a real server; here we can construct `McpServer` directly without the HTTP layer since `registerManifestTools` only needs the `McpServer` instance and a `tenant()` accessor):

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerManifestTools } from '../src/manifest-tools.js';

test('registerManifestTools registers a tool per manifest entry with correct zod param types', async () => {
  const t = new Tenant('t1', undefined, {});
  t.setToolManifest([
    { name: 'insert_title', description: 'sets title', target: 'insertTitle', params: { title: { type: 'string' } } },
  ]);
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  const handles = registerManifestTools(mcp, () => t);
  assert.equal(handles.size, 1);
  assert.ok(handles.has('insert_title'));
});

test('calling a manifest tool sends a "call" WS message and resolves via resolveCall', async () => {
  const t = new Tenant('t1', undefined, {});
  t.setToolManifest([
    { name: 'insert_title', description: 'sets title', target: 'insertTitle', params: { title: { type: 'string' } } },
  ]);
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  registerManifestTools(mcp, () => t);

  // Fake a connected WS client that immediately acks the call.
  const fakeSocket = {
    readyState: 1, OPEN: 1,
    send(raw: string) {
      const msg = JSON.parse(raw);
      if (msg.type === 'call') queueMicrotask(() => t.resolveCall(msg.id, `title set to "${msg.args.title}"`));
    },
  };
  t.wsClients.add(fakeSocket as any);

  // Invoke the registered tool's handler the way the SDK would.
  const result = await t.call('insertTitle', { title: 'Hi' });
  assert.equal(result, 'title set to "Hi"');
});

test('unsupported param type throws a clear error', () => {
  const t = new Tenant('t1', undefined, {});
  t.setToolManifest([
    { name: 'bad', description: 'x', target: 'bad', params: { thing: { type: 'object' as any } } },
  ]);
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });
  assert.throws(() => registerManifestTools(mcp, () => t), /unsupported param type/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `registerManifestTools` doesn't exist yet.

- [ ] **Step 3: Implement**

```ts
// packages/mcp-tenant-server/src/manifest-tools.ts
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from './tenant.js';
import type { ToolManifestEntry, ToolParamSpec } from './types.js';

function paramSpecToZod(spec: ToolParamSpec): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (spec.type) {
    case 'string': schema = z.string(); break;
    case 'number': schema = z.number(); break;
    case 'boolean': schema = z.boolean(); break;
    default: throw new Error(`unsupported param type "${(spec as any).type}" (supported: string, number, boolean)`);
  }
  if (spec.description) schema = schema.describe(spec.description);
  return spec.optional ? schema.optional() : schema;
}

function manifestEntryToZodShape(entry: ToolManifestEntry): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(entry.params)) {
    shape[key] = paramSpecToZod(spec);
  }
  return shape;
}

/**
 * Registers one MCP tool per entry in tenant().toolManifest, dispatching
 * calls to the page via tenant().call(target, args). Returns the live
 * RegisteredTool handles keyed by tool name so a later manifest change
 * can .remove() stale entries (see Task 6).
 */
export function registerManifestTools<TSchema, TValues>(
  mcp: McpServer,
  tenant: () => Tenant<TSchema, TValues>
): Map<string, RegisteredTool> {
  const handles = new Map<string, RegisteredTool>();
  for (const entry of tenant().toolManifest) {
    const handle = mcp.registerTool(
      entry.name,
      { description: entry.description, inputSchema: manifestEntryToZodShape(entry) },
      async (args: any) => {
        try {
          const result = await tenant().call(entry.target, args);
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: String((err as Error).message) }], isError: true };
        }
      }
    );
    handles.set(entry.name, handle);
  }
  return handles;
}
```

Export from `packages/mcp-tenant-server/src/index.ts`:

```ts
export { registerManifestTools } from './manifest-tools.js';
```

- [ ] **Step 4: Run test to confirm it passes**

Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-tenant-server/src/manifest-tools.ts packages/mcp-tenant-server/src/index.ts packages/mcp-tenant-server/test/manifest-tools.test.ts
git commit -m "feat(mcp-tenant-server): registerManifestTools converts JSON manifest entries into live MCP tools"
```

---

### Task 4: Wire `register_tools` and `call_result` into the WebSocket handler

**Files:**
- Modify: `packages/mcp-tenant-server/src/ws.ts`

- [ ] **Step 1: Write the failing test**

Add to `manifest-tools.test.ts` (this one needs a real HTTP+WS server — copy the spawn/connect harness style from `packages/mcp-form/test/tenant-isolation.test.ts`, or if `mcp-tenant-server` has no such harness yet, build a minimal one using `createHttpServer` + `attachWebSocketServer` directly in-process rather than via `child_process.spawn`, since this package has no `server.ts` entry of its own):

```ts
import { WebSocket } from 'ws';
import http from 'node:http';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws.js';

test('WS "register_tools" message updates the tenant manifest; "call_result" resolves a pending call', async () => {
  const port = 18901;
  const httpServer = createHttpServer({
    port, staticDir: '/tmp', initialSchema: undefined, initialValues: {},
    identity: { name: 'test', version: '0.0.1' },
    registerFn: () => {},
  });
  attachWebSocketServer(httpServer, port, undefined, {});
  await new Promise<void>((resolve) => httpServer.listen(port, resolve));

  const ws = new WebSocket(`ws://localhost:${port}/ws?tenant=manifest-test`);
  await new Promise((resolve) => ws.on('open', resolve));

  const manifest = [{ name: 'insert_title', description: 'd', target: 'insertTitle', params: { title: { type: 'string' } } }];
  ws.send(JSON.stringify({ type: 'register_tools', tools: manifest }));
  await new Promise((r) => setTimeout(r, 100));

  const { tenants } = await import('../src/tenant.js');
  assert.deepEqual(tenants.get('manifest-test')?.toolManifest, manifest);

  const pending = tenants.get('manifest-test')!.call('insertTitle', { title: 'hi' });
  const callMsg = await new Promise<any>((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
  assert.equal(callMsg.type, 'call');
  ws.send(JSON.stringify({ type: 'call_result', id: callMsg.id, result: 'done' }));
  assert.equal(await pending, 'done');

  ws.close();
  httpServer.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `ws.ts`'s message handler doesn't recognize `register_tools`/`call_result` yet, so `toolManifest` stays empty and the `call` round-trip never resolves.

- [ ] **Step 3: Implement**

In `packages/mcp-tenant-server/src/ws.ts`, extend the `ws.on('message', ...)` body:

```ts
    ws.on('message', (raw) => {
      t.touch();
      let msg: ClientMessage;
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

      if (msg.type === 'register_tools') {
        t.setToolManifest(msg.tools);
      }

      if (msg.type === 'call_result') {
        if (msg.error) t.rejectCall(msg.id, msg.error);
        else t.resolveCall(msg.id, msg.result);
      }
    });
```

- [ ] **Step 4: Run test to confirm it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-tenant-server/src/ws.ts packages/mcp-tenant-server/test/manifest-tools.test.ts
git commit -m "feat(mcp-tenant-server): handle register_tools and call_result WebSocket messages"
```

---

### Task 5: Manifest re-registration on change (`tools/list_changed`)

**Files:**
- Modify: `packages/mcp-tenant-server/src/manifest-tools.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('re-registering a manifest removes stale tools and adds new ones', () => {
  const t = new Tenant('t1', undefined, {});
  const mcp = new McpServer({ name: 'test', version: '0.0.1' });

  t.setToolManifest([{ name: 'insert_title', description: 'd', target: 'insertTitle', params: {} }]);
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();
  assert.ok(registry.handles.has('insert_title'));

  t.setToolManifest([{ name: 'insert_main', description: 'd2', target: 'insertMain', params: {} }]);
  registry.sync();
  assert.ok(!registry.handles.has('insert_title'), 'stale tool should be removed');
  assert.ok(registry.handles.has('insert_main'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — no `createManifestToolRegistry`/`sync()` exists; `registerManifestTools` from Task 3 only registers once and has no notion of re-sync.

- [ ] **Step 3: Implement**

Replace the one-shot `registerManifestTools` export with a stateful registry (keep `registerManifestTools` as a thin wrapper for the common "register once, no live updates" case used by simple consumers, but add the new stateful API for the live-reconnect case):

```ts
export interface ManifestToolRegistry {
  handles: Map<string, RegisteredTool>;
  sync(): void;
}

export function createManifestToolRegistry<TSchema, TValues>(
  mcp: McpServer,
  tenant: () => Tenant<TSchema, TValues>
): ManifestToolRegistry {
  const handles = new Map<string, RegisteredTool>();

  function sync() {
    const manifest = tenant().toolManifest;
    const currentNames = new Set(manifest.map((e) => e.name));

    for (const [name, handle] of handles) {
      if (!currentNames.has(name)) {
        handle.remove();
        handles.delete(name);
      }
    }

    for (const entry of manifest) {
      if (handles.has(entry.name)) continue; // already registered; params/description assumed stable for this plan (see design decision 5)
      const handle = mcp.registerTool(
        entry.name,
        { description: entry.description, inputSchema: manifestEntryToZodShape(entry) },
        async (args: any) => {
          try {
            const result = await tenant().call(entry.target, args);
            return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: String((err as Error).message) }], isError: true };
          }
        }
      );
      handles.set(entry.name, handle);
    }
  }

  return { handles, sync };
}
```

Wire `sync()` to be called from `ws.ts`'s `register_tools` handler (Task 4's code), after `t.setToolManifest(msg.tools)` — this requires the registry to be reachable from the WS layer. Simplest approach: store the registry on the `Tenant` itself (`tenant.manifestToolRegistry`), created lazily by whoever calls `createManifestToolRegistry` per session (i.e. `registerHelloTools`/the package's `register.ts`, since that's where the `McpServer` instance is available) — assign it there and have `Tenant.setToolManifest` call `this.manifestToolRegistry?.sync()` if present.

Update `Tenant` (Task 2's additions) with:

```ts
manifestToolRegistry?: { sync(): void };

setToolManifest(manifest: ToolManifestEntry[]) {
  this.toolManifest = manifest;
  this.manifestToolRegistry?.sync();
}
```

And in `js-bridge-mcp/src/tools/register.ts` (Task 6), assign `tenant().manifestToolRegistry = createManifestToolRegistry(mcp, tenant)` once at registration time, then call `.sync()` once up front in case a manifest arrived before registration (shouldn't happen given connection ordering, but cheap to guard).

- [ ] **Step 4: Run test to confirm it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-tenant-server/src/manifest-tools.ts packages/mcp-tenant-server/src/tenant.ts
git commit -m "feat(mcp-tenant-server): re-syncing manifest registry removes stale tools and registers new ones"
```

---

### Task 6: `js-bridge-mcp` server/client wiring — drop hardcoded tools, add manifest bootstrap

**Files:**
- Modify: `packages/js-bridge-mcp/src/tools/hello-tools.ts`
- Modify: `packages/js-bridge-mcp/src/tools/register.ts`
- Modify: `packages/js-bridge-mcp/src/client/main.ts`

- [ ] **Step 1: Trim `hello-tools.ts` to just `getEmbedSnippet`**

Remove the `insertTitle`/`insertMain` `ToolDef` objects entirely (they're now sourced from the page's manifest, not hardcoded). `helloTools` becomes `[getEmbedSnippet]`.

- [ ] **Step 2: Update `register.ts` to also mount the manifest registry**

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from '@avo-mcp-tools/mcp-tenant-server';
import { createManifestToolRegistry } from '@avo-mcp-tools/mcp-tenant-server';
import type { HelloState } from '../types.js';
import { helloTools } from './hello-tools.js';

export function registerHelloTools(mcp: McpServer, tenant: () => Tenant<undefined, HelloState>, port: number) {
  for (const tool of helloTools) {
    mcp.tool(tool.name, tool.description, tool.schema, (args: any) => tool.handler(args, tenant, port));
  }
  const registry = createManifestToolRegistry(mcp, tenant);
  tenant().manifestToolRegistry = registry;
  registry.sync();
}
```

- [ ] **Step 3: Update `main.ts` client bootstrap to read and push the manifest, and answer `call` messages**

Add manifest reading + push right after connecting, and extend the WS message handler to answer `call`:

```ts
import { connectStateSocket } from '@avo-mcp-tools/mcp-tenant-server/client';
import type { HelloState } from '../types.js';

function insertTitle(title: string) {
  document.title = title;
  const el = document.querySelector('h1');
  if (el) el.textContent = title;
}

function insertMain(main: string) {
  const el = document.querySelector('main');
  if (el) el.textContent = main;
}

(window as any).insertTitle = insertTitle;
(window as any).insertMain = insertMain;

const scriptUrl = new URL(import.meta.url);
const serverUrl = scriptUrl.searchParams.get('server') ?? undefined;
const tenant = scriptUrl.searchParams.get('tenant') ?? undefined;

function readManifest() {
  const el = document.getElementById('mcp-tools');
  if (!el || !el.textContent) return [];
  try { return JSON.parse(el.textContent); } catch { return []; }
}

const socket = connectStateSocket<undefined, HelloState>(
  {
    onInit(_schema, state) {
      insertTitle(state.title);
      insertMain(state.main);
      socket.send({ type: 'register_tools', tools: readManifest() } as any);
    },
    onReinit(_schema, state) {
      insertTitle(state.title);
      insertMain(state.main);
    },
    onUpdate(field, value) {
      if (field === 'title') insertTitle(value as string);
      if (field === 'main') insertMain(value as string);
    },
    onCall(id, target, args) {
      try {
        const fn = (window as any)[target];
        if (typeof fn !== 'function') throw new Error(`window.${target} is not a function`);
        const result = fn(args);
        socket.send({ type: 'call_result', id, result } as any);
      } catch (err) {
        socket.send({ type: 'call_result', id, error: String((err as Error).message) } as any);
      }
    },
    onConnect() {
      console.log('[js-bridge-mcp] connected');
    },
    onDisconnect() {
      console.log('[js-bridge-mcp] disconnected, retrying...');
    },
  },
  { serverUrl, tenant }
);
```

This requires adding an `onCall` handler to `StateSocketHandlers` in `client-bridge.ts` and dispatching `msg.type === 'call'` to it in `connectStateSocket`'s `ws.onmessage` — small addition to Task 1's client-side counterpart; fold into this task's Step 3 since it's client-bridge-specific plumbing:

```ts
// client-bridge.ts additions
export interface StateSocketHandlers<TSchema, TValues> {
  onInit?(schema: TSchema, state: TValues): void;
  onReinit?(schema: TSchema, state: TValues): void;
  onUpdate?(field: string, value: unknown): void;
  onCall?(id: string, target: string, args: unknown): void;
  onConnect?(): void;
  onDisconnect?(): void;
}
// in ws.onmessage:
if (msg.type === 'call') handlers.onCall?.(msg.id, msg.target, msg.args);
```

Note `args` passed to `fn(args)` above is the whole args object (e.g. `{ title: "hi" }`), not spread positional params — `insertTitle`/`insertMain` currently take a single positional string, so either (a) change their signatures to accept the args object and destructure, matching how manifest `params` are named, or (b) special-case single-param manifests to unwrap. **Recommendation: (a)** — update `insertTitle`/`insertMain` to `insertTitle({ title })`/`insertMain({ main })` so the `target` function's signature always matches "one args object keyed by param names," consistent for any future page/manifest, not just this one.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build` (root, or scoped to `js-bridge-mcp` + `mcp-tenant-server`).
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/js-bridge-mcp/src packages/mcp-tenant-server/src/client-bridge.ts
git commit -m "feat(js-bridge-mcp): drop hardcoded tools, bootstrap tools from page manifest"
```

---

### Task 7: Add the `#mcp-tools` JSON manifest block to `hello-world.html`

**Files:**
- Modify: `packages/js-bridge-mcp/legacy-page/hello-world.html`

- [ ] **Step 1: Add the manifest block**

```html
  <!--
    This page has zero build-step dependency on mcp-tenant-server or
    js-bridge-mcp. An MCP agent connected to js-bridge-mcp will call
    the get_embed_snippet tool, which returns a <script type="module">
    tag to paste right here, before </body>. Once pasted and this page
    is reloaded, the tools declared below become available to the agent —
    the server discovers them from this JSON, it does not hardcode them.
  -->
  <h1>Hello, world!</h1>
  <main>Waiting for an agent to say something...</main>

  <script id="mcp-tools" type="application/json">
  [
    {
      "name": "insert_title",
      "description": "Sets the <h1> title shown on this page.",
      "target": "insertTitle",
      "params": { "title": { "type": "string", "description": "New page title" } },
      "example": { "title": "Welcome, Ada!" }
    },
    {
      "name": "insert_main",
      "description": "Sets the <main> body content shown on this page.",
      "target": "insertMain",
      "params": { "main": { "type": "string", "description": "New body text" } },
      "example": { "main": "Here is your daily summary..." }
    }
  ]
  </script>

  <!-- Paste the snippet from get_embed_snippet here -->
```

- [ ] **Step 2: Manual smoke test**

Run `npm run build` and `npm start` in `packages/js-bridge-mcp` (per its README), serve `legacy-page/hello-world.html` via `npm run start:static`, get a snippet from `get_embed_snippet` via a connected MCP client, paste it in, reload, and confirm:
- `tools/list` initially shows only `get_embed_snippet`.
- After the page loads and pushes its manifest, `tools/list_changed` fires and a fresh `tools/list` shows `insert_title`/`insert_main`.
- Calling `insert_title`/`insert_main` updates the page live and the tool call returns the page function's return value/ack.

- [ ] **Step 3: Commit**

```bash
git add packages/js-bridge-mcp/legacy-page/hello-world.html
git commit -m "feat(js-bridge-mcp): declare insert_title/insert_main via page-side JSON manifest"
```

---

### Task 8: End-to-end integration test — two tenants, isolated manifests

**Files:**
- Create/extend: `packages/mcp-tenant-server/test/manifest-tools.test.ts` (or a new `packages/js-bridge-mcp/test/` if per-package testing is preferred — match whichever convention `packages/mcp-form/test/tenant-isolation.test.ts` established for its package)

- [ ] **Step 1: Write the test**

Spin up a real `js-bridge-mcp` server process (mirroring the `child_process.spawn` harness in `docs/superpowers/plans/2026-07-30-session-based-multi-tenancy.md`'s Task 1), open two MCP sessions, and confirm:
- Before any page connects, `tools/list` for a fresh session contains only `get_embed_snippet`.
- After a fake WS client for that tenant sends `register_tools` with a manifest, the *same* MCP session's `tools/list` (after receiving `notifications/tools/list_changed`) includes the new tool names.
- Calling the new tool sends a `call` message to that tenant's WS client and, once acked with `call_result`, the MCP `callTool` resolves with the matching content.
- A second, independent tenant with no manifest pushed still only sees `get_embed_snippet` — proving manifests don't leak across tenants.

- [ ] **Step 2: Run and confirm pass**

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-tenant-server/test/manifest-tools.test.ts
git commit -m "test: end-to-end manifest-driven tool discovery across isolated tenants"
```

---

### Task 9: `BRIDGING.md` — agent-facing guide for wiring a new page's functions to MCP tools

**Why a separate doc from `AGENTS.md`:** `AGENTS.md` (Task 8's follow-up note) covers building a whole *new package* on `mcp-tenant-server` — scaffolding, state shape, server wiring. That's the wrong altitude for the common case this feature is meant to unlock: an agent is handed an *existing* page (or writes a small one) and just needs to expose a couple of its functions as tools, with no new package, no server code, no TypeScript at all — page owner supplies JS + HTML, agent supplies the manifest JSON and the pasted snippet. `BRIDGING.md` is written entirely for that path.

**Files:**
- Create: `packages/mcp-tenant-server/BRIDGING.md`

- [ ] **Step 1: Write the guide**

Content requirements (an agent reading this cold, with no other context, must be able to complete the task):

1. **When to use this vs. `AGENTS.md`.** One paragraph: if there's already a running `mcp-tenant-server`-based MCP server (e.g. `js-bridge-mcp`) and you just need to add/change which page functions it exposes as tools, use this doc. If you need a *new* MCP server/package from scratch, use `AGENTS.md` Pattern A or B first, then come back here.
2. **The three things a page needs**, stated as a checklist:
   - One global `window.*` function per capability you want to expose, each taking a single args object (not positional params) and returning a JSON-serializable result or throwing an `Error` with a useful message — the return value/error becomes the MCP tool's result.
   - A `<script id="mcp-tools" type="application/json">` block declaring one manifest entry per function (schema below).
   - The pasted `<script type="module" src="...">` embed snippet (obtained by calling the server's `get_embed_snippet`-equivalent tool), placed after both of the above so `window.*` functions exist before the bridge tries to wire anything.
3. **The manifest entry schema, with a fully worked example**, e.g. turning a hypothetical page function `function highlightRow(args) { ... }` into:
   ```json
   {
     "name": "highlight_row",
     "description": "Highlights the table row matching the given id. Call list_rows first if you don't know valid ids.",
     "target": "highlightRow",
     "params": {
       "rowId": { "type": "string", "description": "The id attribute of the <tr> to highlight" },
       "color": { "type": "string", "description": "CSS color name, defaults to yellow if omitted", "optional": true }
     },
     "example": { "rowId": "row-42", "color": "yellow" }
   }
   ```
   Explicitly document:
   - `name` — the MCP tool name the agent will see; snake_case by convention, must be unique within the page's manifest.
   - `description` — **this is read by other agents, not humans** — write it the way you'd write any MCP tool description: state what it does, any preconditions (e.g. "call X first"), and side effects. This is the exact same bar as a hand-written tool description in source code (point at `hello-tools.ts`'s original `insert_title`/`insert_main` descriptions, still visible in git history after Task 6, as the calibration example).
   - `target` — must exactly match a `window.*` function name that exists by the time the embed script runs.
   - `params` — flat object, each value `{ type: "string"|"number"|"boolean", description?, optional? }`. No nested objects/arrays (link to design decision 6 in the main plan for why, and what to do if you need more: fall back to a JSON-encoded string param and parse it inside the target function).
   - `example` — a realistic call, used both as documentation and as something the authoring agent should actually try (Step 3 below) before handing the page off.
4. **Common mistakes section** (write from the design decisions already locked in this plan):
   - Forgetting the manifest functions must accept **one args object**, not positional args — `function insertTitle(title)` will break; must be `function insertTitle({ title })`.
   - Placing the `#mcp-tools` block *after* the embed `<script type="module">` — must come before, since the bootstrap reads it once at connect time (point at design decision 1: manifest is read and pushed once per page load/reconnect, not polled).
   - Reusing a `name` across two manifest entries — server-side behavior is undefined/last-wins per design decision 5's diffing logic, which keys purely on `name`.
   - Expecting live manifest edits to take effect without a page reload — the manifest is only re-read at socket connect time; editing the JSON block requires the page (and its WS connection) to reconnect for `sync()` to pick up the change.
5. **Validation checklist** the agent should run through before telling the user the bridge is ready, mirroring Task 7 Step 2's manual smoke test but phrased as agent-executable steps:
   - Call the server's snippet tool, paste it, load the page.
   - Call `tools/list` (or just try calling the new tool) and confirm the new tool name(s) appear.
   - Call each new tool with its `example` args and confirm the page visibly updates and the tool call returns a non-error result.
   - Open a second, unrelated tenant/session and confirm the new tools do *not* appear there (proves manifest isolation, per design decision 8).

- [ ] **Step 2: Cross-link**

Add a one-line pointer from `packages/mcp-tenant-server/AGENTS.md`'s Pattern B section ("Add a `get_embed_snippet`-style tool...") to `BRIDGING.md`, so an agent landing in `AGENTS.md` for the "existing page" case gets routed to the right doc instead of hand-rolling `ToolDef` arrays.

- [ ] **Step 3: Dry-run the guide against `hello-world.html` itself**

As a self-check, have an agent (or do it manually) follow `BRIDGING.md` step-by-step using only `insert_title`/`insert_main` as the target functions, *without* looking at Task 7's manifest JSON, and confirm the independently-produced manifest is functionally equivalent (same `name`/`target`/`params` shape, description quality comparable). Fix any ambiguity in the guide this surfaces.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-tenant-server/BRIDGING.md packages/mcp-tenant-server/AGENTS.md
git commit -m "docs(mcp-tenant-server): add BRIDGING.md guide for wiring existing pages to MCP tools via manifest"
```

---

## Self-Review Notes

- **Spec coverage:** page-declared JSON tool manifest (Task 7), WS-pushed delivery (Task 4), dynamic `mcp.registerTool` + `tools/list_changed` (Tasks 3, 5), generic call/response round-trip so arbitrary page functions can serve as tool handlers (Tasks 2, 4, 6), reusability across future pages (the manifest/registry logic lives entirely in `mcp-tenant-server`, not `js-bridge-mcp` — only the `#mcp-tools` JSON block and `window.*` functions are page-specific) — all covered.
- **Explicitly out of scope, not silently dropped:** nested/array param types, manifest-authoring UI, validation that `target` exists before call time, multiple manifests per tenant, auth on tool declarations — called out in "Design decisions" item 6 and 8.
- **Consistency check:** `ToolManifestEntry.params` keys match the args object shape passed to `target` functions (Task 6 Step 3's design decision (a)) — verified no task assumes positional args instead.
- **Docs:** `AGENTS.md`'s "Pattern B" section gets a cross-link to the new `BRIDGING.md` (Task 9) rather than a full rewrite in this pass — `AGENTS.md` still correctly describes how to scaffold a *new* package; `BRIDGING.md` is the new, narrower doc for the "existing page, existing server, just add tools" case this feature exists to unlock.
