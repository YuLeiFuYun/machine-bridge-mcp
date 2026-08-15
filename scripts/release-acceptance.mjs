import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readBoundedRegularFileSync } from "../src/local/secure-file.mjs";
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

export function packProject(root, destination, options = {}) {
  const npmCli = options.npmCli || process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("release acceptance commands must run through npm so npm_execpath is available");
  }
  const result = spawnSync(process.execPath, [
    npmCli,
    "pack",
    "--dry-run=false",
    "--workspaces=false",
    "--global=false",
    "--prefix", root,
    "--ignore-scripts",
    "--silent",
    "--json",
    "--pack-destination",
    destination,
  ], {
    cwd: root,
    encoding: "utf8",
    env: nestedNpmEnvironment(options.env || process.env),
    timeout: 5 * 60 * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure("npm", ["pack"], result));
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("npm pack did not return valid JSON");
  }
  const pkg = readPackage(root);
  const record = normalizePackRecord(value, pkg.name);
  if (!record) throw new Error("npm pack did not return package metadata");
  const metadata = {
    package_name: pkg.name,
    package_version: pkg.version,
    filename: String(record.filename || ""),
    shasum: String(record.shasum || ""),
    integrity: String(record.integrity || ""),
  };
  validatePackMetadata(metadata);
  verifyTarball(join(destination, metadata.filename), metadata);
  return metadata;
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
  const acceptedAt = Date.parse(String(record.accepted_at || ""));
  if (!Number.isFinite(acceptedAt)) throw new Error("local release acceptance timestamp is invalid");
  if (!/^[0-9a-f]{64}$/.test(String(record.package_content_sha256 || ""))) {
    throw new Error("local release acceptance portable package-content digest is missing or invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(String(record.promotion_content_sha256 || ""))) {
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
    package_content_sha256: String(record.package_content_sha256),
    ...(record.promotion_content_sha256 ? { promotion_content_sha256: String(record.promotion_content_sha256) } : {}),
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
