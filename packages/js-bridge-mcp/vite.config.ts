import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// tool-bus.js is a hand-written vanilla ES module (see src/client/tool-bus.js),
// not run through vite/tsc - it's shared infrastructure, not app-specific
// code. emptyOutDir wipes dist/client/ on every build (including each
// `vite build --watch` rebuild), so it has to be re-copied via closeBundle
// rather than a one-off npm script step, or a watch rebuild would leave it
// missing.
function copyToolBus(): Plugin {
  const src = resolve(__dirname, 'src/client/tool-bus.js');
  const dest = resolve(__dirname, 'dist/client/tool-bus.js');
  return {
    name: 'copy-tool-bus',
    closeBundle() {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    },
  };
}

// Library mode, not HTML-entry mode: this bundle is loaded cross-origin by
// an unrelated static page via a fixed URL (<script src=".../main.js">),
// so the output filename must be stable rather than content-hashed.
export default defineConfig({
  plugins: [copyToolBus()],
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
