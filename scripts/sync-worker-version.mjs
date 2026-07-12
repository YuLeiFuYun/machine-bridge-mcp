#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(repoRoot, "package.json");
const workerPath = path.join(repoRoot, "src", "worker", "index.ts");
const extensionManifestPath = path.join(repoRoot, "browser-extension", "manifest.json");
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const log = message => process.stderr.write(`${message}\n`);

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const expected = String(pkg.version || "").trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expected)) {
  fail(`package.json version is not a valid release version: ${JSON.stringify(expected)}`);
}

const workerSource = readFileSync(workerPath, "utf8");
const workerPattern = /const SERVER_VERSION = "([^"]+)";/;
const workerMatch = workerSource.match(workerPattern);
if (!workerMatch) fail("Could not find `const SERVER_VERSION = \"...\";` in src/worker/index.ts");

const extension = JSON.parse(readFileSync(extensionManifestPath, "utf8"));
const extensionVersion = expected.split(/[+-]/, 1)[0];
const extensionParts = extensionVersion.split(".").map((value) => Number(value));
if (extensionParts.length < 1 || extensionParts.length > 4 || extensionParts.some((value) => !Number.isInteger(value) || value < 0 || value > 65535)) {
  fail(`package version cannot be represented as a Chromium extension version: ${expected}`);
}
const mismatches = [];
if (workerMatch[1] !== expected) mismatches.push(`Worker=${workerMatch[1]}`);
if (String(extension.version || "") !== extensionVersion) mismatches.push(`browser-extension.version=${extension.version || "<missing>"}`);
if (String(extension.version_name || "") !== expected) mismatches.push(`browser-extension.version_name=${extension.version_name || "<missing>"}`);

if (!mismatches.length) {
  log(`Runtime versions are in sync: ${expected}`);
  process.exit(0);
}
if (checkOnly) {
  fail(`Version mismatch: package.json=${expected}; ${mismatches.join(", ")}. Run npm run version:sync.`);
}

if (workerMatch[1] !== expected) {
  writeFileSync(workerPath, workerSource.replace(workerPattern, `const SERVER_VERSION = "${expected}";`));
  log(`Updated Worker version: ${workerMatch[1]} -> ${expected}`);
}
extension.version = extensionVersion;
extension.version_name = expected;
writeFileSync(extensionManifestPath, `${JSON.stringify(extension, null, 2)}\n`);
log(`Updated browser extension version: ${extensionVersion} (${expected})`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
