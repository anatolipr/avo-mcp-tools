#!/usr/bin/env node
if (process.argv[2] === 'stop') {
  const { execSync } = await import('node:child_process');
  const port = process.env.PORT || 8766;
  try {
    // -sTCP:LISTEN: without it lsof also lists every CLIENT connected to the
    // port (a browser tab's bridge socket, the editor's MCP session) and this
    // would kill those too.
    execSync(`kill -9 $(lsof -ti tcp:${port} -sTCP:LISTEN)`, { stdio: 'ignore' });
    console.error(`[js-bridge-mcp] stopped server on port ${port}`);
  } catch {
    console.error(`[js-bridge-mcp] no server running on port ${port}`);
  }
  process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: js-bridge-mcp [options]
       js-bridge-mcp stop

Options:
  --allow-remote         Accept connections from other devices (default: this machine only).
                         Env: JS_BRIDGE_MCP_ALLOW_REMOTE=1
  --allow-origin <url>   Let pages on this web origin call /mcp and /api/* (repeatable).
                         Not needed for pages that only bridge in (/ws, /main.js).
                         Env: JS_BRIDGE_MCP_ALLOWED_ORIGINS=<url>,<url>
  --force-kill-port      Kill whatever holds the port, even if it is not js-bridge-mcp.
                         Env: JS_BRIDGE_MCP_FORCE_KILL_PORT=1
  -h, --help             Show this help.

Environment:
  PORT                         Port to listen on (default 8766).
  PROXY_CONFIG_PATH            Proxy config file (default ~/.js-bridge-mcp-proxies.json).
  PROXY_CALL_TIMEOUT_MS        Default timeout for proxied tool calls (default 60000).
  JS_BRIDGE_MCP_PROXY_RECONNECT=0   Do not auto-reconnect a proxy whose upstream dropped.
  JS_BRIDGE_MCP_NO_OPEN=1      Do not open the dashboard in a browser on start.`);
  process.exit(0);
}

await import('../dist/src/server.js');
