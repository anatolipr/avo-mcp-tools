import { defineConfig } from 'vite';

// Library mode, not HTML-entry mode: this bundle is loaded cross-origin by
// an unrelated static page via a fixed URL (<script src=".../main.js">),
// so the output filename must be stable rather than content-hashed.
export default defineConfig({
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
