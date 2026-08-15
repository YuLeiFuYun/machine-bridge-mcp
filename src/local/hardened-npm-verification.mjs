import { lstatSync } from "node:fs";
import path from "node:path";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import {
  privateToolchainIntegrityError,
  throwOperationalOrIntegrity,
} from "./private-toolchain-integrity.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "./secure-file.mjs";

const MAX_MARKER_BYTES = 16 * 1024;
const HARDENED_NPM_MARKER = ".machine-bridge-mcp-hardened-npm.json";

export function verifyHardenedNpmTree(root, artifacts, execute) {
  const target = path.resolve(root);
  ensureOwnerOnlyDirectorySync(target);
  const npmRoot = path.join(target, "package");
  const nodeModules = path.join(npmRoot, "node_modules");
  requireRealDirectory(npmRoot, "hardened npm package root");
  requireRealDirectory(nodeModules, "hardened npm node_modules");
  verifyHardenedPackageIdentity(npmRoot, "npm", artifacts[0].version);
  verifyHardenedPackageIdentity(path.join(nodeModules, "undici"), "undici", artifacts[1].version);
  verifyHardenedPackageIdentity(path.join(nodeModules, "brace-expansion"), "brace-expansion", artifacts[2].version);
  const binRoot = path.join(npmRoot, "bin");
  requireRealDirectory(binRoot, "hardened npm bin directory");
  const cli = path.join(binRoot, "npm-cli.js");
  let info;
  try { info = lstatSync(cli); }
  catch (error) { throwOperationalOrIntegrity(error, "hardened npm CLI is missing or unreadable"); }
  if (info.isSymbolicLink() || !info.isFile() || Number(info.nlink) !== 1 || (process.platform !== "win32" && (Number(info.mode) & 0o022) !== 0)) {
    throw privateToolchainIntegrityError("hardened npm CLI is not a private real regular file");
  }
  const reported = String(execute(process.execPath, [cli, "--version"], { capture: true })).trim();
  if (reported !== artifacts[0].version) {
    throw privateToolchainIntegrityError(`hardened npm CLI reported ${reported || "no version"}`);
  }
  return Object.freeze({
    cli,
    version: artifacts[0].version,
    undiciVersion: artifacts[1].version,
    braceExpansionVersion: artifacts[2].version,
  });
}

function requireRealDirectory(directory, label) {
  let info;
  try { info = lstatSync(directory); }
  catch (error) { throwOperationalOrIntegrity(error, `${label} is missing or unreadable`); }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw privateToolchainIntegrityError(`${label} is not a real directory`);
  }
}

export function readHardenedNpmMarker(root) {
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(path.join(root, HARDENED_NPM_MARKER), MAX_MARKER_BYTES, "hardened npm marker", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throwOperationalOrIntegrity(error, "hardened npm marker is structurally invalid");
  }
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw privateToolchainIntegrityError("hardened npm marker is not valid JSON", error); }
}

export function hardenedNpmMarkerMatches(marker, identity) {
  return marker?.schema_version === 1
    && marker.digest === identity.digest
    && marker.npm === identity.npmVersion
    && marker.undici === identity.undiciVersion
    && marker.brace_expansion === identity.braceExpansionVersion;
}

export function writeHardenedNpmMarker(root, identity) {
  replaceFileAtomicallySync(path.join(root, HARDENED_NPM_MARKER), `${JSON.stringify({
    schema_version: 1,
    digest: identity.digest,
    npm: identity.npmVersion,
    undici: identity.undiciVersion,
    brace_expansion: identity.braceExpansionVersion,
  }, null, 2)}\n`, { mode: 0o600 });
}

export function verifyHardenedPackageIdentity(directory, name, version) {
  requireRealDirectory(directory, `${name} package directory`);
  const file = path.join(directory, "package.json");
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(file, 2 * 1024 * 1024, `${name} package manifest`, {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    throwOperationalOrIntegrity(error, `${name} package manifest is missing or structurally invalid`);
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw privateToolchainIntegrityError(`${name} package manifest is not valid JSON`, error); }
  if (manifest?.name !== name || manifest?.version !== version) {
    throw privateToolchainIntegrityError(`${name} package identity does not match ${version}`);
  }
}
