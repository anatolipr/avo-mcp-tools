#!/usr/bin/env node
if (process.argv[2] === 'stop') {
  const { execSync } = await import('node:child_process');
  const port = process.env.PORT || 8765;
  try {
    execSync(`kill -9 $(lsof -ti :${port})`, { stdio: 'ignore' });
    console.error(`[mcp-form] stopped server on port ${port}`);
  } catch {
    console.error(`[mcp-form] no server running on port ${port}`);
  }
  process.exit(0);
}

if (process.stderr.isTTY && !process.argv.includes('--help') && !process.argv.includes('-h')) {
  process.stderr.write('\x1b]0;mcp-form\x07');
}

await import('../dist/src/server.js');
