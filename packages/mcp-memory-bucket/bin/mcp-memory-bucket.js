#!/usr/bin/env node
// Shorthand: `mcp-memory-bucket cloud` (or dev/off) is equivalent to
// `mcp-memory-bucket --folderfoo-mode cloud` — lets people skip the flag name.
if (['off', 'dev', 'cloud'].includes(process.argv[2])) {
  process.argv.splice(2, 1, '--folderfoo-mode', process.argv[2]);
}

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
