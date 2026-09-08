import type { Plugin } from 'vite';
import { copyFileSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Modeled on packages/js-bridge-mcp/vite.config.ts's copyClientExtras:
// copies the target-specific manifest (manifests/chrome.manifest.json or
// manifests/firefox.manifest.json, selected via BUILD_TARGET) to
// dist/<target>/manifest.json, plus icons/. Runs on closeBundle (fires on
// every rebuild, including --watch) since emptyOutDir wipes the dir each
// time, same reasoning as the original plugin.
export function copyManifestAndIcons(target: 'chrome' | 'firefox'): Plugin {
  return {
    name: 'copy-manifest-and-icons',
    closeBundle() {
      const root = resolve(__dirname, '..');
      const manifestSrc = resolve(root, 'manifests', `${target}.manifest.json`);
      const manifestDest = resolve(root, 'dist', target, 'manifest.json');
      mkdirSync(dirname(manifestDest), { recursive: true });
      copyFileSync(manifestSrc, manifestDest);

      const iconsSrc = resolve(root, 'icons');
      const iconsDest = resolve(root, 'dist', target, 'icons');
      cpSync(iconsSrc, iconsDest, { recursive: true });
    },
  };
}

export function getBuildTarget(): 'chrome' | 'firefox' {
  const target = process.env.BUILD_TARGET ?? 'chrome';
  if (target !== 'chrome' && target !== 'firefox') {
    throw new Error(`Invalid BUILD_TARGET "${target}" - expected "chrome" or "firefox"`);
  }
  return target;
}
