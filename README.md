# mcp-form-demo

A minimal working example of the pattern: one Node process holds a shared,
in-memory store; a browser tab (Lit web component, signal-backed input)
syncs to it over WebSocket; an MCP server exposes `get`/`set` tools over the
same store, so an agent and a human can both read and write the same field
live.

```
 browser tab (Lit) <--WS--> [ server.js ]  <--stdio/MCP--> agent (Claude, etc.)
                              Store (single
                              source of truth)
```

Fields are declared once, in `config/fields.json` — the UI and the MCP tools
are both generated from that file. Add a field there and it's immediately
gettable/settable, no new code required.

## Setup

```bash
npm install
node server.js
```

This starts both:
- an HTTP+WebSocket server (default `http://localhost:8765`) serving the form page
- an MCP server on stdio, waiting for a client (e.g. Claude Desktop/Code) to connect

Open `http://localhost:8765` in a browser to see the live form.

> Note: because the MCP transport is stdio, `node server.js` run directly in
> a terminal will just sit there — that's expected. It's designed to be
> *spawned* by an MCP client, not run interactively. The HTTP server comes up
> immediately regardless.

## Wiring it into Claude Desktop or Claude Code

Add to your MCP config (`claude_desktop_config.json`, or `.mcp.json` for
Claude Code):

```json
{
  "mcpServers": {
    "mcp-form": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-form-demo/server.js"]
    }
  }
}
```

Then, in a conversation:

- **"What's the form URL?"** → calls `get_form_url`, gives you the link to open
- **"What is the firstName field value?"** → calls `get_field`
- **"Set firstName to Joe"** → calls `set_field`, which updates the store and
  broadcasts to every open browser tab over WebSocket — you'll see the input
  update live, with no page reload

## Adding more fields

Edit `config/fields.json`:

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
  it's being driven by stdio MCP, WebMCP (`navigator.modelContext`), or a
  browser-extension bridge — only the bottom section of `server.js` would
  change.
