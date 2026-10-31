import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { readBoundedRegularFileSync } from "../src/local/secure-file.mjs";
import { publishedPackageJsonText } from "../src/shared/published-package.mjs";
import { parseReleaseVersion } from "./release-channel.mjs";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { releaseCommandFailure } from "./release-diagnostic.mjs";

export const ACCEPTANCE_SCHEMA_VERSION = 1;
export const ACCEPTANCE_CONFIRMATION = "owner-activated-agent-verified-persistent-candidate";
const MAX_ACCEPTANCE_BYTES = 64 * 1024;
const MAX_RELEASE_TARBALL_BYTES = 64 * 1024 * 1024;

export function acceptancePath(root, version) {
  return join(root, "release-acceptance", `v${version}.json`);
}

export function archiveLedgerPath(root) {
  return join(root, "release-acceptance", "archive-ledger.jsonl");
}

export function readFromArchiveLedger(root, version) {
  const ledger = archiveLedgerPath(root);
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(
      ledger, 4 * 1024 * 1024, "release acceptance archive ledger",
      { verifyPathIdentity: true, rejectMultipleLinks: true },
    );
  } catch {
    return null;
  }
  const lines = bytes.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record?.package_version === version) return record;
    } catch {
      // ignore malformed line
    }
  }
  return null;
}

export function packProject(root, destination, options = {}) {
  const npmCli = options.npmCli || process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("release acceptance commands must run through npm so npm_execpath is available");
  }
  const pkg = readPackage(root);
  const env = options.env || process.env;
  const inventory = packageInventory(root, npmCli, env, pkg.name);
  const staging = mkdtempSync(join(tmpdir(), "mbm-published-package-"));
  try {
    materializePublishedPackage(root, staging, inventory, pkg);
    const result = runNpmPack(staging, npmCli, env, [
      "pack",
      "--dry-run=false",
      "--workspaces=false",
      "--global=false",
      "--prefix", staging,
      "--ignore-scripts",
      "--silent",
      "--json",
      "--pack-destination",
      destination,
    ]);
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new Error("npm pack did not return valid JSON");
    }
    const record = normalizePackRecord(value, pkg.name);
    if (!record) throw new Error("npm pack did not return package metadata");
    if (typeof record.filename !== "string" || typeof record.shasum !== "string" || typeof record.integrity !== "string") {
      throw new Error("npm pack returned package metadata with invalid field types");
    }
    verifyPublishedInventory(record.files, inventory);
    const metadata = {
      package_name: pkg.name,
      package_version: pkg.version,
      filename: record.filename,
      shasum: record.shasum,
      integrity: record.integrity,
    };
    validatePackMetadata(metadata);
    verifyTarball(join(destination, metadata.filename), metadata);
    return metadata;
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function packageInventory(root, npmCli, env, packageName) {
  const result = runNpmPack(root, npmCli, env, [
    "pack",
    "--dry-run",
    "--workspaces=false",
    "--global=false",
    "--prefix", root,
    "--ignore-scripts",
    "--silent",
    "--json",
  ]);
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("npm pack dry-run did not return valid JSON");
  }
  const record = normalizePackRecord(value, packageName);
  if (!Array.isArray(record?.files) || !record.files.length) {
    throw new Error("npm pack dry-run omitted the package file inventory");
  }
  return record.files.map((item) => {
    const path = validatePackagePath(item?.path);
    const mode = normalizePackMode(item?.mode);
    return { path, mode };
  });
}

function materializePublishedPackage(root, staging, inventory, pkg) {
  let sawManifest = false;
  for (const entry of inventory) {
    if (entry.path === "package.json") {
      sawManifest = true;
      continue;
    }
    const source = join(root, entry.path);
    const info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`npm package path is not a regular file: ${entry.path}`);
    }
    const target = join(staging, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, entry.mode);
  }
  if (!sawManifest) throw new Error("npm pack dry-run omitted package.json");
  const manifestEntry = inventory.find((entry) => entry.path === "package.json");
  const manifest = join(staging, "package.json");
  writeFileSync(manifest, publishedPackageJsonText(pkg), { mode: manifestEntry.mode });
  chmodSync(manifest, manifestEntry.mode);
}

function verifyPublishedInventory(files, inventory) {
  if (!Array.isArray(files)) throw new Error("staged npm pack omitted the package file inventory");
  const actual = new Map(files.map((item) => [validatePackagePath(item?.path), normalizePackMode(item?.mode)]));
  const expected = new Map(inventory.map((entry) => [entry.path, entry.mode]));
  if (actual.size !== expected.size) {
    throw new Error("staged published package inventory changed size");
  }
  for (const [path, mode] of expected) {
    if (actual.get(path) !== mode) {
      throw new Error(`staged published package inventory drifted: ${path}`);
    }
  }
}

function validatePackagePath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")
      || value.split("/").includes("..")) {
    throw new Error("npm pack returned an invalid package path");
  }
  return value;
}

function normalizePackMode(value) {
  const mode = Number.isSafeInteger(value) ? value & 0o777 : NaN;
  if (![0o644, 0o755].includes(mode)) {
    throw new Error(`npm pack returned an invalid file mode: ${String(value)}`);
  }
  return mode;
}

