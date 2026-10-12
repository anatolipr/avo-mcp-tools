#!/usr/bin/env node
if (process.stderr.isTTY && !process.argv.includes('--help') && !process.argv.includes('-h')) {
	process.stderr.write('\x1b]0;mcp-terminal\x07');
}

await import('../dist/src/mcp-server.js');
