import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { getBuildTarget } from './copy-manifest-plugin.js';

// Standard Vite multi-page-app build (HTML entry, not lib mode) for
// popup.html/popup.ts/popup.css. Runs AFTER vite.background.config.ts in
// package.json's chained build script - emptyOutDir MUST be false here, or
// it would wipe out background.js/manifest.json/icons the previous step
// just wrote into the same dist/<target>/ directory.
const target = getBuildTarget();

export default defineConfig({
  root: resolve(__dirname, '../src/popup'),
  // Extension pages are served from chrome-extension://<id>/ (or Firefox's
  // moz-extension://) - relative asset paths are the safe default here,
  // since an absolute "/" root-relative path assumes a normal http(s) origin
  // Vite's default base otherwise targets.
  base: '',
  build: {
    outDir: resolve(__dirname, `../dist/${target}`),
    emptyOutDir: false,
    target: 'esnext',
    rollupOptions: {
      input: resolve(__dirname, '../src/popup/popup.html'),
      output: {
        entryFileNames: 'popup.js',
        assetFileNames: (info) => (info.name === 'popup.css' ? 'popup.css' : 'assets/[name][extname]'),
      },
    },
  },
});