function runNpmPack(cwd, npmCli, env, args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    env: nestedNpmEnvironment(env),
    timeout: 5 * 60 * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure("npm", args, result));
  return result;
}

export function readAcceptance(root, version) {
  const path = acceptancePath(root, version);
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(
      path, MAX_ACCEPTANCE_BYTES, "release acceptance record",
      { verifyPathIdentity: true, rejectMultipleLinks: true },
    );
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("ENOENT") || message.includes("no such file")) {
      const archived = readFromArchiveLedger(root, version);
      if (archived) return archived;
    }
    if (message.includes("exceeds")) throw new Error(`release acceptance record exceeds ${MAX_ACCEPTANCE_BYTES} bytes`);
    if (message.includes("regular file") || message.includes("symbolic link") || message.includes("multiple links") || message.includes("identity changed")) {
      throw new Error(`release acceptance record must be a regular file: ${path}`);
    }
    throw error;
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`release acceptance record is not valid JSON: ${error.message}`);
  }
}

export function verifyAcceptanceRecord(record, metadata) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("release acceptance record must be an object");
  }
  const allowed = new Set([
    "schema_version", "result", "confirmation", "package_name", "package_version", "filename",
    "shasum", "integrity", "accepted_at", "package_content_sha256", "promotion_content_sha256",
  ]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`release acceptance record contains unsupported fields: ${unknown.join(", ")}`);
  if (record.schema_version !== ACCEPTANCE_SCHEMA_VERSION) {
    throw new Error(`unsupported release acceptance schema: ${record.schema_version}`);
  }
  if (record.result !== "passed") throw new Error("local release acceptance result is not passed");
  if (record.confirmation !== ACCEPTANCE_CONFIRMATION) {
    throw new Error("local release acceptance confirmation is missing or does not match the active verification workflow");
  }
  if (typeof record.accepted_at !== "string") throw new Error("local release acceptance timestamp is invalid");
  const acceptedAt = Date.parse(record.accepted_at);
  if (!Number.isFinite(acceptedAt)) throw new Error("local release acceptance timestamp is invalid");
  if (typeof record.package_content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.package_content_sha256)) {
    throw new Error("local release acceptance portable package-content digest is missing or invalid");
  }
  if (typeof record.promotion_content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.promotion_content_sha256)) {
    throw new Error("local release acceptance promotion-content digest is missing or invalid");
  }
  for (const key of ["package_name", "package_version", "filename", "shasum", "integrity"]) {
    if (record[key] !== metadata[key]) {
      throw new Error(`local release acceptance ${key} does not match the current npm package`);
    }
  }
  return Object.freeze({
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    result: "passed",
    confirmation: ACCEPTANCE_CONFIRMATION,
    package_name: metadata.package_name,
    package_version: metadata.package_version,
    filename: metadata.filename,
    shasum: metadata.shasum,
    integrity: metadata.integrity,
    accepted_at: new Date(acceptedAt).toISOString(),
    package_content_sha256: record.package_content_sha256,
    promotion_content_sha256: record.promotion_content_sha256,
  });
}

export function verifyCurrentReleaseAcceptance(root, options = {}) {
  const pkg = readPackage(root);
  const temp = mkdtempSync(join(tmpdir(), "mbm-release-acceptance-"));
  let result = null;
  let primaryError = null;
  try {
    const metadata = packProject(root, temp, options);
    const record = readAcceptance(root, pkg.version);
    verifyAcceptanceRecord(record, metadata);
    const bytes = verifyTarball(join(temp, metadata.filename), metadata);
    const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    result = { required: true, metadata, record, artifactSha256 };
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { rmSync(temp, { recursive: true, force: true }); }
  catch (error) { cleanupError = error; }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "release acceptance verification failed and temporary cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function verifyTarball(path, metadata) {
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(
      path, MAX_RELEASE_TARBALL_BYTES, "release candidate tarball",
      { verifyPathIdentity: true, rejectMultipleLinks: true },
    );
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("regular file") || message.includes("symbolic link") || message.includes("multiple hard links") || message.includes("identity changed")) {
      throw new Error("release candidate tarball is not a regular file");
    }
    throw error;
  }
  const shasum = createHash("sha1").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (shasum !== metadata.shasum || integrity !== metadata.integrity) {
    throw new Error("release candidate tarball hash does not match npm pack metadata");
  }
  return bytes;
}

export function normalizePackRecord(value, packageName) {
  if (Array.isArray(value)) return value[0] ?? null;
  if (!value || typeof value !== "object") return null;
  if (value[packageName] && typeof value[packageName] === "object") return value[packageName];
  return Object.values(value).find((item) => item && typeof item === "object") ?? null;
}

function readPackage(root) {
  const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof value.name !== "string" || !value.name) throw new Error("package.json name is invalid");
  parseReleaseVersion(value.version);
  return value;
}

function validatePackMetadata(metadata) {
  if (!metadata.filename.endsWith(".tgz") || metadata.filename.includes("/") || metadata.filename.includes("\\")) {
    throw new Error("npm pack returned an invalid filename");
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.shasum)) throw new Error("npm pack returned an invalid SHA-1 shasum");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.integrity)) throw new Error("npm pack returned an invalid SHA-512 integrity value");
}
