#!/usr/bin/env node
// Compares each workspace package's local version to what's published on npm
// and prints `npm publish` commands for anything that's out of sync.

import { readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagesDir = path.join(rootDir, "packages");

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

const results = [];

for (const dir of pkgDirs) {
  const pkgPath = path.join(packagesDir, dir, "package.json");
  let pkg;
  try {
    pkg = readJson(pkgPath);
  } catch {
    continue;
  }
  if (pkg.private) continue;

  const local = pkg.version;
  const published = publishedVersion(pkg.name);
  const status = published === null ? "unpublished" : published === local ? "up-to-date" : "behind";

  results.push({ dir, name: pkg.name, local, published, status });
}

const pad = (s, n) => String(s).padEnd(n);
const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
const dirWidth = Math.max(7, ...results.map((r) => r.dir.length));

console.log(
  pad("package", dirWidth),
  pad("npm name", nameWidth),
  pad("published", 10),
  pad("local", 10),
  "status",
);
for (const r of results) {
  console.log(
    pad(r.dir, dirWidth),
    pad(r.name, nameWidth),
    pad(r.published ?? "(none)", 10),
    pad(r.local, 10),
    r.status,
  );
}

const needsPublish = results.filter((r) => r.status !== "up-to-date");

if (needsPublish.length === 0) {
  console.log("\nAll packages are up to date with npm.");
} else {
  console.log("\nRun these to publish:\n");
  for (const r of needsPublish) {
    console.log(`(cd packages/${r.dir} && npm publish)`);
  }
}
