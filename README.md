# avo-mcp-tools

A minimal working example of the pattern: one Node process holds a shared,
in-memory store; a browser tab (Lit web component, signal-backed input)
syncs to it over WebSocket; an MCP server exposes `get`/`set` tools over the
same store, so an agent and a human can both read and write the same field
live.

```
 browser tab (Lit) <--WS--> [ mcp-tenant-server ]  <--MCP/HTTP--> agent (Claude, etc.)
                              Store (single
                              source of truth)
```

This repo is an npm workspace with two packages:
- `packages/mcp-tenant-server/` — generic tenant/session bookkeeping + MCP/HTTP/WS
  wiring, reusable across projects.
- `packages/mcp-form/` — this form app: field config, MCP tool definitions,
  and the Lit UI. Depends on `mcp-tenant-server`.

Fields are declared once, in `packages/mcp-form/config/fields.json` — the
UI and the MCP tools are both generated from that file. Add a field there and
it's immediately gettable/settable, no new code required.

## Setup

```bash
npm install
npm start -w mcp-form
```

This starts an HTTP+WebSocket server (default `http://localhost:8765`)
serving the form page, with MCP exposed over streamable HTTP at `/mcp` on
the same port.

Open `http://localhost:8765` in a browser to see the live form.

## Wiring it into Claude Desktop, Claude Code, or Copilot

The server exposes MCP over streamable HTTP at `/mcp` on the same port as
the web UI (needs the server already running via `npm start -w mcp-form`):

```json
{
  "mcpServers": {
    "mcp-form": {
      "type": "http",
      "url": "http://localhost:8765/mcp"
    }
  }
}
```

Add this to `claude_desktop_config.json`, `.mcp.json` for Claude Code, or
your Copilot MCP config file.

Then, in a conversation:

- **"What's the form URL?"** → calls `get_form_url`, gives you the link to open
- **"What is the firstName field value?"** → calls `get_field`
- **"Set firstName to Joe"** → calls `set_field`, which updates the store and
  broadcasts to every open browser tab over WebSocket — you'll see the input
  update live, with no page reload

## Adding more fields

Edit `packages/mcp-form/config/fields.json`:

```json
{
  "fields": [
    { "name": "firstName", "label": "First Name", "type": "string", "default": "" },
    { "name": "email", "label": "Email", "type": "string", "default": "" }
  ]
}
```

Restart the server. The new field renders in the UI automatically, and
`get_field`/`set_field` accept it immediately (the MCP tool schema's `field`
enum is generated from this file at startup).

## Where to take this next

- **Per-field types beyond string** — `type` in the config is currently
  informational only; wire it into both the `<input>`'s `type=` attribute
  and a per-field zod schema (`number`, `boolean`, etc.) for `set_field`.
- **Risk tiers** — add a `risk: "safe" | "destructive"` field to the config
  and have the MCP tool require an extra confirmation step for destructive
  writes before this pattern touches anything real.
- **Resources, not just tools** — expose each field as an MCP *resource*
  too (not only a tool), so an agent can subscribe to `resources/updated`
  instead of polling `get_field`.
- **Swap the transport** — the `Store` class doesn't know or care whether
  it's being driven by streamable-HTTP MCP, WebMCP
  (`navigator.modelContext`), or a browser-extension bridge — only
  `packages/mcp-tenant-server/src/http.ts` would change.
- **Reuse the server for another project** — see
  `docs/refactor-plan.md` for the in-progress plan to make
  `mcp-tenant-server` pluggable into non-form projects (e.g. adding MCP
  tools to an existing TODO app).
