import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { copyManifestAndIcons, getBuildTarget } from './copy-manifest-plugin.js';

// Library mode: background.js is loaded by the browser directly per the
// manifest's background.service_worker (Chrome) / background.scripts
// (Firefox) entry, not resolved as an npm dependency - so its output
// filename must be stable, not content-hashed. MV3 service workers (Chrome
// 91+) and Firefox's background scripts both accept `"type": "module"` /
// ES module output, so one ESM build target serves both, no IIFE fallback
// needed.
const target = getBuildTarget();

export default defineConfig({
  root: resolve(__dirname, '..'),
  plugins: [copyManifestAndIcons(target)],
  build: {
    outDir: `dist/${target}`,
    emptyOutDir: true, // dist/chrome and dist/firefox are separate dirs - safe to wipe each target's own
    target: 'esnext',
    lib: {
      entry: { background: resolve(__dirname, '../src/background/index.ts') },
      formats: ['es'],
      fileName: () => 'background.js',
    },
  },
});
