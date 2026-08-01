# Building a new MCP package on `@avo-mcp-tools/mcp-tenant-server`

This package handles everything project-agnostic: MCP session/tenant
bookkeeping, the HTTP + WebSocket server, static file serving, and a
client-side bridge for wiring MCP tools to a browser UI. You bring: your
tool definitions, your state shape, and a page.

Two patterns are documented here:

- **Pattern A** (below) — you own the page. `mcp-tenant-server` serves
  both the MCP/WS endpoints and the static UI from one origin. Use this
  when building a UI from scratch (see `packages/mcp-form`).
- **Pattern B** (end of this doc) — you don't own the page. An existing,
  unrelated static page gets a small `<script>` snippet pasted in that
  connects cross-origin to a separately-running MCP server. Use this to
  bolt AI-agent interaction onto a legacy page without touching how it's
  built or hosted (see `packages/hello-world-mcp`).

## Pattern A: server-owned page

Follow these steps in order. The worked example at the end of this
section ("Hello World MCP") is a complete, minimal package you can copy
wholesale and rename.

### 1. Scaffold the package

Create `packages/<your-name>/` with this layout (copy `packages/mcp-form`'s
files as a template and strip out form-specific content):

```
packages/<your-name>/
  package.json
  tsconfig.json            references-only, points at server+client configs
  tsconfig.server.json      Node-oriented, includes src/server.ts + src/tools/**
  tsconfig.client.json      DOM-oriented, includes src/client/**
  vite.config.ts            root: 'public', build.outDir: '../dist/client'
  public/
    index.html               static shell
  src/
    types.ts                 your state shape (step 2)
    tools/
      *.ts                    tool definitions (step 3)
      register.ts             registerTools(mcp, tenant, port) (step 4)
    client/
      main.ts                 client entry (step 6)
    server.ts                 wiring (step 5)
```

`package.json` needs `@avo-mcp-tools/mcp-tenant-server": "*"` as a
dependency (npm workspaces resolve it locally — no publishing required).

### 2. Define your state shape

Two type parameters, not one: `TSchema` (set only when you redefine the
whole thing, e.g. field/structure metadata) and `TValues` (the reactive
value bag — individual field writes broadcast to connected clients
one-at-a-time). If your project has no real "schema" concept, use `undefined`
for `TSchema` and put everything in `TValues`.

```ts
// src/types.ts
export interface HelloState {
  title: string;
  body: string;
}
export const initialHelloState: HelloState = { title: 'Hello', body: 'World' };
```

### 3. Define tool schemas + handlers

One file, plain data objects: `{ name, description, schema, handler }`.
`schema` is a zod shape object (not a full `z.object(...)`, matching how
`mcp.tool()` expects it). `handler` receives `(args, tenant, port)` where
`tenant()` returns your `Tenant<TSchema, TValues>`.

```ts
// src/tools/hello-tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from '@avo-mcp-tools/mcp-tenant-server';
import type { HelloState } from '../types.js';

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: any, tenant: () => Tenant<undefined, HelloState>, port: number) => Promise<any>;
}

const insertTitle: ToolDef = {
  name: 'insert_title',
  description: 'Sets the page title shown in the browser.',
  schema: { title: z.string() },
  handler: async ({ title }, tenant) => {
    tenant().store.set('title', title);
    return { content: [{ type: 'text', text: `title set to "${title}"` }] };
  },
};

const insertBody: ToolDef = {
  name: 'insert_body',
  description: 'Sets the page body content shown in the browser.',
  schema: { body: z.string() },
  handler: async ({ body }, tenant) => {
    tenant().store.set('body', body);
    return { content: [{ type: 'text', text: `body set` }] };
  },
};

export const helloTools: ToolDef[] = [insertTitle, insertBody];
```

`tenant().store.set(name, value)` both updates state and broadcasts a
`{type: 'update', field, value}` WS message to connected clients — this is
what drives `insertTitle`/`insertBody` on the page live, with no extra
plumbing.

### 4. Register your tools

```ts
// src/tools/register.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from '@avo-mcp-tools/mcp-tenant-server';
import type { HelloState } from '../types.js';
import { helloTools } from './hello-tools.js';

export function registerHelloTools(mcp: McpServer, tenant: () => Tenant<undefined, HelloState>, port: number) {
  for (const tool of helloTools) {
    mcp.tool(tool.name, tool.description, tool.schema, (args: any) => tool.handler(args, tenant, port));
  }
}
```

