#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReleaseVersion, requiresSoakForStable } from "./release-channel.mjs";
import { verifyCurrentStableSoak } from "./release-soak.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function npmPublishArguments(version, mode) {
  const parsed = parseReleaseVersion(version);
  if (mode === "prerelease" && !parsed.prerelease) throw new Error("prerelease publication requires a dev, beta, or rc version");
  if (mode === "stable" && parsed.prerelease) throw new Error("stable publication requires a version without a prerelease suffix");
  if (!new Set(["prerelease", "stable"]).has(mode)) throw new Error("publication mode must be prerelease or stable");
  return ["publish", "--tag", parsed.npmTag];
}

export function publishCurrentNpmPackage(repositoryRoot, mode, options = {}) {
  const pkg = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  const parsed = parseReleaseVersion(pkg.version);
  const args = npmPublishArguments(parsed.raw, mode);
  if (!parsed.prerelease && requiresSoakForStable(parsed.raw)) verifyCurrentStableSoak(repositoryRoot);
  const npmCli = options.npmCli || process.env.npm_execpath;
  if (!npmCli) throw new Error("npm publication must run through npm so npm_execpath is available");
  const run = options.run || spawnSync;
  const result = run(process.execPath, [npmCli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm publish failed with status ${result.status}`);
  return { version: parsed.raw, tag: parsed.npmTag };
}

async function main() {
  const mode = process.argv[2] || "";
  const result = publishCurrentNpmPackage(root, mode);
  console.log(`npm publication completed: ${result.version} with dist-tag ${result.tag}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`npm publication failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
