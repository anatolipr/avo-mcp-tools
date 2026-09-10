# human-mcp-relay

A drop-in `<human-mcp-relay>` popup that lets a human manually relay MCP
tool calls into a chat session that has no direct MCP connection — copy a
primer into the chat once, then round-trip `HUMAN-MCP CALL`/`HUMAN-MCP
RESULT` blocks by hand for each subsequent tool call.

No build step, no install required to use it: it's plain browser ESM, meant
to be loaded straight from jsDelivr.

## Usage

Add one script tag to any page that already exposes `window.__mcpTools`
(the same tool-array contract [js-bridge-mcp](../js-bridge-mcp)'s socket
client reads):

```html
<script type="module"
  src="https://cdn.jsdelivr.net/npm/human-mcp-relay@0/src/relay.js"></script>
```

That's it — the script self-registers a `<human-mcp-relay>` element on
`document.body` and a global `Cmd/Ctrl+Shift+A` shortcut to open it. It
needs zero per-app configuration: it only reads `window.__mcpTools` /
`window.__mcpSummary` at popup-open time, and `document.title` for display.

### `window.__mcpTools` contract

```js
window.__mcpTools = [
  {
    name: 'get_nodes',
    description: '...',
    params: { /* {paramName: {type, description}} */ },
    example: { /* optional example args */ },
    fn: async (args) => { /* returns the tool's result */ },
  },
  // ...
];
```

## What it does

1. **Primer** — `buildPrimer` (`src/primer.js`) renders the current
   `window.__mcpTools` into a pasteable Markdown block (tool list + call
   format instructions), which the human pastes into their agent/chat
   session once.
2. **Call/result round-trip** — the human pastes the agent's `HUMAN-MCP
   CALL` block into the popup, it runs the matching tool's `fn`, and copies
   a `HUMAN-MCP RESULT` block back to the clipboard to paste back into the
   chat. See `src/protocol.js` for the exact block format, including
   optional session-name tagging for bridging more than one app into the
   same agent conversation at once.

## Programmatic API (no popup/clipboard)

For an automated caller (e.g. a browser extension driving a second tab on the
human's behalf) rather than a human copy/pasting through the popup, the script
also exposes:

```js
const resultBlock = await window.__humanMcpRelay.runCall(callBlockText, sessionName);
```

`callBlockText` is a raw `HUMAN-MCP CALL[...]`...`HUMAN-MCP END` block (same
format a human would paste into the popup); the optional `sessionName`
overrides the popup's own session-name field for this one call. Returns a
formatted `HUMAN-MCP RESULT[...]`...`HUMAN-MCP END` string — the same wire
format a human would otherwise copy out of the popup by hand. This does not
touch the clipboard or the popup's own paste/result UI state; it's a separate
entry point into the same call-dispatch logic.

## Files

- `src/relay.js` — the `<human-mcp-relay>` Lit element, popup UI, keyboard
  shortcut, and clipboard round-trip logic.
- `src/primer.js` — builds the pasteable Markdown primer from
  `window.__mcpTools`.
- `src/protocol.js` — parses/formats `HUMAN-MCP CALL` / `HUMAN-MCP RESULT`
  blocks.

## License

MIT
