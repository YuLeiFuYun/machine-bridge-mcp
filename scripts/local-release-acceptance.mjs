#!/usr/bin/env node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
  requiresLocalAcceptance,
  verifyAcceptanceRecord,
  verifyCurrentReleaseAcceptance,
  verifyTarball,
} from "./release-acceptance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateDirectory = join(root, ".release-candidate");
const candidateManifestPath = join(candidateDirectory, "manifest.json");
const mode = process.argv[2] || "--verify";

try {
  if (mode === "--prepare") prepareCandidate();
  else if (mode === "--record") recordAcceptance();
  else if (mode === "--verify") verifyAcceptance();
  else fail("usage: node scripts/local-release-acceptance.mjs [--prepare|--record|--verify]");
} catch (error) {
  fail(error?.message || error);
}

function prepareCandidate() {
  const pkg = readPackage();
  if (!requiresLocalAcceptance(pkg.version)) {
    throw new Error(`local acceptance policy begins at ${pkg.name} 1.2.8; current version is ${pkg.version}`);
  }
  rmSync(candidateDirectory, { recursive: true, force: true });
  mkdirSync(candidateDirectory, { recursive: true });
  const metadata = packProject(root, candidateDirectory);
  const manifest = {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    result: "pending",
    ...metadata,
    prepared_at: new Date().toISOString(),
  };
  writeFileSync(candidateManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const phrase = confirmationPhrase(pkg.name, pkg.version);
  console.log(`Release candidate created: ${join(candidateDirectory, metadata.filename)}`);
  console.log("After the repository owner explicitly authorizes this exact candidate in the active conversation, the coding agent starts it through Machine Bridge with:");
  console.log("npm run release:candidate:start -- --allow-worker-deploy");
  console.log("The owner does not need to run a terminal authorization command. The coding agent keeps the candidate running while verifying connection readiness and representative functionality through Machine Bridge.");
  console.log("After that observed live verification succeeds, the coding agent records acceptance with:");
  console.log(`npm run release:accept -- --confirm \"${phrase}\"`);
  console.log("Automated tests alone do not authorize acceptance or the first GitHub push.");
}

function recordAcceptance() {
  const pkg = readPackage();
  const supplied = argumentValue("--confirm");
  const expected = confirmationPhrase(pkg.name, pkg.version);
  if (supplied !== expected) {
    throw new Error(`interactive candidate verification confirmation must exactly match: ${expected}`);
  }
  const pending = readJson(candidateManifestPath, "release candidate manifest");
  if (pending.result !== "pending" || pending.package_name !== pkg.name || pending.package_version !== pkg.version) {
    throw new Error("release candidate manifest does not match the current package");
  }
  verifyTarball(join(candidateDirectory, pending.filename), pending);

  const verificationDirectory = join(candidateDirectory, "verification");
  rmSync(verificationDirectory, { recursive: true, force: true });
  mkdirSync(verificationDirectory, { recursive: true });
  const current = packProject(root, verificationDirectory);
  for (const key of ["package_name", "package_version", "filename", "shasum", "integrity"]) {
    if (pending[key] !== current[key]) {
      throw new Error(`source changed after candidate preparation: ${key} no longer matches`);
    }
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
    package_content_sha256: computePortablePackageDigest(),
  };
  verifyAcceptanceRecord(record, current);
  const path = acceptancePath(root, pkg.version);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`Interactive local candidate acceptance recorded: ${path}`);
  console.log("Commit this record with the candidate. Any packaged-file change invalidates it.");
}

function verifyAcceptance() {
  const result = verifyCurrentReleaseAcceptance(root);
  if (!result.required) {
    console.log(`Local release acceptance is not required for ${result.version}.`);
    return;
  }
  console.log(`Local release acceptance matches ${result.metadata.filename} (${result.metadata.shasum}).`);
}

function computePortablePackageDigest() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("portable package digest requires npm_execpath");
  const temporary = mkdtempSync(join(tmpdir(), "mbm-release-index-"));
  const indexPath = join(temporary, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    runChecked("git", ["read-tree", "HEAD"], { env });
    runChecked("git", ["add", "--all", "--", "."], { env });
    const packed = runChecked(process.execPath, [
      npmCli,
      "pack",
      "--ignore-scripts",
      "--silent",
      "--dry-run",
      "--json",
    ], { env });
    const verifier = runChecked(process.execPath, [
      join(root, ".github", "scripts", "verify-release-acceptance.mjs"),
      "--print-digest",
    ], { env, input: packed.stdout });
    const digest = verifier.stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("portable package digest output is invalid");
    return digest;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runChecked(file, args, { env = process.env, input } = {}) {
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: "utf8",
    env,
    input,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${file} ${args[0] || ""} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
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
  console.error(`local release acceptance failed: ${message}`);
  process.exit(1);
}
