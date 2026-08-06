#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCurrentReleaseAcceptance } from "./release-acceptance.mjs";
import { assertGitHubBacklogReady } from "./github-backlog.mjs";
import { parseReleaseVersion, requiresSoakForStable } from "./release-channel.mjs";
import { verifyCurrentStableSoak } from "./release-soak.mjs";
import { resolveTrustedGitExecutable } from "../src/local/trusted-git-executable.mjs";
import { resolveTrustedGithubCli } from "../src/local/trusted-github-cli.mjs";
import { createHardenedNpmSession } from "./hardened-npm-session.mjs";
import { runNetworkCommand } from "./network-retry.mjs";
import { releaseCommandFailure, releaseDiagnostic } from "./release-diagnostic.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = resolveTrustedGitExecutable({ workspace: root });
const gh = resolveTrustedGithubCli({ workspace: root });

try {
  const status = output(git, ["status", "--porcelain"]);
  if (status) throw new Error(`working tree is not clean: ${releaseDiagnostic(status, 1000)}`);
  const branch = output(git, ["branch", "--show-current"]);
  if (!branch) throw new Error("cannot push from a detached HEAD");
  if (branch === "main") throw new Error("direct pushes to main are prohibited; push a reviewed branch and merge through a pull request");
  runNetwork(git, ["fetch", "origin", "main", "--prune"]);
  const backlog = assertGitHubBacklogReady({ cwd: root, branch, git, gh, run: runBacklogCommand });
  console.log(backlog.message);

  const npmSession = await createHardenedNpmSession();
  let verificationError = null;
  try {
    const acceptance = verifyCurrentReleaseAcceptance(root, { npmCli: npmSession.cli, env: process.env });
    if (acceptance.required) {
      const path = `release-acceptance/v${acceptance.metadata.package_version}.json`;
      run(git, ["ls-files", "--error-unmatch", path], { capture: true });
      console.log(`Verified interactive local candidate acceptance for ${acceptance.metadata.filename}.`);
    }

    const releaseVersion = parseReleaseVersion(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version);
    if (!releaseVersion.prerelease && requiresSoakForStable(releaseVersion.raw)) {
      const soak = verifyCurrentStableSoak(root, { npmCli: npmSession.cli });
      const path = `release-soak/v${releaseVersion.raw}.json`;
      run(git, ["ls-files", "--error-unmatch", path], { capture: true });
      console.log(`Verified stable promotion from soaked ${soak.record.prerelease_version}.`);
    }
  } catch (error) {
    verificationError = error;
  }
  let npmCleanupError = null;
  try { npmSession.dispose(); } catch (error) { npmCleanupError = error; }
  if (verificationError && npmCleanupError) {
    throw new AggregateError([verificationError, npmCleanupError], "GitHub push verification failed and hardened npm cleanup was incomplete");
  }
  if (verificationError) throw verificationError;
  if (npmCleanupError) throw npmCleanupError;

  runNetwork(git, ["push", "--set-upstream", "origin", "HEAD"]);
  console.log(`Pushed accepted branch ${branch} to origin.`);
} catch (error) {
  console.error(`GitHub push blocked: ${releaseDiagnostic(error?.message || error, 1200)}`);
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
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(releaseCommandFailure(command, args, options.capture ? result : { ...result, stdout: "", stderr: "" }));
  }
  return result;
}

function runNetwork(command, args) {
  const result = runNetworkCommand(command, args, { cwd: root, env: process.env, timeoutMs: 120_000 });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure(command, args, result));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function runBacklogCommand(command, args, cwd) {
  const result = runNetworkCommand(command, args, { cwd, env: process.env, timeoutMs: 120_000 });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure(command, args, result));
  return result;
}
