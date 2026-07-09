#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(repoRoot, "package.json");
const workerPath = path.join(repoRoot, "src", "worker", "index.ts");
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const expected = String(pkg.version || "").trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expected)) {
  fail(`package.json version is not a valid release version: ${JSON.stringify(expected)}`);
}

const source = readFileSync(workerPath, "utf8");
const pattern = /const SERVER_VERSION = "([^"]+)";/;
const match = source.match(pattern);
if (!match) fail("Could not find `const SERVER_VERSION = \"...\";` in src/worker/index.ts");

const current = match[1];
if (current === expected) {
  console.log(`Worker version is in sync: ${expected}`);
  process.exit(0);
}

if (checkOnly) {
  fail(`Worker version mismatch: package.json=${expected}, src/worker/index.ts=${current}. Run npm run version:sync.`);
}

const updated = source.replace(pattern, `const SERVER_VERSION = "${expected}";`);
writeFileSync(workerPath, updated);
console.log(`Updated Worker version: ${current} -> ${expected}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
