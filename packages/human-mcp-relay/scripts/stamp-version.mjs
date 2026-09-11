#!/usr/bin/env node
// Stamps package.json's "version" into the VERSION constant in src/relay.js.
// relay.js is loaded standalone via jsDelivr (see its header comment), not
// bundled, so it can't import package.json at runtime - this keeps the two
// in sync automatically at publish time instead of relying on someone
// updating both by hand.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const relayPath = path.join(pkgDir, "src", "relay.js");
const { version } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));

const source = readFileSync(relayPath, "utf8");
const pattern = /const VERSION = '[^']*';/;

if (!pattern.test(source)) {
  console.error("stamp-version: could not find `const VERSION = '...'` in src/relay.js");
  process.exit(1);
}

writeFileSync(relayPath, source.replace(pattern, `const VERSION = '${version}';`));
console.log(`stamp-version: src/relay.js VERSION set to ${version}`);
