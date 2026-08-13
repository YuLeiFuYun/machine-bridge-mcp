#!/usr/bin/env node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_CONFIRMATION,
  ACCEPTANCE_SCHEMA_VERSION,
  acceptancePath,
  packProject,
  verifyAcceptanceRecord,
  verifyCurrentReleaseAcceptance,
  verifyTarball,
} from "./release-acceptance.mjs";
import { computePromotionContentDigest } from "./promotion-digest.mjs";
import { parseReleaseVersion } from "./release-channel.mjs";
import { validateCandidateManifest } from "./release-candidate-manifest.mjs";
import { replaceFileAtomicallySync } from "../src/local/exclusive-file.mjs";
import { resolveTrustedGitExecutable } from "../src/local/trusted-git-executable.mjs";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { releaseCommandFailure, releaseDiagnosticEvent } from "./release-diagnostic.mjs";
import { createHardenedNpmSession } from "./hardened-npm-session.mjs";
import { readReleaseOAuthCanaryEvidence } from "./release-oauth-canary-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateDirectory = join(root, ".release-candidate");
const candidateManifestPath = join(candidateDirectory, "manifest.json");
const mode = process.argv[2] || "--verify";
const git = resolveTrustedGitExecutable({ workspace: root });

try {
  await runWithHardenedNpm();
} catch (error) {
  fail(error?.message || error);
}

