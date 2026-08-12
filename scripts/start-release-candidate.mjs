#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateRoot, expandHome, selectedWorkspace } from "../src/local/state.mjs";
import { ensureOwnerOnlyDirectorySync } from "../src/local/secure-file.mjs";
import { createCandidateRuntimePrefix, isNonBlockingCandidateRuntimeCleanupError, pruneInactiveCandidateRuntimes } from "./candidate-runtime-store.mjs";
import { ACTIVATION_SCHEMA_VERSION, writePrereleaseActivation } from "./prerelease-activation.mjs";
import { verifyTarball } from "./release-acceptance.mjs";
import { parseReleaseVersion } from "./release-channel.mjs";
import { discoverForegroundDaemonRecovery } from "./foreground-daemon-recovery.mjs";
import { persistentActivationSpawnOptions, persistentCandidateFailureMessage, validateActivationRecoveryPayload } from "./persistent-activation-process.mjs";
import { assertCandidateMatchesCurrentSource, validateCandidateManifest } from "./release-candidate-manifest.mjs";
import { computePromotionContentDigest } from "./promotion-digest.mjs";
import { createHardenedNpmSession, settleHardenedNpmSession } from "./hardened-npm-session.mjs";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { withReleaseRuntimeLock } from "../src/local/release-runtime-lock.mjs";
import { releaseCommandFailure, releaseDiagnostic, releaseDiagnosticEvent } from "./release-diagnostic.mjs";
import { inspectGlobalPackageInstallation } from "./global-package-installation.mjs";
import { resolveNpmGlobalPrefix } from "./npm-global-prefix.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateDirectory = join(root, ".release-candidate");
const manifestPath = join(candidateDirectory, "manifest.json");
const foregroundInstallPrefix = join(candidateDirectory, "runtime");
const lifecycleNpmCli = process.env.npm_execpath;
let npmCli = "";
let npmSession = null;

if (!lifecycleNpmCli) fail("candidate startup must run through npm so npm_execpath is available");

