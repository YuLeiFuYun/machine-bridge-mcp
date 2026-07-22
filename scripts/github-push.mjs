#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCurrentReleaseAcceptance } from "./release-acceptance.mjs";
import { assertGitHubBacklogReady } from "./github-backlog.mjs";
import { parseReleaseVersion, requiresSoakForStable } from "./release-channel.mjs";
import { verifyCurrentStableSoak } from "./release-soak.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const status = output("git", ["status", "--porcelain"]);
  if (status) throw new Error(`working tree is not clean:\n${status}`);
  const branch = output("git", ["branch", "--show-current"]);
  if (!branch) throw new Error("cannot push from a detached HEAD");
  if (branch === "main") throw new Error("direct pushes to main are prohibited; push a reviewed branch and merge through a pull request");
  run("git", ["fetch", "origin", "main", "--prune"]);
  const backlog = assertGitHubBacklogReady({ cwd: root, branch });
  console.log(backlog.message);

  const acceptance = verifyCurrentReleaseAcceptance(root);
  if (acceptance.required) {
    const path = `release-acceptance/v${acceptance.metadata.package_version}.json`;
    run("git", ["ls-files", "--error-unmatch", path], { capture: true });
    console.log(`Verified interactive local candidate acceptance for ${acceptance.metadata.filename}.`);
  }

  const releaseVersion = parseReleaseVersion(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version);
  if (!releaseVersion.prerelease && requiresSoakForStable(releaseVersion.raw)) {
    const soak = verifyCurrentStableSoak(root);
    const path = `release-soak/v${releaseVersion.raw}.json`;
    run("git", ["ls-files", "--error-unmatch", path], { capture: true });
    console.log(`Verified stable promotion from soaked ${soak.record.prerelease_version}.`);
  }

  run("git", ["push", "--set-upstream", "origin", "HEAD"]);
  console.log(`Pushed accepted branch ${branch} to origin.`);
} catch (error) {
  console.error(`GitHub push blocked: ${error?.message || error}`);
  process.exit(1);
}

function output(command, args) {
  return String(run(command, args, { capture: true }).stdout || "").trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout).trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}
