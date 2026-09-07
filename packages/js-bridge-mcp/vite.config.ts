import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// tool-bus.js and connect.js are hand-written vanilla ES modules (see
// src/client/), not run through vite/tsc - shared infrastructure any host
// page imports by URL, not app-specific code. emptyOutDir wipes dist/client/
// on every build (including each `vite build --watch` rebuild), so they
// have to be re-copied via closeBundle rather than a one-off npm script
// step, or a watch rebuild would leave them missing.
//
// sdk.ts is NOT in this list - it's a real TS entrypoint compiled by vite's
// own lib-mode build below (dist/client/sdk.js), and its .d.ts comes from a
// dedicated `tsc -p tsconfig.sdk.json` pass (see package.json's "build"
// script) - not copied verbatim like these two.
function copyClientExtras(): Plugin {
  const files = ['tool-bus.js', 'connect.js'];
  return {
    name: 'copy-client-extras',
    closeBundle() {
      for (const file of files) {
        const src = resolve(__dirname, 'src/client', file);
        const dest = resolve(__dirname, 'dist/client', file);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
      }
    },
  };
}

// Library mode, not HTML-entry mode: main.js is loaded cross-origin by an
// unrelated static page via a fixed URL (<script src=".../main.js">), and
// sdk.js is resolved as a normal npm dependency (js-bridge-mcp/client) by a
// bundler-based host app - either way the output filename must be stable
// rather than content-hashed. Multi-entry lib mode (Vite 4+) emits one file
// per entry key under the shared outDir, so both land in dist/client/
// alongside tool-bus.js/connect.js from copyClientExtras above.
export default defineConfig({
  plugins: [copyClientExtras()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'esnext',
    lib: {
      entry: { main: 'src/client/main.ts', sdk: 'src/client/sdk.ts' },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
  },
});
