import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// tool-bus.js and connect.js are hand-written vanilla ES modules (see
// src/client/), not run through vite/tsc - shared infrastructure any host
// page imports by URL, not app-specific code. emptyOutDir wipes dist/client/
// on every build (including each `vite build --watch` rebuild), so they
// have to be re-copied via closeBundle rather than a one-off npm script
// step, or a watch rebuild would leave them missing.
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

// Library mode, not HTML-entry mode: this bundle is loaded cross-origin by
// an unrelated static page via a fixed URL (<script src=".../main.js">),
// so the output filename must be stable rather than content-hashed.
export default defineConfig({
  plugins: [copyClientExtras()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'esnext',
    lib: {
      entry: 'src/client/main.ts',
      formats: ['es'],
      fileName: () => 'main.js',
    },
  },
});
