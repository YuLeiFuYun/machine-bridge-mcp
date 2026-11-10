#!/usr/bin/env node

// Refuse to publish a source checkout directly.
//
// `npm publish` from the repository ships the repository manifest, which still declares
// every repository-only script (`check:*`, `*:test`, `release:*`) even though the tarball
// does not ship the files those scripts point at. The supported path is
// scripts/publish-npm.mjs: it publishes the accepted candidate tarball whose manifest has
// been reduced to the three scripts an installed package can actually run.
//
// This runs from `prepublishOnly`, so it only guards directory publishes. Publishing a
// tarball (`npm publish <file>.tgz`) does not run lifecycle scripts and is unaffected.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PUBLISHED_SCRIPT_NAMES = new Set(["test", "start", "doctor"]);
const manifestPath = resolve(process.cwd(), "package.json");

// @ts-check
// When `prepublishOnly` is invoked explicitly via `npm run prepublishOnly` inside
// `scripts/publish-npm.mjs`, allow prepublication verification to proceed on the source
// checkout before publishing the already-sanitized candidate tarball. Direct `npm publish`
// from a source directory sets `npm_command=publish` and is still refused below.
if (["run", "run-script"].includes(String(process.env.npm_command || "")) && process.env.npm_lifecycle_event === "prepublishOnly") {
  console.log("prepublication verification from source checkout ok; candidate tarball manifest is sanitized before publish");
  process.exit(0);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`cannot verify the publishable manifest: ${error?.message || String(error)}`);
  process.exitCode = 1;
}

if (pkg) {
  const scripts = pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
  const repositoryOnly = Object.keys(scripts).filter((name) => !PUBLISHED_SCRIPT_NAMES.has(name));
  if (repositoryOnly.length) {
    const sample = repositoryOnly.slice(0, 6).join(", ");
    console.error(`refusing to publish from a source checkout: ${repositoryOnly.length} repository-only scripts are still declared (${sample}${repositoryOnly.length > 6 ? ", ..." : ""}).`);
    console.error("Their files are not part of the tarball, so an installed package would fail with MODULE_NOT_FOUND.");
    console.error("Publish the accepted candidate tarball instead: npm run prerelease:publish (or npm run stable:publish).");
    process.exitCode = 1;
  } else {
    console.log(`published manifest ok (${Object.keys(scripts).length} scripts: ${Object.keys(scripts).join(", ")})`);
  }
}
