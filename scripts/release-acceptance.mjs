import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const ACCEPTANCE_SCHEMA_VERSION = 1;
export const ACCEPTANCE_POLICY_VERSION = "1.2.8";
export const AGENT_VERIFIED_ACCEPTANCE_VERSION = "1.2.9";
export const ACCEPTANCE_CONFIRMATION = "owner-started-agent-verified-local-candidate";
export const LEGACY_ACCEPTANCE_CONFIRMATION = "repository-owner-local-test";
const MAX_ACCEPTANCE_BYTES = 64 * 1024;

export function requiresLocalAcceptance(version) {
  return compareVersions(parseVersion(version), parseVersion(ACCEPTANCE_POLICY_VERSION)) >= 0;
}

export function acceptanceConfirmationForVersion(version) {
  return compareVersions(parseVersion(version), parseVersion(AGENT_VERIFIED_ACCEPTANCE_VERSION)) >= 0
    ? ACCEPTANCE_CONFIRMATION
    : LEGACY_ACCEPTANCE_CONFIRMATION;
}

export function acceptancePath(root, version) {
  return join(root, "release-acceptance", `v${version}.json`);
}

export function packProject(root, destination) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("release acceptance commands must run through npm so npm_execpath is available");
  }
  const result = spawnSync(process.execPath, [
    npmCli,
    "pack",
    "--ignore-scripts",
    "--silent",
    "--json",
    "--pack-destination",
    destination,
  ], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm pack failed: ${String(result.stderr || result.stdout).trim()}`);
  }
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
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`release acceptance record must be a regular file: ${path}`);
  }
  if (stat.size > MAX_ACCEPTANCE_BYTES) {
    throw new Error(`release acceptance record exceeds ${MAX_ACCEPTANCE_BYTES} bytes`);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`release acceptance record is not valid JSON: ${error.message}`);
  }
  return value;
}

export function verifyAcceptanceRecord(record, metadata) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("release acceptance record must be an object");
  }
  if (record.schema_version !== ACCEPTANCE_SCHEMA_VERSION) {
    throw new Error(`unsupported release acceptance schema: ${record.schema_version}`);
  }
  if (record.result !== "passed") throw new Error("local release acceptance result is not passed");
  const expectedConfirmation = acceptanceConfirmationForVersion(metadata.package_version);
  if (record.confirmation !== expectedConfirmation) {
    throw new Error("local release acceptance confirmation is missing or does not match the active verification workflow");
  }
  const acceptedAt = Date.parse(String(record.accepted_at || ""));
  if (!Number.isFinite(acceptedAt)) throw new Error("local release acceptance timestamp is invalid");
  for (const key of ["package_name", "package_version", "filename", "shasum", "integrity"]) {
    if (record[key] !== metadata[key]) {
      throw new Error(`local release acceptance ${key} does not match the current npm package`);
    }
  }
  return record;
}

export function verifyCurrentReleaseAcceptance(root) {
  const pkg = readPackage(root);
  if (!requiresLocalAcceptance(pkg.version)) {
    return { required: false, version: pkg.version };
  }
  const temp = mkdtempSync(join(tmpdir(), "mbm-release-acceptance-"));
  try {
    const metadata = packProject(root, temp);
    const record = readAcceptance(root, pkg.version);
    verifyAcceptanceRecord(record, metadata);
    return { required: true, metadata, record };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function verifyTarball(path, metadata) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("release candidate tarball is not a regular file");
  const bytes = readFileSync(path);
  const shasum = createHash("sha1").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (shasum !== metadata.shasum || integrity !== metadata.integrity) {
    throw new Error("release candidate tarball hash does not match npm pack metadata");
  }
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
  if (!parseVersion(value.version)) throw new Error("package.json version is invalid");
  return value;
}

function validatePackMetadata(metadata) {
  if (!metadata.filename.endsWith(".tgz") || metadata.filename.includes("/") || metadata.filename.includes("\\")) {
    throw new Error("npm pack returned an invalid filename");
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.shasum)) throw new Error("npm pack returned an invalid SHA-1 shasum");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.integrity)) throw new Error("npm pack returned an invalid SHA-512 integrity value");
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(value || ""));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  if (!left || !right) throw new Error("version comparison requires semantic versions");
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
