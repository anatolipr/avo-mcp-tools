import { defineConfig } from 'vite';

export default defineConfig({
  root: 'public',
  // Manifest, icons, and the service worker must land at fixed, unhashed
  // paths (browsers fetch /manifest.webmanifest and /sw.js by convention,
  // and the manifest's icon entries are plain strings Vite never rewrites)
  // — publicDir copies them through untouched instead of treating them as
  // hashed build assets. Resolved relative to project root, not `root` above.
  publicDir: '../public-static',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'esnext',
  },
});