async function runWithHardenedNpm() {
  let session = null;
  let primaryError = null;
  try {
    session = await createHardenedNpmSession();
    if (mode === "--prepare") prepareCandidate(session.cli);
    else if (mode === "--record") recordAcceptance(session.cli);
    else if (mode === "--verify") verifyAcceptance(session.cli);
    else throw new Error("usage: node scripts/local-release-acceptance.mjs [--prepare|--record|--verify]");
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { session?.dispose(); } catch (error) { cleanupError = error; }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "local release acceptance failed and hardened npm cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

function prepareCandidate(npmCli) {
  const pkg = readPackage();
  rmSync(candidateDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  mkdirSync(candidateDirectory, { recursive: true });
  const metadata = packProject(root, candidateDirectory, { npmCli, env: process.env });
  const manifest = {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    result: "pending",
    ...metadata,
    promotion_content_sha256: computePromotionContentDigest(root, { npmCli }),
    prepared_at: new Date().toISOString(),
  };
  replaceFileAtomicallySync(candidateManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const phrase = confirmationPhrase(pkg.name, pkg.version);
  console.log(`Release candidate created: ${join(candidateDirectory, metadata.filename)}`);
  parseReleaseVersion(pkg.version);
  console.log("Before asking the repository owner to activate it, the coding agent must reverify current source identity, package modes, tarball integrity, and disposable installability with direct Node argv (not npm lifecycle):");
  console.log("node scripts/start-release-candidate.mjs --install-only");
  console.log("Only after that non-live preflight succeeds does the repository owner activate this exact candidate with one persistent owner-side command:");
  console.log("npm run release:candidate:activate -- --allow-worker-deploy");
  console.log("The owner runs this one command. It installs the exact candidate in the private state root, updates the same-name Worker, verifies candidate relay readiness, replaces the login daemon, verifies the background handoff, and exits while the service remains active.");
  console.log("After activation, the coding agent derives the activated package root from the activation record runtime_entry and runs its packaged canary as direct Node argv from this repository cwd:");
  console.log("node <activated-runtime-package>/scripts/release-oauth-canary.mjs --allow-live-oauth-canary");
  console.log("For prereleases, the workspace script and npm lifecycle forms are source/developer paths only: they receive ordinary accounting and fail runtime-provenance evidence because the executing package must match activation runtime_entry.");
  console.log("Only after the canary and observed live verification succeed does the coding agent record acceptance with:");
  console.log(`npm run release:accept -- --confirm \"${phrase}\"`);
  console.log("Automated tests alone do not authorize acceptance or the first GitHub push.");
}

function recordAcceptance(npmCli) {
  const pkg = readPackage();
  const supplied = argumentValue("--confirm");
  const expected = confirmationPhrase(pkg.name, pkg.version);
  if (supplied !== expected) {
    throw new Error(`interactive candidate verification confirmation must exactly match: ${expected}`);
  }
  const pending = validateCandidateManifest(readJson(candidateManifestPath, "release candidate manifest"), {
    packageName: pkg.name,
    packageVersion: pkg.version,
  });
  verifyTarball(join(candidateDirectory, pending.filename), pending);
  readReleaseOAuthCanaryEvidence(root, {
    package_name: pending.package_name,
    package_version: pending.package_version,
    shasum: pending.shasum,
    integrity: pending.integrity,
    promotion_content_sha256: pending.promotion_content_sha256,
  });

  const verificationDirectory = join(candidateDirectory, "verification");
  rmSync(verificationDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  mkdirSync(verificationDirectory, { recursive: true });
  const current = packProject(root, verificationDirectory, { npmCli, env: process.env });
  for (const key of ["package_name", "package_version", "filename", "shasum", "integrity"]) {
    if (pending[key] !== current[key]) {
      throw new Error(`source changed after candidate preparation: ${key} no longer matches`);
    }
  }

  const promotionDigest = computePromotionContentDigest(root, { npmCli });
  if (pending.promotion_content_sha256 !== promotionDigest) {
    throw new Error("source changed after candidate preparation: promotion content digest no longer matches");
  }

  const record = {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    result: "passed",
    confirmation: ACCEPTANCE_CONFIRMATION,
    package_name: current.package_name,
    package_version: current.package_version,
    filename: current.filename,
    shasum: current.shasum,
    integrity: current.integrity,
    accepted_at: new Date().toISOString(),
    package_content_sha256: computePortablePackageDigest(npmCli),
    promotion_content_sha256: promotionDigest,
  };
  verifyAcceptanceRecord(record, current);
  const path = acceptancePath(root, pkg.version);
  mkdirSync(dirname(path), { recursive: true });
  replaceFileAtomicallySync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  console.log(`Interactive local candidate acceptance recorded: ${path}`);
  console.log("Commit this record with the candidate. Any packaged-file change invalidates it.");
}

function verifyAcceptance(npmCli) {
  const result = verifyCurrentReleaseAcceptance(root, { npmCli, env: process.env });
  if (!result.required) {
    console.log(`Local release acceptance is not required for ${result.version}.`);
    return;
  }
  console.log(`Local release acceptance matches ${result.metadata.filename} (${result.metadata.shasum}).`);
}

function computePortablePackageDigest(npmCli) {
  if (!npmCli) throw new Error("portable package digest requires a hardened npm CLI");
  const temporary = mkdtempSync(join(tmpdir(), "mbm-release-index-"));
  const indexPath = join(temporary, "index");
  const env = { ...nestedNpmEnvironment(process.env), GIT_INDEX_FILE: indexPath };
  let digest = "";
  let primaryError = null;
  try {
    runChecked(git, ["read-tree", "HEAD"], { env });
    runChecked(git, ["add", "--all", "--", "."], { env });
    const packed = runChecked(process.execPath, [
      npmCli,
      "pack",
      "--workspaces=false",
      "--global=false",
      "--prefix", root,
      "--ignore-scripts",
      "--silent",
      "--dry-run",
      "--json",
    ], { env });
    const verifier = runChecked(process.execPath, [
      join(root, ".github", "scripts", "verify-release-acceptance.mjs"),
      "--print-digest",
    ], { env, input: packed.stdout });
    digest = verifier.stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("portable package digest output is invalid");
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { rmSync(temporary, { recursive: true, force: true }); }
  catch (error) { cleanupError = error; }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "portable package digest failed and temporary cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return digest;
}

function runChecked(file, args, { env = process.env, input } = {}) {
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: "utf8",
    env,
    input,
    timeout: 5 * 60 * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure(file, args, result));
  return result;
}

function readPackage() {
  return readJson(join(root, "package.json"), "package.json");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid: ${error.message}`);
  }
}

function argumentValue(name) {
  const exact = process.argv.find((value) => value.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function confirmationPhrase(name, version) {
  return `I VERIFIED ${name} ${version} CANDIDATE ON THE OWNER MACHINE AND IT WORKS`;
}

function fail(message) {
  console.error(JSON.stringify(releaseDiagnosticEvent("release.acceptance.failed", message, 1200)));
  process.exit(1);
}