### 5. Wire the server

Copy `packages/mcp-form/src/server.ts` and swap in your types/registerFn.
The MCP server's `name`/`version` identity is explicit here — no more
guessing what a consumer's server is called.

```ts
// src/server.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrCreateTenant as getOrCreateTenantFor, tenants, startIdleSweep, createHttpServer, attachWebSocketServer } from '@avo-mcp-tools/mcp-tenant-server';
import { initialHelloState } from './types.js';
import { registerHelloTools } from './tools/register.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8766;

const getOrCreateTenant = (id: string) => getOrCreateTenantFor(id, undefined, { ...initialHelloState });
getOrCreateTenant('default');
startIdleSweep((id) => console.error(`[mcp] sweeping idle tenant: ${id}`));

const STATIC_DIR = path.join(__dirname, '..', 'dist', 'client');

const httpServer = createHttpServer({
  port: PORT,
  staticDir: STATIC_DIR,
  initialSchema: undefined,
  initialValues: initialHelloState,
  identity: { name: 'hello-world-mcp', version: '0.1.0' },
  registerFn: registerHelloTools,
});

attachWebSocketServer(httpServer, PORT, undefined, initialHelloState);

httpServer.listen(PORT, () => {
  console.error(`[hello-world-mcp] UI available at http://localhost:${PORT}`);
});

export { getOrCreateTenant, tenants, httpServer };
```

### 6. Wire the client

Decision: does your existing page have a build step?

- **No build step** — expose plain `window` globals, use `resolve: 'window'`.
- **Build step** — pass real function references at bridge-construction
  time (types are in place for this; no worked example yet — see the
  package README for status).

For the no-build-step case, `public/index.html` is a static shell with a
`<script type="module" src="/main.js">`, and your client entry connects
the WS state stream and dispatches into `window` globals:

```html
<!-- public/index.html -->
<!doctype html>
<html>
<head><title id="page-title">Hello</title></head>
<body>
  <h1 id="page-title-el"></h1>
  <p id="page-body-el"></p>
  <script type="module" src="/main.js"></script>
</body>
</html>
```

```ts
// src/client/main.ts
import { connectStateSocket } from '@avo-mcp-tools/mcp-tenant-server/client';
import type { HelloState } from '../types.js';

function insertTitle(title: string) {
  document.getElementById('page-title-el')!.textContent = title;
  document.title = title;
}
function insertBody(body: string) {
  document.getElementById('page-body-el')!.textContent = body;
}
(window as any).insertTitle = insertTitle;
(window as any).insertBody = insertBody;

connectStateSocket<undefined, HelloState>({
  onInit(_schema, state) {
    insertTitle(state.title);
    insertBody(state.body);
  },
  onUpdate(field, value) {
    if (field === 'title') insertTitle(value as string);
    if (field === 'body') insertBody(value as string);
  },
});
```

`connectStateSocket` handles the WebSocket connection, tenant-scoped path,
JSON parsing, and reconnect-on-close — you only write the `onInit`/
`onUpdate` callbacks. `createClientBridge` (same import path) is available
if you'd rather dispatch by tool name generically instead of hand-matching
`field` strings — useful once you have more than a couple of fields.

### 7. Checklist

- `npm run typecheck` (root script covers both packages)
- `npm run build` in your package
- `npm start` in your package, open `http://localhost:<port>`, confirm the
  page renders
- Connect an MCP client (or use the existing test suite as a template) and
  call `insert_title`/`insert_body` — confirm the browser updates live
  without a page refresh

## What Pattern A does NOT cover

- Pre-wired/build-time client bridge mode's worked example (types exist,
  no worked sample yet).
- Publishing packages to a real npm registry — workspace-local only.
- Changing `ClientMessage` verbs (`set`/`submit`/`interrupt`) — these are
  fixed today. If your project needs different verbs, that's a change to
  `mcp-tenant-server` itself, not something you can override per-package.

## Pattern B: AI-enabling an existing static page (cross-origin)

Use this when there's already a page — built by something else, hosted
somewhere else, no interest in restructuring it — and you want an agent
to be able to read/write parts of it live. The full worked example is
`packages/hello-world-mcp`; this section explains the parts that differ
from Pattern A.

### What's different from Pattern A

