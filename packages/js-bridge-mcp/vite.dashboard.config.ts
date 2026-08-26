import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Separate from vite.config.ts (which builds src/client/main.ts in library
// mode, for cross-origin embedding into an unrelated page) — this is a real,
// self-contained HTML app (the connected-apps dashboard), so it needs
// multi-page/app mode instead: an index.html entry, hashed asset filenames,
// its own output dir. Building it as a second entry inside the same library-
// mode config isn't supported by Vite, hence the separate config + npm script.
export default defineConfig({
  root: 'src/dashboard',
  build: {
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: resolve(__dirname, 'src/dashboard/index.html'),
    },
  },
});
