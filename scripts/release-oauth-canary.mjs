#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountAdminClient } from "../src/local/cli-account-admin.mjs";
import { defaultStateRoot, expandHome, loadState, selectedWorkspace } from "../src/local/state.mjs";
import { computePromotionContentDigest } from "./promotion-digest.mjs";
import { readPrereleaseActivation } from "./prerelease-activation.mjs";
import { parseReleaseVersion } from "./release-channel.mjs";
import { assertCandidateMatchesCurrentSource, validateCandidateManifest } from "./release-candidate-manifest.mjs";
import { releaseDiagnosticEvent } from "./release-diagnostic.mjs";
import { normalizeCanaryWorkerUrl, runReleaseOAuthCanaryFlow } from "./release-oauth-canary-core.mjs";
import {
  RELEASE_OAUTH_CANARY_SCHEMA_VERSION,
  writeReleaseOAuthCanaryEvidence,
} from "./release-oauth-canary-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateManifestPath = join(root, ".release-candidate", "manifest.json");

try {
  if (!process.argv.includes("--allow-live-oauth-canary")) {
    throw new Error("release OAuth canary mutates temporary live OAuth state; rerun with --allow-live-oauth-canary after exact candidate activation");
  }
  const evidencePath = await runCanary();
  console.log("Deployed OAuth canary passed: authorization-code exchange, authenticated MCP, refresh rotation, refreshed MCP, and cleanup all succeeded.");
  console.log(`OAuth canary evidence: ${evidencePath}`);
} catch (error) {
  fail(error?.message || error);
}

async function runCanary() {
  const npmCli = String(process.env.npm_execpath || "");
  if (!npmCli) throw new Error("release OAuth canary must run through npm so npm_execpath is available");
  const pkg = readJson(join(root, "package.json"), "package.json");
  const manifest = validateCandidateManifest(readJson(candidateManifestPath, "release candidate manifest"), {
    packageName: pkg.name,
    packageVersion: pkg.version,
  });
  assertCandidateMatchesCurrentSource(manifest, {
    packageName: pkg.name,
    packageVersion: pkg.version,
    promotionDigest: computePromotionContentDigest(root, { npmCli }),
  });

  const stateRoot = resolve(expandHome(argumentValue("--state-dir") || defaultStateRoot()));
  const workspace = resolve(expandHome(argumentValue("--workspace") || selectedWorkspace(stateRoot)));
  const state = loadState(workspace, { stateDir: stateRoot });
  const workerUrl = normalizeCanaryWorkerUrl(state.worker?.url);
  if (state.worker?.deployedVersion !== manifest.package_version) {
    throw new Error("release OAuth canary refused a Worker whose recorded deployed version does not match the candidate");
  }
  const parsedVersion = parseReleaseVersion(manifest.package_version);
  if (parsedVersion.prerelease) verifyPrereleaseActivation(manifest, stateRoot);

  let admin;
  try { admin = await accountAdminClient(state); }
  catch (error) { throw new Error("release OAuth canary account-administration session setup failed", { cause: error }); }
  const result = await runReleaseOAuthCanaryFlow({
    admin,
    workerUrl,
    packageName: manifest.package_name,
    packageVersion: manifest.package_version,
  });
  return writeReleaseOAuthCanaryEvidence(root, {
    schema_version: RELEASE_OAUTH_CANARY_SCHEMA_VERSION,
    result: "passed",
    package_name: manifest.package_name,
    package_version: manifest.package_version,
    shasum: manifest.shasum,
    integrity: manifest.integrity,
    promotion_content_sha256: manifest.promotion_content_sha256,
    worker_version: result.workerVersion,
    authorization_code_exchange: result.authorizationCodeExchange,
    authenticated_mcp: result.authenticatedMcp,
    refresh_rotation: result.refreshRotation,
    refreshed_mcp: result.refreshedMcp,
    cleanup_completed: result.cleanupCompleted,
    completed_at: new Date().toISOString(),
  });
}

function verifyPrereleaseActivation(manifest, stateRoot) {
  const activation = readPrereleaseActivation(manifest.package_version, stateRoot);
  for (const field of ["shasum", "integrity", "promotion_content_sha256"]) {
    if (activation[field] !== manifest[field]) {
      throw new Error(`release OAuth canary activation record does not match the candidate: ${field}`);
    }
  }
}

function argumentValue(name) {
  const exact = process.argv.find((value) => value.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${label} is unavailable or invalid`, { cause: error }); }
}

function fail(message) {
  console.error(JSON.stringify(releaseDiagnosticEvent("release.oauth_canary.failed", message, 1200)));
  process.exit(1);
}
