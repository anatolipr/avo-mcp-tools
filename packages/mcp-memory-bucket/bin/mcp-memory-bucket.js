#!/usr/bin/env node
if (process.argv[2] === 'stop') {
  const { execSync } = await import('node:child_process');
  const port = process.env.PORT || 8767;
  try {
    execSync(`kill -9 $(lsof -ti :${port})`, { stdio: 'ignore' });
    console.error(`[mcp-memory-bucket] stopped server on port ${port}`);
  } catch {
    console.error(`[mcp-memory-bucket] no server running on port ${port}`);
  }
  process.exit(0);
}

await import('../dist/src/server.js');
