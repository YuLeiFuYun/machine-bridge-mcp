#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateRoot, expandHome } from "../src/local/state.mjs";
import { ensureOwnerOnlyDirectorySync } from "../src/local/secure-file.mjs";
import { createCandidateRuntimePrefix, pruneInactiveCandidateRuntimes } from "./candidate-runtime-store.mjs";
import { writePrereleaseActivation } from "./prerelease-activation.mjs";
import { verifyTarball } from "./release-acceptance.mjs";
import { parseReleaseVersion } from "./release-channel.mjs";
import { validateCandidateManifest } from "./release-candidate-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateDirectory = join(root, ".release-candidate");
const manifestPath = join(candidateDirectory, "manifest.json");
const foregroundInstallPrefix = join(candidateDirectory, "runtime");
const npmCli = process.env.npm_execpath;

if (!npmCli) fail("candidate startup must run through npm so npm_execpath is available");

try {
  const manifest = readJson(manifestPath, "release candidate manifest");
  validateCandidateManifest(manifest);
  const tarball = join(candidateDirectory, String(manifest.filename || ""));
  verifyTarball(tarball, manifest);

  const npmVersion = runNpm(["--version"], root).stdout.trim();
  if (Number(npmVersion.split(".")[0]) < 12) {
    throw new Error(`candidate startup requires npm 12 or newer; current ${npmVersion}`);
  }

  const activateService = process.argv.includes("--activate-service");
  const stateRoot = resolve(expandHome(argumentValue("--state-dir") || defaultStateRoot()));
  const installPrefix = activateService
    ? createCandidateRuntimePrefix({ stateRoot, version: manifest.package_version, shasum: manifest.shasum })
    : foregroundInstallPrefix;
  if (!activateService) rmSync(installPrefix, { recursive: true, force: true });
  ensureOwnerOnlyDirectorySync(installPrefix);
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
    throw new Error("candidate activation may update the configured same-name Worker; rerun with --allow-worker-deploy to authorize that live candidate deployment");
  }

  const forwardedArgs = process.argv.slice(2).filter((value) => ![
    "--install-only", "--allow-worker-deploy", "--activate-service",
  ].includes(value));
  if (activateService) {
    activatePersistentCandidate({ manifest, installedPackage, installPrefix, stateRoot, forwardedArgs });
    process.exit(0);
  }

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

function activatePersistentCandidate({ manifest, installedPackage, installPrefix, stateRoot, forwardedArgs }) {
  const releaseVersion = parseReleaseVersion(manifest.package_version);
  const cli = join(installedPackage, "bin", "machine-mcp.mjs");
  const args = ["activate", ...withoutManagedFlags(forwardedArgs), "--state-dir", stateRoot, "--json"];
  const previous = currentGlobalInstallation(manifest.package_name);
  console.log("Activating the exact prerelease as the persistent login daemon. Portable-root startup does not prompt; a separately provisioned Secure Enclave broker may request one user-presence operation.");
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 300_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`persistent candidate activation failed: ${result.stderr || result.stdout}`);
  let activation;
  try { activation = JSON.parse(result.stdout); } catch { throw new Error("persistent candidate activation did not return valid JSON"); }
  if (
    activation.ok !== true
    || activation.version !== manifest.package_version
    || activation.daemon?.version !== manifest.package_version
    || activation.worker?.health?.version !== manifest.package_version
  ) {
    throw new Error("persistent candidate activation did not converge on the exact candidate version");
  }

  let recordPath = "";
  if (releaseVersion.prerelease) {
    recordPath = writePrereleaseActivation({
      schema_version: 1,
      package_name: manifest.package_name,
      package_version: manifest.package_version,
      source: "local-candidate",
      shasum: manifest.shasum,
      integrity: manifest.integrity,
      promotion_content_sha256: manifest.promotion_content_sha256,
      activated_at: new Date().toISOString(),
      workspace_hash: workspaceHash(activation.workspace),
      runtime_entry: cli,
      ...(previous ? { previous } : {}),
    }, stateRoot);
  }
  const removedRuntimes = pruneInactiveCandidateRuntimes({ stateRoot, activePrefix: installPrefix });
  console.log(`Persistent release candidate activated: ${manifest.package_version}`);
  if (recordPath) console.log(`Activation record: ${recordPath}`);
  if (removedRuntimes.length) console.log(`Removed ${removedRuntimes.length} inactive candidate runtime(s).`);
  console.log("The Worker and login daemon now run the exact candidate. The terminal may close; the coding agent should verify the live deployment through Machine Bridge.");
  if (previous?.version) console.log(`Rollback baseline retained: globally installed ${previous.version}.`);
}

function currentGlobalInstallation(packageName) {
  try {
    const globalRoot = runNpm(["root", "--global"], root).stdout.trim();
    const packageRoot = join(globalRoot, packageName);
    const packagePath = join(packageRoot, "package.json");
    if (!existsSync(packagePath)) return null;
    const pkg = readJson(packagePath, "globally installed package");
    return { version: String(pkg.version || ""), entry: join(packageRoot, "bin", "machine-mcp.mjs") };
  } catch {
    return null;
  }
}

function withoutManagedFlags(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--json" || value.startsWith("--json=")) continue;
    if (value === "--state-dir") { index += 1; continue; }
    if (value.startsWith("--state-dir=")) continue;
    out.push(value);
  }
  return out;
}

function argumentValue(name) {
  const exact = process.argv.find((value) => value.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function workspaceHash(workspace) {
  const value = process.platform === "win32" ? String(workspace).toLowerCase() : String(workspace);
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
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
