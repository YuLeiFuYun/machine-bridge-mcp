#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateRoot, expandHome } from "../src/local/state.mjs";
import { ACTIVATION_SCHEMA_VERSION, writePrereleaseActivation } from "./prerelease-activation.mjs";
import { computePromotionContentDigest } from "./promotion-digest.mjs";
import { readGithubPrerelease, readPublishedNpmPrerelease } from "./published-release.mjs";
import { verifyCurrentReleaseAcceptance } from "./release-acceptance.mjs";
import { assertSoakEligiblePrerelease } from "./release-channel.mjs";
import { persistentActivationSpawnOptions, validateActivationRecoveryPayload } from "./persistent-activation-process.mjs";
import { createHardenedNpmSession, settleHardenedNpmSession } from "./hardened-npm-session.mjs";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { inspectGlobalPackageInstallation } from "./global-package-installation.mjs";
import { resolveNpmGlobalPrefix } from "./npm-global-prefix.mjs";
import { releaseCommandFailure, releaseDiagnostic, releaseDiagnosticEvent } from "./release-diagnostic.mjs";
import { withReleaseRuntimeLock } from "../src/local/release-runtime-lock.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lifecycleNpmCli = process.env.npm_execpath;
let npmCli = "";
let npmSession = null;
let previousInstallation = null;
let globalInstallAttempted = false;
let globalInstallCompleted = false;
let installedPrerelease = "";
if (!lifecycleNpmCli) fail("published prerelease installation must run through npm");