try {
  const currentPackage = readJson(join(root, "package.json"), "current package");
  const manifest = validateCandidateManifest(
    readJson(manifestPath, "release candidate manifest"),
    { packageName: currentPackage.name, packageVersion: currentPackage.version },
  );
  assertCandidateMatchesCurrentSource(manifest, {
    packageName: currentPackage.name,
    packageVersion: currentPackage.version,
    promotionDigest: computePromotionContentDigest(root, { npmCli: lifecycleNpmCli }),
  });
  const tarball = join(candidateDirectory, manifest.filename);
  verifyTarball(tarball, manifest);
  const activateService = process.argv.includes("--activate-service");
  const installOnly = process.argv.includes("--install-only");
  const allowWorkerDeploy = process.argv.includes("--allow-worker-deploy");
  if (!installOnly && !allowWorkerDeploy) {
    throw new Error("candidate activation may update the configured same-name Worker; rerun with --allow-worker-deploy to authorize that live candidate deployment");
  }
  const persistentActivation = activateService && !installOnly;
  const globalPrefix = persistentActivation
    ? resolveNpmGlobalPrefix(lifecycleNpmCli, { cwd: root, env: process.env })
    : "";
  npmSession = await createHardenedNpmSession();
  npmCli = npmSession.cli;

  const npmVersion = runNpm(["--version"], root).stdout.trim();
  if (npmVersion !== npmSession.version) {
    throw new Error(`candidate startup hardened npm reported ${npmVersion || "no version"}, expected ${npmSession.version}`);
  }

  const stateRoot = resolve(expandHome(argumentValue("--state-dir") || defaultStateRoot()));
  const forwardedArgs = process.argv.slice(2).filter((value) => ![
    "--install-only", "--allow-worker-deploy", "--activate-service",
  ].includes(value));
  if (persistentActivation) {
    await withReleaseRuntimeLock(stateRoot, async () => {
      const installPrefix = createCandidateRuntimePrefix({ stateRoot, version: manifest.package_version, shasum: manifest.shasum });
      const installedPackage = installCandidateRuntime({ installPrefix, manifest, tarball });
      const previousInstallation = persistentActivation
        ? currentGlobalInstallation(manifest.package_name, globalPrefix, npmCli)
        : null;
      disposeNpmSession();
      activatePersistentCandidate({
        manifest, installedPackage, installPrefix, stateRoot, forwardedArgs, previousInstallation,
      });
    });
    process.exit(0);
  }

  const installPrefix = foregroundInstallPrefix;
  rmSync(installPrefix, { recursive: true, force: true });
  const installedPackage = installCandidateRuntime({ installPrefix, manifest, tarball });
  disposeNpmSession();
  if (installOnly) {
    rmSync(installPrefix, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    console.log("Candidate installation check passed; temporary runtime was removed and startup was skipped by --install-only.");
    process.exit(0);
  }

  const cli = join(installedPackage, "bin", "machine-mcp.mjs");
  console.log("Authorized live candidate deployment: startup may update the configured same-name Worker when its version or deployment hash differs.");
  console.log("Starting the exact candidate in the foreground. Leave this process running while the coding agent verifies the Worker, relay, and local runtime end to end.");
  const child = spawn(process.execPath, [cli, ...forwardedArgs], {
    cwd: root,
    env: nestedNpmEnvironment(process.env),
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
  const settled = settleNpmSession(error);
  fail(settled?.message || settled);
}

function installCandidateRuntime({ installPrefix, manifest, tarball }) {
  ensureOwnerOnlyDirectorySync(installPrefix);
  runNpm([
    "install",
    "--dry-run=false",
    "--workspaces=false",
    "--ignore-scripts=false",
    "--global",
    "--prefix", installPrefix,
    "--omit=optional",
    "--include=prod",
    "--package-lock-only=false",
    "--allow-scripts=esbuild,workerd,sharp,fsevents",
    tarball,
  ], root);
  const globalRoot = runNpm(["root", "--json=false", "--parseable=false", "--workspaces=false", "--global", "--prefix", installPrefix], root).stdout.trim();
  const installedPackage = join(globalRoot, manifest.package_name);
  const installed = readJson(join(installedPackage, "package.json"), "installed candidate package");
  if (installed.version !== manifest.package_version) {
    throw new Error(`installed candidate version ${installed.version} does not match ${manifest.package_version}`);
  }
  console.log(`Verified candidate tarball: ${manifest.filename} (${manifest.shasum})`);
  console.log(`Installed isolated candidate: ${installedPackage}`);
  return installedPackage;
}

function activatePersistentCandidate({
  manifest, installedPackage, installPrefix, stateRoot, forwardedArgs, previousInstallation,
}) {
  const releaseVersion = parseReleaseVersion(manifest.package_version);
  const cli = join(installedPackage, "bin", "machine-mcp.mjs");
  const args = ["activate", ...withoutManagedFlags(forwardedArgs), "--state-dir", stateRoot, "--json"];
  console.log("Activating the exact prerelease as the persistent login daemon. Portable-root startup does not prompt; a separately provisioned Secure Enclave broker may request one user-presence operation.");
  const result = spawnSync(
    process.execPath,
    [cli, ...args],
    persistentActivationSpawnOptions({ cwd: root, env: nestedNpmEnvironment(process.env) }),
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = result.stderr || result.stdout;
    const requestedWorkspace = argumentListValue("--workspace", withoutManagedFlags(forwardedArgs))
      || selectedWorkspace(stateRoot);
    const previousRuntime = discoverForegroundDaemonRecovery({
      output, stateRoot, workspace: requestedWorkspace,
    });
    throw new Error(persistentCandidateFailureMessage(output, { cli, stateRoot, previousRuntime }));
  }
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
  const recovery = validateActivationRecoveryPayload(activation);

  let removedRuntimes = [];
  let runtimeCleanupWarning = "";
  try {
    removedRuntimes = pruneInactiveCandidateRuntimes({ stateRoot, activePrefix: installPrefix });
  } catch (error) {
    if (!isNonBlockingCandidateRuntimeCleanupError(error)) throw error;
    runtimeCleanupWarning = boundedCleanupWarning(error);
  }
  let recordPath = "";
  if (releaseVersion.prerelease) {
    recordPath = writePrereleaseActivation({
      schema_version: ACTIVATION_SCHEMA_VERSION,
      package_name: manifest.package_name,
      package_version: manifest.package_version,
      source: "local-candidate",
      shasum: manifest.shasum,
      integrity: manifest.integrity,
      promotion_content_sha256: manifest.promotion_content_sha256,
      activated_at: new Date().toISOString(),
      workspace_hash: workspaceHash(activation.workspace),
      runtime_entry: cli,
      ...(recovery.recovered ? {
        activation_recovered: true,
        activation_recovery_reason: recovery.reason,
        activation_recovery_detail: recovery.detail,
      } : {}),
      ...(previousInstallation ? { global_package_rollback_baseline: previousInstallation } : {}),
    }, stateRoot);
  }
  if (recovery.recovered) {
    console.warn(`Persistent activation used verified candidate-service recovery (${recovery.reason}): ${recovery.detail}`);
  }
  console.log(`Persistent release candidate activated: ${manifest.package_version}`);
  if (recordPath) console.log(`Activation record: ${recordPath}`);
  if (removedRuntimes.length) console.log(`Removed ${removedRuntimes.length} inactive candidate runtime(s).`);
  if (runtimeCleanupWarning) console.warn(`Candidate activation succeeded but inactive runtime cleanup was incomplete: ${runtimeCleanupWarning}`);
  console.log("The Worker and login daemon now run the exact candidate. The terminal may close; the coding agent should verify the live deployment through Machine Bridge.");
  if (previousInstallation?.version) {
    console.log(`Global package rollback baseline retained: ${previousInstallation.version}.`);
  }
}


function currentGlobalInstallation(packageName, globalPrefix, npmExecutable) {
  const globalRoot = runNpm(
    ["root", "--json=false", "--parseable=false", "--workspaces=false", "--global", "--prefix", globalPrefix],
    root,
    npmExecutable,
  ).stdout.trim();
  return inspectGlobalPackageInstallation(globalRoot, packageName);
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

function argumentListValue(name, args) {
  const exact = args.find(value => value.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
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

function runNpm(args, cwd, npmExecutable = npmCli) {
  const cli = String(npmExecutable || "");
  if (!cli) throw new Error("nested npm CLI is unavailable");
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: nestedNpmEnvironment(process.env),
    timeout: 300_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure("npm", args, result));
  return result;
}

function disposeNpmSession() {
  const error = settleNpmSession();
  if (error) throw error;
}

function settleNpmSession(primaryError = null) {
  const session = npmSession;
  npmSession = null;
  return settleHardenedNpmSession(session, primaryError, "release candidate failed and hardened npm temporary cleanup was incomplete");
}

function boundedCleanupWarning(error) {
  return releaseDiagnostic(error?.message || error || "candidate runtime cleanup failed", 600);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid: ${error.message}`);
  }
}

function fail(message) {
  console.error(JSON.stringify(releaseDiagnosticEvent("release.candidate.failed", message, 1200)));
  process.exit(1);
}
