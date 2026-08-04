# Bridging an existing page's functions to MCP tools

This doc is for wiring up **which functions an already-running `js-bridge-mcp`-style
server exposes as MCP tools**, given a page (existing or new) that you can add a
small inline script to. It assumes the MCP server, its `/mcp` and `/ws`
endpoints, and a `get_embed_snippet`-equivalent tool already exist and are
running — you are not building a new package here.

## When to use this vs. `AGENTS.md`

- **No MCP server exists yet for this page at all** → see `AGENTS.md` in this
  package (Pattern A or B) to scaffold one first, then come back here to add tools.
- **A server already exists (e.g. `js-bridge-mcp`) and you just need to add,
  change, or remove which page functions it exposes as tools** → this doc.

## The two things a page needs

1. **`window.__mcpTools`** — a global array of tool definitions, defined by
   the page itself, **before** the embed snippet runs. Each entry holds a
   **real function reference**, not a string name to look up later:

   ```js
   function highlightRow({ rowId, color }) {
     const row = document.getElementById(rowId);
     if (!row) throw new Error(`no row with id "${rowId}"`);
     row.style.backgroundColor = color ?? 'yellow';
     return `highlighted ${rowId}`;
   }

   window.__mcpTools = [
     {
       name: 'highlight_row',
       description: 'Highlights the table row matching the given id. Call list_rows first if you don\'t know valid ids.',
       params: {
         rowId: { type: 'string', description: 'The id attribute of the <tr> to highlight' },
         color: { type: 'string', description: 'CSS color name, defaults to yellow if omitted', optional: true },
       },
       example: { rowId: 'row-42', color: 'yellow' },
       fn: highlightRow,
     },
   ];
   ```

   This works the same way whether the page is plain script tags (as above —
   `window.__mcpTools` is just a global) or an ES module build: in the module
   case, the module that has the real function in scope is also where you
   define `window.__mcpTools`, referencing the function directly rather than
   its name — no string-based lookup happens anywhere in this system.

   **Optional: `window.__mcpSummary`** — a single string with manifest-level
   context shared across every tool in this page's list: what kind of
   page/app this is, cross-tool sequencing rules ("call X before Y"), and
   domain concepts an agent needs before calling tools blindly. Read once,
   at the same time as `window.__mcpTools`. This exists because individual
   tool `description`s are the wrong place for context that's true of the
   *whole page*, not one tool — repeating it in every entry wastes context
   and drifts out of sync as tools are added/removed. Set it before the
   embed snippet runs, same as `window.__mcpTools`:

   ```js
   window.__mcpSummary = 'This page is a data grid with rows keyed by id. ' +
     'Call list_rows before highlight_row if you don\'t already know a valid id.';
   ```

   It's surfaced to the connected agent via a `describe_tools` MCP tool that
   the server always registers automatically (see below) — not baked into
   the MCP server's static `instructions`, because the page (and therefore
   its summary) only connects and registers *after* the `McpServer` instance
   for that session already exists.

   **Optional: `window.__mcpAppName`** — a short string (e.g. `"formalin"`,
   `"htmlpaint"`) identifying this page/app. It only matters when the *same*
   tenant ends up with more than one live connection — e.g. the same embed
   snippet pasted into two browser tabs — in which case it's used to build a
   readable tool-name prefix and connection label (see "Multiple connections
   per tenant" below). Falls back to `document.title` if unset, and has no
   effect at all with a single connection.

   **Naming prompt on first connect.** The very first time the pasted
   snippet connects (once per page load, not on later reconnects), the
   bridge itself opens `prompt('Name this MCP connection...', <derived
   label>)` — pre-filled with `window.__mcpAppName`/`document.title` —
   before it ever registers tools. This is deliberate, not just a UX nicety:
   an agent has no way to learn about a *later* rename (MCP has no
   server-push for "the tool list changed"), so a rename after the agent
   has already called `describe_tools` leaves it holding a stale, now-dead
   prefix until it happens to re-call `describe_tools`. Asking once, up
   front, means whatever label ends up registered is the only one any
   connecting agent ever sees. Dismissing/cancelling the prompt (`Escape`,
   Cancel button) is safe — it silently falls back to the derived label and
   registration proceeds immediately, never blocking the connection.

   **`window.__mcpRename(newLabel?)`** — defined by the embed snippet itself
   (not something a page author sets), lets a human relabel an already-live
   connection from DevTools later in the session, without a reload — e.g. to
   fix a typo from the connect-time prompt, or rename mid-session. Call it
   with no argument from the console and it opens a `prompt()` pre-filled
   with the connection's current label; call it with a string
   (`__mcpRename('mindfoo-dev')`) to skip the prompt entirely. Sends a
   `rename_connection` message that updates the connection's label and
   re-syncs tool-name prefixes immediately. Carries the same caveat as
   above: an agent that already read the old prefix won't automatically
   learn the new one, so this is best used before an agent starts relying
   on this connection's tool names, not mid-task.

2. **The embed snippet** — one line of executable JavaScript obtained by
   calling the server's `get_embed_snippet` tool (or equivalent), e.g.
   `import("http://localhost:8766/main.js?server=...&tenant=...");`.
   - **Primary path (developer, today): paste it directly into the target
     page's DevTools console and press enter.** No source edit needed —
     this is the expected workflow right now, since the person wiring this
     up usually has the page open in a browser they control.
   - **Alternative: bake it into the page's HTML** as
     `<script type="module">import("...");</script>`, placed **after**
     `window.__mcpTools` is defined, so the bridge script finds it populated
     when it runs. The bridge reads `window.__mcpTools` exactly once, at
     load/(re)connect time — it does not poll for later changes.

## Tool definition schema

Each entry in `window.__mcpTools`:

- **`name`** — the MCP tool name the agent will see and call. snake_case by
  convention (matches this codebase's other tools, e.g. `insert_title`,
  `get_embed_snippet`). Must be unique within this page's tool list.
- **`description`** — **written for other agents, not humans.** This is read
  by whatever AI agent is deciding whether and how to call your tool — hold it
  to the same bar as a hand-written tool description in source code: state
  what it does, any preconditions ("call X first"), and side effects. For
  calibration, look at `get_embed_snippet`'s description in
  `packages/js-bridge-mcp/src/tools/hello-tools.ts` — it explains not just
  what the tool returns but what to do with the result and why.
- **`params`** — a flat object. Each value is `{ type, description?, optional? }`
  where `type` is `"string"`, `"number"`, or `"boolean"`. **No nested objects
  or arrays** — the server's JSON→zod converter only supports these three
  primitive types and will throw a clear registration error otherwise. If you
  need structured data, encode it as a JSON string param and `JSON.parse` it
  inside your function.
- **`example`** — a realistic call. This documents usage for readers of the
  page source, and you (the agent wiring this up) should actually try it — see
  the validation checklist below — before telling the user the bridge is ready.
- **`fn`** — the actual function, called with a single args object matching
  `params` (not positional arguments). Its return value (or a thrown `Error`'s
  message) becomes the MCP tool call's result. `fn` **never leaves the
  browser** — the bridge strips it before sending anything to the server; the
  server only ever sees `name`/`description`/`params`/`example`, and dispatches
  calls back to the browser by `name`, which the bridge resolves against its
  own local copy of `window.__mcpTools`.

## The `describe_tools` tool

Every tenant automatically gets a `describe_tools` MCP tool alongside
whatever the page registers — it's not something you define, it always
exists once a page connects. Calling it returns:

```json
{
  "summary": "This page is a data grid with rows keyed by id. Call list_rows before highlight_row...",
  "tools": [
    { "name": "list_rows", "description": "..." },
    { "name": "highlight_row", "description": "..." }
  ]
}
```

`summary` is `null` if the page never set `window.__mcpSummary`. Point
connecting agents at this tool first — "call `describe_tools` before
anything else from this page" — so cross-tool context lands before any
individual tool gets called. `describe_tools` is a reserved name: a page
tool with that name in `window.__mcpTools` is silently shadowed by the
built-in one and never registered.

When 2+ connections share a tenant (see "Multiple connections per tenant"
below), the response shape changes to `{connections: [...]}` instead of the
flat shape above — one entry per connection, each with its own
`summary`/`tools`, plus `id`/`label`/`toolPrefix`.

## Multiple connections per tenant

The same embed snippet can be pasted into more than one browser tab — a
different app in each, or several tabs of the same app — and both end up on
the same tenant, since a `get_embed_snippet` result stays bound to one
tenant id for its whole session. This is supported:

- With 0-1 connections, tool names are unprefixed, exactly as documented
  above — the common case is unaffected.
- Once a **second** connection registers, every tool from every connection
  gets an automatic prefix: `${slug}__${name}`. `slug` is derived from that
  connection's `window.__mcpAppName` (or `document.title`), sanitized to
  `[a-z0-9_]`, falling back to `tab` if absent/empty. Two connections
  landing on the same slug (same app label, or both unlabeled) get
  ordinal-suffixed by connection-open order: the first keeps the bare slug,
  the next becomes `slug2`, then `slug3`, etc.
- Calls are routed to exactly one connection's socket, resolved via the
  registered tool's prefix — not broadcast to every connection on the
  tenant, so a second tab never receives (or accidentally answers) a call
  meant for the first.
- Closing a tab removes its connection; if that leaves exactly one
  connection, that one's tools go back to unprefixed names.
- Cross-connection `name` reuse (two different pages/tabs both defining a
  `submit` tool, say) is fine — see the next section for why this differs
  from same-page reuse.
- A connection's label isn't fixed at registration time — see
  `window.__mcpRename` above to change it later from DevTools, which
  re-slugs and re-prefixes that connection's tools immediately.

## Common mistakes

- **Positional args instead of one args object.** `function insertTitle(title)`
  will break — the bridge always calls `fn(argsObject)`, so it must be
  `function insertTitle({ title })`.
- **Defining `window.__mcpTools` after the embed snippet runs.** The bridge
  reads it once, synchronously, when it first connects — if the array isn't
  there yet (or is still empty) at that point, no tools get registered. Define
  it earlier in the page than wherever the embed snippet ends up.
- **Reusing a `name` across two entries in the same page's own
  `window.__mcpTools`.** Registration within one page is keyed purely on
  `name`; a duplicate produces undefined/last-registered behavior. This is
  different from two *separate* pages/tabs reusing the same tool `name` —
  that's fine and expected now, each gets disambiguated automatically via a
  connection prefix (see "Multiple connections per tenant" above).
- **Expecting a live-edited tool list to take effect without a reload.**
  `window.__mcpTools` is read once per page load / bridge (re)connect, not
  polled. Editing it requires the page (and its bridge connection) to reload
  before the server picks up the change.

## Known limitation: MCP client may not see new tools until restarted

The server does the right thing when a page registers tools mid-session: it
calls `mcp.registerTool(...)` / `handle.remove()`, which trips the SDK's
`notifications/tools/list_changed` automatically (see
`createManifestToolRegistry` in `manifest-tools.ts`). But some MCP clients
(including Claude Code, observed with `js-bridge-mcp`) fetch `tools/list`
once when the connection initializes and don't re-poll on that notification
mid-session. Practical effect: if you paste the embed snippet into the page
*after* the agent's MCP client already connected, the new tools may not show
up no matter how many times you reconnect the browser tenant — the agent's
client needs a full restart (new MCP connection/initialize) to pick up the
current tool list. This is a client-side gap, not something fixable from the
server or manifest.

## Validation checklist

Before telling the user the bridge is ready:

1. Call the server's `get_embed_snippet` tool, paste the result, load the page.
2. Call `tools/list` (or just try calling your new tool by name) and confirm
   the tool(s) you declared now appear — they won't be there before the page
   loads and pushes its manifest.
3. Call each new tool with its `example` args and confirm the page visibly
   updates and the call returns a non-error result.
4. Open a second, unrelated tenant/session (e.g. call `get_embed_snippet`
   again from a fresh MCP session) and confirm the new tools do **not**
   appear there — manifests are per-tenant, not global.
5. Paste the *same* embed snippet into a second browser tab, deliberately
   sharing the tenant. Call `describe_tools` and confirm it now reports two
   connections with distinct labels/prefixes. Call one of the newly
   prefixed tools and confirm only the intended tab updates. Close one tab
   and confirm `describe_tools` reports a single connection again with that
   connection's tools reachable unprefixed.
