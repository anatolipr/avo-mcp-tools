#!/usr/bin/env node
if (process.argv[2] === 'stop') {
  const { execSync } = await import('node:child_process');
  const port = process.env.PORT || 8766;
  try {
    execSync(`kill -9 $(lsof -ti :${port})`, { stdio: 'ignore' });
    console.error(`[js-bridge-mcp] stopped server on port ${port}`);
  } catch {
    console.error(`[js-bridge-mcp] no server running on port ${port}`);
  }
  process.exit(0);
}

await import('../dist/src/server.js');
