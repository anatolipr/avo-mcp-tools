#!/usr/bin/env node
// Publishes every workspace package whose local package.json version is
// ahead of what's on npm, in dependency order (a package that depends on
// another publishable package in this workspace is published after it, so
// npm always sees the new version of its dependency before the dependent
// itself goes out). Used by .github/workflows/publish.yml on push to main;
// safe to run locally too (e.g. `node scripts/publish-changed.mjs --dry-run`).
//
// Reuses the same "local version vs `npm view` version" comparison as
// check-unpublished.mjs, but acts on the result instead of just printing it.

import { readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagesDir = path.join(rootDir, "packages");
const dryRun = process.argv.includes("--dry-run");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function publishedVersion(name) {
  try {
    return execSync(`npm view ${name} version`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null; // not published yet, or lookup failed
  }
}

const pkgDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const packages = new Map(); // name -> { dir, pkg, internalDeps: string[] }

for (const dir of pkgDirs) {
  const pkgPath = path.join(packagesDir, dir, "package.json");
  let pkg;
  try {
    pkg = readJson(pkgPath);
  } catch {
    continue;
  }
  if (pkg.private) continue;

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  packages.set(pkg.name, { dir, pkg, internalDeps: [] });
}

// Resolve internal deps only after every package's own name is known, so
// dependency edges can be matched by npm package name regardless of which
// directory name a package happens to live under.
for (const [name, entry] of packages) {
  const deps = { ...entry.pkg.dependencies, ...entry.pkg.devDependencies };
  entry.internalDeps = Object.keys(deps).filter((d) => packages.has(d));
}

const needsPublish = new Map();
for (const [name, entry] of packages) {
  const local = entry.pkg.version;
  const published = publishedVersion(name);
  if (published !== local) needsPublish.set(name, { ...entry, local, published });
}

if (needsPublish.size === 0) {
  console.log("No package versions changed since the last publish — nothing to do.");
  process.exit(0);
}

// Topological sort (dependencies before dependents) restricted to the set
// that actually needs publishing — a package whose dependency didn't change
// version doesn't need to wait on anything.
const ordered = [];
const visiting = new Set();
const visited = new Set();

function visit(name) {
  if (visited.has(name)) return;
  if (visiting.has(name)) {
    throw new Error(`circular internal dependency detected involving "${name}"`);
  }
  if (!needsPublish.has(name)) return;
  visiting.add(name);
  for (const dep of needsPublish.get(name).internalDeps) visit(dep);
  visiting.delete(name);
  visited.add(name);
  ordered.push(name);
}

for (const name of needsPublish.keys()) visit(name);

console.log(`Publishing ${ordered.length} package(s) in dependency order:\n`);
for (const name of ordered) {
  const { dir, local, published } = needsPublish.get(name);
  console.log(`  ${name}: ${published ?? "(unpublished)"} -> ${local}  (packages/${dir})`);
}
console.log("");

for (const name of ordered) {
  const { dir } = needsPublish.get(name);
  const cwd = path.join(packagesDir, dir);
  console.log(`>>> npm publish (packages/${dir})`);
  if (dryRun) continue;
  execSync("npm publish", { cwd, stdio: "inherit" });
}

console.log(dryRun ? "\nDry run complete — nothing was actually published." : "\nDone.");