- **Two independent servers, two origins.** Your MCP package's server
  (`createHttpServer` + `attachWebSocketServer`, same as Pattern A) still
  runs, but it does NOT serve the page — only the bundled client JS
  (`main.js`). The page is served however it already is (a CDN, an
  existing static host, `http-server`, whatever) on a different
  origin/port.
- **No `public/index.html`.** Nothing ever loads `/` from your MCP
  package's server as a page, so there's nothing to put there. `vite.config.ts`
  switches from HTML-entry mode to **library mode** so the output has a
  stable filename (`main.js`) instead of a content hash — the existing
  page references it by a fixed URL:
  ```ts
  // vite.config.ts
  export default defineConfig({
    build: {
      outDir: 'dist/client',
      lib: { entry: 'src/client/main.ts', formats: ['es'], fileName: () => 'main.js' },
    },
  });
  ```
- **`connectStateSocket` needs explicit `serverUrl`/`tenant` options.**
  Its default tenant resolution reads `/t/<id>` from `location.pathname`
  — meaningless when the page is served from an unrelated origin/path.
  Pass both explicitly:
  ```ts
  connectStateSocket(handlers, { serverUrl: 'http://localhost:8766', tenant: 'some-id' });
  ```
  The values themselves shouldn't be hardcoded in your client source —
  read them from the client script's own URL (see next point), which is
  what makes the paste-in snippet self-contained.
- **A `get_embed_snippet`-style tool, not a hardcoded `<script>` tag.**
  Add a tool (project-specific, not part of the generic package) that
  returns the exact markup to paste, with the server origin and **this
  MCP session's own tenant id** (`tenant().id` — not a freshly generated,
  unrelated one) baked into the script URL's query string:
  ```ts
  const serverUrl = `http://localhost:${port}`;
  const snippet = `<script type="module" src="${serverUrl}/main.js?server=${encodeURIComponent(serverUrl)}&tenant=${tenant().id}"></script>`;
  ```
  Using the session's own tenant id means `insert_title`/`insert_main`
  calls made from that same MCP conversation land on the exact tenant the
  pasted page is connected to — no separate "which session is this"
  bookkeeping needed.
- **The client bundle reads `server`/`tenant` from its own script URL**,
  via `import.meta.url` (reliable for `<script type="module">` — the
  browser resolves it to the script's own URL, including query string):
  ```ts
  const scriptUrl = new URL(import.meta.url);
  const serverUrl = scriptUrl.searchParams.get('server') ?? undefined;
  const tenant = scriptUrl.searchParams.get('tenant') ?? undefined;
  connectStateSocket(handlers, { serverUrl, tenant });
  ```
  This is what makes the pasted snippet a single self-contained line —
  no second inline `<script>` block to configure globals first.
- **CORS**: `/mcp` already sends `Access-Control-Allow-Origin: *` (needed
  for the agent-side MCP client, which may itself run in a browser).
  WebSocket connections aren't subject to CORS preflight, so no server
  change is needed for the cross-origin browser case either.

### Recipe

1. Do Pattern A steps 1–4 unchanged (scaffold, state shape, tools,
   register) — plus one more tool, `get_embed_snippet`, as shown above.
2. Step 5 (wire the server) — same shape as Pattern A, but there's no
   page-serving purpose to `staticDir` beyond `main.js`; point it at
   `dist/client` as usual.
3. Step 6 (wire the client) — switch `vite.config.ts` to library mode,
   read `serverUrl`/`tenant` from `import.meta.url`, expose `window.*`
   globals as normal.
4. Add a sibling `legacy-page/` folder with the existing/example static
   page, plus a note on where the pasted `<script>` goes. Serve it with
   whatever the "existing" hosting is — `packages/hello-world-mcp` uses
   `http-server --cors`.
5. Checklist: same as Pattern A step 7, but the smoke test is
   cross-origin — run both servers on different ports, open the page from
   its own server, paste the generated snippet, reload, confirm live
   updates and confirm a second tenant/page doesn't receive them.

### Not yet built

- A generic "connect" UI (e.g. a small Lit custom element) that a page
  could embed once, unscoped, and that prompts the user to paste in a
  tenant id supplied by the agent — rather than requiring the agent to
  regenerate and hand over a full `<script src=...>` snippet each time.
  `get_embed_snippet` is the interim mechanism.
