# mcp-form

Tiny Lit web component with a signal-backed text field, synced live to an MCP server so an
agent can read/write it.

## Usage

```
npx mcp-form
```

Starts the server (default port 8765) and prints a URL for the live form UI. Connect an MCP
client to the same server to read/write field values as tools.
