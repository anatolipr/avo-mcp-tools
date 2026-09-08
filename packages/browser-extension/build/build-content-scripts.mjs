#!/usr/bin/env node
// Builds each registered content script (console-capture-main/relay,
// persistent-script-runner/main-runner) via vite's build() JS API, in-process,
// rather than spawning `npx vite build --config ...` once per entry - the
// original approach paid npx's binary-resolution cost four times per target
// (eight times total for a full chrome+firefox build), which was the
// dominant cost of an otherwise-tiny build. IIFE format still doesn't support
// multi-entry in a single build call (see the removed
// vite.content-script-entry.config.ts's own comment for why), so this is
// still four separate build() calls - just without four separate child
// processes and Node startups.
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const target = process.env.BUILD_TARGET ?? 'chrome';
if (target !== 'chrome' && target !== 'firefox') {
  throw new Error(`Invalid BUILD_TARGET "${target}" - expected "chrome" or "firefox"`);
}

const entries = ['console-capture-main', 'console-capture-relay', 'persistent-script-runner', 'persistent-script-main-runner'];

for (const entryName of entries) {
  await build({
    root,
    configFile: false, // avoid picking up any other vite.config.* by accident
    logLevel: 'info',
    build: {
      outDir: `dist/${target}`,
      emptyOutDir: false, // runs after vite.background.config.ts - must not wipe its output
      target: 'esnext',
      lib: {
        entry: resolve(root, `src/content-scripts/${entryName}.ts`),
        formats: ['iife'],
        name: '__mcpContentScript',
        fileName: () => `content-scripts/${entryName}.js`,
      },
    },
  });
}
