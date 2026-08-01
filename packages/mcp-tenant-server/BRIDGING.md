# Bridging an existing page's functions to MCP tools

This doc is for wiring up **which functions an already-running `js-bridge-mcp`-style
server exposes as MCP tools**, given a page (existing or new) that you can add a
small JSON block and a couple of `window.*` functions to. It assumes the MCP
server, its `/mcp` and `/ws` endpoints, and a `get_embed_snippet`-equivalent tool
already exist and are running — you are not building a new package here.

## When to use this vs. `AGENTS.md`

- **No MCP server exists yet for this page at all** → see `AGENTS.md` in this
  package (Pattern A or B) to scaffold one first, then come back here to add tools.
- **A server already exists (e.g. `js-bridge-mcp`) and you just need to add,
  change, or remove which page functions it exposes as tools** → this doc.

## The three things a page needs

1. **One global `window.*` function per capability**, each taking a **single
   args object** (not positional parameters) and returning a JSON-serializable
   value, or throwing an `Error` with a useful message. The return value (or
   error message) becomes the MCP tool call's result.
2. **A `<script id="mcp-tools" type="application/json">` block** declaring one
   manifest entry per function you want exposed (schema below).
3. **The embed snippet** — one line of executable JavaScript obtained by
   calling the server's `get_embed_snippet` tool (or equivalent), e.g.
   `import("http://localhost:8766/main.js?server=...&tenant=...");`.
   - **Primary path (developer, today): paste it directly into the target
     page's DevTools console and press enter.** No source edit needed —
     this is the expected workflow right now, since the person wiring this
     up usually has the page open in a browser they control.
   - **Alternative: bake it into the page's HTML** as
     `<script type="module">import("...");</script>` (or the `src="..."`
     form the snippet's URL alone implies), placed **after** the two items
     above, so the `window.*` functions and the manifest both exist before
     the bridge script runs and reads them.

## Manifest entry schema

Each entry in the `#mcp-tools` JSON array:

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

Matching page-side function:

```js
function highlightRow({ rowId, color }) {
  const row = document.getElementById(rowId);
  if (!row) throw new Error(`no row with id "${rowId}"`);
  row.style.backgroundColor = color ?? 'yellow';
  return `highlighted ${rowId}`;
}
window.highlightRow = highlightRow;
```

### Field reference

- **`name`** — the MCP tool name the agent will see and call. snake_case by
  convention (matches this codebase's other tools, e.g. `insert_title`,
  `get_embed_snippet`). Must be unique within this page's manifest.
- **`description`** — **written for other agents, not humans.** This is read
  by whatever AI agent is deciding whether and how to call your tool — hold it
  to the same bar as a hand-written tool description in source code: state
  what it does, any preconditions ("call X first"), and side effects. For
  calibration, look at `get_embed_snippet`'s description in
  `packages/js-bridge-mcp/src/tools/hello-tools.ts` — it explains not just
  what the tool returns but what to do with the result and why.
- **`target`** — must exactly match a `window.*` function name that exists by
  the time the embed script runs.
- **`params`** — a flat object. Each value is `{ type, description?, optional? }`
  where `type` is `"string"`, `"number"`, or `"boolean"`. **No nested objects
  or arrays** — the server's JSON→zod converter only supports these three
  primitive types and will throw a clear registration error otherwise. If you
  need structured data, encode it as a JSON string param and `JSON.parse` it
  inside your `target` function.
- **`example`** — a realistic call. This documents usage for readers of the
  page source, and you (the agent wiring this up) should actually try it — see
  the validation checklist below — before telling the user the bridge is ready.

## Common mistakes

- **Positional args instead of one args object.** `function insertTitle(title)`
  will break — the bridge always calls `target(argsObject)`, so it must be
  `function insertTitle({ title })`.
- **Placing `#mcp-tools` after the embed `<script type="module">`.** The
  bootstrap reads the manifest once, synchronously, when the WebSocket first
  connects — if the JSON block isn't in the DOM yet at that point, it reads
  as empty. Put it before the pasted snippet.
- **Reusing a `name` across two entries in the same manifest.** Registration
  is keyed purely on `name`; a duplicate produces undefined/last-registered
  behavior.
- **Expecting a live-edited manifest to take effect without a reload.** The
  manifest is read once per page load / WebSocket (re)connect, not polled.
  Editing the JSON block requires the page (and its socket) to reconnect
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
