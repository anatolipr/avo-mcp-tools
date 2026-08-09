# mcp-terminal

Sandboxed filesystem + shell tools for agents, exposed two ways from one
shared tool registry:

- **`npm run mcp`** — a real MCP server (stdio) for clients that can connect
  directly (Claude Code, Claude Desktop, any MCP-speaking agent).
- **`npm run relay`** — a local web page for agents with *no* direct tool
  access (a plain chat session): it hosts `window.__mcpTools` and imports
  the same `<human-mcp-relay>` popup used by htmlpaint.com/mindfoo
  (`human-mcp-relay.js`, loaded live from `--relay-url`, default
  `https://htmlpaint.com/human-mcp/relay.js`) — copy a primer into the chat,
  paste `HUMAN-MCP CALL` blocks back into the popup, no new UI to learn if
  you've used that popup before.

Both modes share one `ToolRegistry` (`src/tools/registry.ts`), so the tool
set and its safety envelope are identical either way.

## Tools

| Tool | Description |
|---|---|
| `list_dir` | List entries in a directory, optionally recursive |
| `read_file` | Read a text file (paginated via `offset`) |
| `write_file` | Overwrite/create a text file |
| `mkdir` | Create a directory (like `mkdir -p`) |
| `move_path` | Move/rename a file or directory |
| `delete_path` | Delete a file or directory (irreversible) |
| `find_files` | Find files by glob-ish name pattern |
| `grep` | Search file contents by substring/regex |
| `run_command` | Run a shell command — scaffolding, installs, builds, tests, git. **Disabled by default.** |

## Safety

- **Sandbox jail**: every path tool resolves through `src/sandbox.ts`, which
  rejects any path (relative `..`, absolute, or via a symlink) that resolves
  outside the sandbox root. The root defaults to the directory
  `mcp-terminal` was started in and is only settable via `--dir` at launch —
  never by a tool call — so a confused or adversarial agent can't widen its
  own jail mid-session.
- **`run_command` is opt-in**: it's the one tool that can do real damage or
  reach outside the file sandbox's guarantees (network access, arbitrary
  binaries). It throws immediately unless the process was started with
  `--allow-exec`. Output is capped (100 KB) and time-limited (default 60s,
  max 10 min) so a hanging/runaway command can't wedge the session.
- **`delete_path`/`move_path`/`write_file`/`run_command`** are flagged
  `destructive: true` in the tool manifest so any UI (or client policy) can
  surface a confirmation step before calling them.
- Every session's first message to the agent (the MCP `instructions` field,
  or `__mcpSummary` in relay mode) states the host OS, shell, node version,
  and sandbox root up front — the agent shouldn't need a probing round-trip
  to find out it's on macOS vs. Linux before proposing a command.

## Run it

```bash
npm install

# Direct MCP (stdio) — point an MCP client at this command:
npm run mcp -- --dir ./my-project --allow-exec

# Human relay — opens a browser tab, paste primer into chat:
npm run relay -- --dir ./my-project --allow-exec
```

Flags (both entry points):

- `--dir <path>` — sandbox root (default: cwd)
- `--allow-exec` — enables `run_command` (default: disabled)
- `--relay-url <url>` — where to import the relay popup from (relay mode
  only; default `https://htmlpaint.com/human-mcp/relay.js`)
- `--port <n>` — relay server port (relay mode only, default 8799)
- `--no-open` — don't auto-open a browser tab (relay mode only)

## How the relay mode works

1. `relay-server.ts` starts a local HTTP+WS server and serves one page.
2. The page's `client.js` fetches `/manifest.json` (the tool registry minus
   `fn`) and builds `window.__mcpTools`, wiring each tool's `fn` to a
   WebSocket round-trip back into the Node process — same contract
   `js-bridge-mcp` and `mindfoo`'s `mcpbridge.ts` use, just server-backed
   instead of DOM-backed.
3. The page then dynamically imports the relay popup from `--relay-url`
   (unmodified — it's already host-agnostic, reading only
   `window.__mcpTools`/`__mcpSummary`/`document.title`).
4. Open the popup (`Cmd/Ctrl+Shift+A`), copy the primer into your agent chat,
   paste `HUMAN-MCP CALL` blocks back as the agent sends them.

No multi-tenant/WebSocket-tenant-id machinery is needed here (unlike
`js-bridge-mcp`) — this server only ever serves one page to one local user.
