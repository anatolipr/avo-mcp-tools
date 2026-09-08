#!/usr/bin/env node
// npx entry point for a non-developer end user: `npx browser-extension
// [outDir] [--zip] [--rebuild]`. Builds (if needed) and packages both
// browser targets into an ordinary folder (or zips), then prints
// load-unpacked instructions for both browsers. Actual logic lives in
// scripts/package-dist.mjs (kept out of this file, same separation
// js-bridge-mcp's bin-wrapper-imports-dist pattern establishes), which the
// GitHub Actions release workflow also calls directly.
import { runBuildAndPackage } from '../scripts/package-dist.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: npx browser-extension [outDir] [options]

Builds and packages the js-bridge-mcp Connector browser extension for
Chrome and Firefox into a plain folder you can load unpacked.

  outDir          Output directory (default: ./avo-browser-extension)
  --zip           Produce chrome.zip/firefox.zip instead of plain folders
  --rebuild       Force a fresh build even if dist/ already exists
  --out <dir>     Same as passing outDir positionally
`);
  process.exit(0);
}

await runBuildAndPackage(argv);
