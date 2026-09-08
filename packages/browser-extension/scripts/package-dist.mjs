#!/usr/bin/env node
// Core logic behind both `bin/browser-extension.js` (npx entry point for a
// non-developer end user) and the GitHub Actions release workflow. Copies
// (or zips, with --zip) dist/chrome/ and dist/firefox/ into a plain output
// folder - for the npx case this is a folder the user picked (or a default
// one under their cwd), for CI it's the release-artifacts staging dir the
// workflow then attaches to a GitHub Release.
//
// Split out of bin/browser-extension.js itself (not living there directly)
// so the GitHub Actions workflow can invoke this exact same logic directly
// via `node scripts/package-dist.mjs --zip --out ./release-artifacts`
// without going through the npm-installed bin wrapper.
import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import archiver from 'archiver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const TARGETS = ['chrome', 'firefox'];

function parseArgs(argv) {
  const args = { outDir: 'avo-browser-extension', zip: false, rebuild: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--zip') args.zip = true;
    else if (arg === '--rebuild') args.rebuild = true;
    else if (arg.startsWith('--out=')) args.outDir = arg.slice('--out='.length);
    else if (arg === '--out') args.outNext = true;
    else if (args.outNext) {
      args.outDir = arg;
      args.outNext = false;
    } else positional.push(arg);
  }
  if (positional[0]) args.outDir = positional[0];
  return args;
}

function zipDirectory(sourceDir, destZipPath) {
  return new Promise((resolvePromise, reject) => {
    const output = createWriteStream(destZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolvePromise());
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

export async function runBuildAndPackage(argv) {
  const args = parseArgs(argv);
  const distDir = resolve(packageRoot, 'dist');
  const missingTargets = TARGETS.filter((t) => !existsSync(join(distDir, t, 'manifest.json')));

  // Common case (published npm package): dist/ ships already-built via
  // prepublishOnly, so a plain `npx browser-extension` just packages what's
  // there - no build step at run time. Only builds when dist/ is missing a
  // target (a fresh checkout, not the published tarball) or --rebuild was
  // explicitly passed.
  if (args.rebuild || missingTargets.length > 0) {
    console.log(`Building ${args.rebuild ? 'both targets (--rebuild)' : `missing target(s): ${missingTargets.join(', ')}`}...`);
    const result = spawnSync('npm', ['run', 'build'], { cwd: packageRoot, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('Build failed.');
      process.exitCode = result.status ?? 1;
      return;
    }
  }

  const outDir = resolve(process.cwd(), args.outDir);
  mkdirSync(outDir, { recursive: true });

  for (const target of TARGETS) {
    const sourceDir = join(distDir, target);
    if (!existsSync(join(sourceDir, 'manifest.json'))) {
      console.error(`dist/${target}/manifest.json is missing even after build — something is wrong with the build itself.`);
      process.exitCode = 1;
      return;
    }

    if (args.zip) {
      const zipPath = join(outDir, `${target}.zip`);
      await zipDirectory(sourceDir, zipPath);
      console.log(`Wrote ${zipPath}`);
    } else {
      const targetOutDir = join(outDir, target);
      rmSync(targetOutDir, { recursive: true, force: true });
      cpSync(sourceDir, targetOutDir, { recursive: true });
      console.log(`Wrote ${targetOutDir}/`);
    }
  }

  printInstructions(outDir, args.zip);
}

function printInstructions(outDir, zipped) {
  console.log('');
  console.log('Done! To load the extension:');
  console.log('');
  console.log('Chrome:');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable "Developer mode" (top right)');
  console.log('  3. Click "Load unpacked"');
  console.log(
    zipped
      ? `  4. Unzip ${join(outDir, 'chrome.zip')} first, then select the unzipped folder`
      : `  4. Select ${join(outDir, 'chrome')}`
  );
  console.log('');
  console.log('Firefox:');
  console.log('  1. Open about:debugging#/runtime/this-firefox');
  console.log('  2. Click "Load Temporary Add-on"');
  console.log(
    zipped
      ? `  3. Unzip ${join(outDir, 'firefox.zip')} first, then select any file inside (e.g. manifest.json)`
      : `  3. Select any file inside ${join(outDir, 'firefox')} (e.g. manifest.json)`
  );
  console.log('');
}

// Direct-execution entry point: `node scripts/package-dist.mjs [args]`
// (used by the GitHub Actions release workflow) as opposed to
// bin/browser-extension.js's `import { runBuildAndPackage } from
// '../scripts/package-dist.mjs'`. Guarded so importing this module (the bin
// wrapper's use case) never triggers a run as a side effect of the import
// itself.
if (import.meta.url === `file://${process.argv[1]}`) {
  await runBuildAndPackage(process.argv.slice(2));
}