try {
  if (!process.argv.includes("--allow-worker-deploy")) {
    throw new Error("published prerelease activation updates the global package, same-name Worker, and login daemon; rerun with --allow-worker-deploy");
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const requested = argumentValue("--version") || pkg.version;
  const prerelease = assertSoakEligiblePrerelease(requested);
  if (pkg.version !== prerelease.raw) {
    throw new Error(`source checkout version ${pkg.version} does not match requested prerelease ${prerelease.raw}`);
  }
  const globalPrefix = resolveNpmGlobalPrefix(lifecycleNpmCli, { cwd: root, env: process.env });
  const acceptance = verifyCurrentReleaseAcceptance(root, { npmCli: lifecycleNpmCli, env: process.env });
  if (!acceptance.required || acceptance.metadata.package_version !== prerelease.raw) {
    throw new Error("published prerelease installation requires the locally accepted exact prerelease source");
  }
  const promotionDigest = computePromotionContentDigest(root, { npmCli: lifecycleNpmCli });
  if (acceptance.record.promotion_content_sha256 !== promotionDigest) {
    throw new Error("current source promotion digest does not match local candidate acceptance");
  }
  readGithubPrerelease(prerelease.raw, { expectedArtifactSha256: acceptance.artifactSha256 });
  npmSession = await createHardenedNpmSession();
  npmCli = npmSession.cli;
  const published = readPublishedNpmPrerelease(pkg.name, prerelease.raw, prerelease.npmTag, { npmCli, env: process.env });
  if (published.integrity !== acceptance.metadata.integrity || published.shasum !== acceptance.metadata.shasum) {
    throw new Error("npm prerelease bytes do not match the locally accepted candidate");
  }

  const stateRoot = resolve(expandHome(argumentValue("--state-dir") || defaultStateRoot()));
  await withReleaseRuntimeLock(stateRoot, async () => {
    previousInstallation = currentGlobalInstallation(pkg.name, globalPrefix);
    globalInstallAttempted = true;
    runNpm([
      "install", "--dry-run=false", "--workspaces=false", "--ignore-scripts=false",
      "--global", "--prefix", globalPrefix,
      "--omit=optional", "--include=prod", "--package-lock-only=false",
      "--allow-scripts=esbuild,workerd,sharp,fsevents",
      `${pkg.name}@${prerelease.raw}`,
    ]);
    globalInstallCompleted = true;
    const installed = currentGlobalInstallation(pkg.name, globalPrefix);
    if (!installed || installed.version !== prerelease.raw) {
      throw new Error(`global prerelease installation did not converge on ${prerelease.raw}`);
    }
    installedPrerelease = prerelease.raw;
    disposeNpmSession();

    const forwarded = forwardedActivationArgs();
    const activation = runActivation(installed.entry, ["activate", ...forwarded, "--state-dir", stateRoot, "--json"]);
    if (activation.version !== prerelease.raw || activation.daemon?.version !== prerelease.raw || activation.worker?.health?.version !== prerelease.raw) {
      throw new Error("published prerelease activation did not converge on the exact registry version");
    }
    const recovery = validateActivationRecoveryPayload(activation);
    const recordPath = writePrereleaseActivation({
      schema_version: ACTIVATION_SCHEMA_VERSION,
      package_name: pkg.name,
      package_version: prerelease.raw,
      source: "npm-prerelease",
      shasum: published.shasum,
      integrity: published.integrity,
      promotion_content_sha256: promotionDigest,
      activated_at: new Date().toISOString(),
      published_at: published.publishedAt,
      npm_dist_tag: prerelease.npmTag,
      workspace_hash: workspaceHash(activation.workspace),
      runtime_entry: installed.entry,
      ...(recovery.recovered ? {
        activation_recovered: true,
        activation_recovery_reason: recovery.reason,
        activation_recovery_detail: recovery.detail,
      } : {}),
      ...(previousInstallation ? { global_package_rollback_baseline: previousInstallation } : {}),
    }, stateRoot);

    if (recovery.recovered) {
      console.warn(`Published prerelease activation used verified candidate-service recovery (${recovery.reason}): ${recovery.detail}`);
    }
    console.log(`Published prerelease activated: ${prerelease.raw}`);
    console.log(`Worker and login daemon version: ${activation.version}`);
    console.log(`Soak activation record: ${recordPath}`);
    console.log("Browser soak reminder: reload the unpacked Machine Bridge extension after this upgrade and verify browser status reports the expected connected version before counting browser automation as exercised.");
    console.log("Use this prerelease normally. Any blocking issue requires a new beta/rc version and restarts the soak clock.");
  });
} catch (error) {
  const settled = settleNpmSession(error);
  const message = releaseDiagnostic(settled?.message || settled, 1600);
  if (installedPrerelease) {
    const previousVersion = previousInstallation?.version || "unknown";
    fail(`${message}. The global package is now ${installedPrerelease}, but Worker/service activation may not have converged. Previous global version: ${previousVersion}. Preserve state and logs; fix forward with the exact prerelease or restore package, Worker, service definition, browser extension, and state as one verified unit.`);
  }
  if (globalInstallAttempted) {
    const previousVersion = previousInstallation?.version || "unknown";
    const installState = globalInstallCompleted
      ? "The global installation command completed, but the exact installed package identity was not verified"
      : "The global installation command was attempted and may have changed the installed package";
    fail(`${message}. ${installState}. Previous global version: ${previousVersion}. Inspect the configured global prefix before retrying or activating any runtime.`);
  }
  fail(message);
}

function disposeNpmSession() {
  const error = settleNpmSession();
  if (error) throw error;
}

function settleNpmSession(primaryError = null) {
  const session = npmSession;
  npmSession = null;
  return settleHardenedNpmSession(session, primaryError, "published prerelease failed and hardened npm temporary cleanup was incomplete");
}

function currentGlobalInstallation(packageName, globalPrefix) {
  const globalRoot = runNpm(["root", "--json=false", "--parseable=false", "--workspaces=false", "--global", "--prefix", globalPrefix]).stdout.trim();
  return inspectGlobalPackageInstallation(globalRoot, packageName);
}

function runActivation(entry, args) {
  const result = spawnSync(
    process.execPath,
    [entry, ...args],
    persistentActivationSpawnOptions({ cwd: root, env: nestedNpmEnvironment(process.env) }),
  );
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure("machine-mcp", ["activate"], result, { maxChars: 1600 }));
  try { return JSON.parse(result.stdout); } catch { throw new Error("prerelease runtime activation did not return valid JSON"); }
}

function runNpm(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    env: nestedNpmEnvironment(process.env),
    encoding: "utf8",
    timeout: 300_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure("npm", args, result, { maxChars: 1600 }));
  return result;
}

function forwardedActivationArgs() {
  const out = [];
  const skipWithValue = new Set(["--version", "--state-dir"]);
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === "--allow-worker-deploy") continue;
    if (skipWithValue.has(value)) { index += 1; continue; }
    if (["--version=", "--state-dir="].some((prefix) => value.startsWith(prefix))) continue;
    if (value === "--json" || value.startsWith("--json=")) continue;
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

function fail(message) {
  console.error(JSON.stringify(releaseDiagnosticEvent("prerelease.install.failed", message, 1800)));
  process.exit(1);
}
