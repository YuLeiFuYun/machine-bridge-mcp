#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTarball } from "./release-acceptance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateDirectory = join(root, ".release-candidate");
const manifestPath = join(candidateDirectory, "manifest.json");
const installPrefix = join(candidateDirectory, "runtime");
const npmCli = process.env.npm_execpath;

if (!npmCli) fail("candidate startup must run through npm so npm_execpath is available");

try {
  const manifest = readJson(manifestPath, "release candidate manifest");
  if (manifest.result !== "pending") throw new Error("release candidate manifest is not pending");
  const tarball = join(candidateDirectory, String(manifest.filename || ""));
  verifyTarball(tarball, manifest);

  const npmVersion = runNpm(["--version"], root).stdout.trim();
  if (Number(npmVersion.split(".")[0]) < 12) {
    throw new Error(`candidate startup requires npm 12 or newer; current ${npmVersion}`);
  }

  rmSync(installPrefix, { recursive: true, force: true });
  mkdirSync(installPrefix, { recursive: true });
  runNpm([
    "install",
    "--global",
    "--prefix", installPrefix,
    "--omit=optional",
    "--allow-scripts=esbuild,workerd,sharp,fsevents",
    tarball,
  ], root);

  const globalRoot = runNpm(["root", "--global", "--prefix", installPrefix], root).stdout.trim();
  const installedPackage = join(globalRoot, manifest.package_name);
  const installed = readJson(join(installedPackage, "package.json"), "installed candidate package");
  if (installed.version !== manifest.package_version) {
    throw new Error(`installed candidate version ${installed.version} does not match ${manifest.package_version}`);
  }

  console.log(`Verified candidate tarball: ${manifest.filename} (${manifest.shasum})`);
  console.log(`Installed isolated candidate: ${installedPackage}`);
  const installOnly = process.argv.includes("--install-only");
  const allowWorkerDeploy = process.argv.includes("--allow-worker-deploy");
  if (installOnly) {
    console.log("Candidate installation check passed; startup was skipped by --install-only.");
    process.exit(0);
  }

  if (!allowWorkerDeploy) {
    throw new Error("foreground candidate startup may update the configured same-name Worker; rerun with --allow-worker-deploy to authorize that live candidate deployment");
  }

  const forwardedArgs = process.argv.slice(2).filter((value) => value !== "--install-only" && value !== "--allow-worker-deploy");
  const cli = join(installedPackage, "bin", "machine-mcp.mjs");
  console.log("Authorized live candidate deployment: startup may update the configured same-name Worker when its version or deployment hash differs.");
  console.log("Starting the exact candidate in the foreground. Leave this process running while the coding agent verifies the Worker, relay, and local runtime end to end.");
  const child = spawn(process.execPath, [cli, ...forwardedArgs], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      try { child.kill(signal); } catch {
        // The child may already have exited.
      }
    });
  }
  child.once("error", (error) => fail(error?.message || error));
  child.once("exit", (code, signal) => {
    if (signal) {
      console.error(`release candidate exited from ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
} catch (error) {
  fail(error?.message || error);
}

function runNpm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout: 300_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid: ${error.message}`);
  }
}

function fail(message) {
  console.error(`release candidate startup failed: ${message}`);
  process.exit(1);
}
