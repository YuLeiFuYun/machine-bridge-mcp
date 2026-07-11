#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const current = parseVersion(String(pkg.version || ""));
if (!current) fail("package.json contains an invalid version");

const tags = git(["tag", "--merged", "HEAD", "--sort=-version:refname", "--list", "v[0-9]*"])
  .split("\n")
  .map((value) => value.trim())
  .filter((value) => VERSION_TAG.test(value));
if (!tags.length) {
  process.stderr.write("release impact check skipped: no reachable version tag\n");
  process.exit(0);
}

const latestTag = tags[0];
const latest = parseVersion(latestTag.slice(1));
const changed = new Set([
  ...lines(git(["diff", "--name-only", latestTag, "--"])),
  ...lines(git(["ls-files", "--others", "--exclude-standard"])),
]);
const relevant = [...changed].sort();

if (!relevant.length) {
  process.stderr.write(`release impact check ok: no release-relevant changes since ${latestTag}\n`);
  process.exit(0);
}
if (compareVersions(current, latest) <= 0) {
  fail(`release-relevant changes exist since ${latestTag}, but package.json is still ${pkg.version}; bump the npm version and add a CHANGELOG section before merging`);
}

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const heading = new RegExp(`^## ${escapeRegExp(pkg.version)}(?:\\s+-[^\\n]*)?$`, "m");
if (!heading.test(changelog)) fail(`CHANGELOG.md has no section for ${pkg.version}`);

process.stderr.write(`release impact check ok: ${relevant.length} release-relevant file(s) since ${latestTag}; next npm version ${pkg.version}\n`);

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

function lines(value) {
  return value ? value.split("\n").map((item) => item.trim()).filter(Boolean) : [];
}

function parseVersion(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] || "" } : null;
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  process.stderr.write(`release impact check failed: ${message}\n`);
  process.exit(1);
}
