import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { packageName, packageVersion } from "./package-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";

const MAX_PACKAGE_MANIFEST_BYTES = 2 * 1024 * 1024;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function inspectRuntimePackageIdentity(entryScript, options = {}) {
  const expectedName = String(options.expectedName || packageName);
  const expectedVersion = String(options.expectedVersion || packageVersion);
  const platform = String(options.platform || process.platform);
  const requestedEntry = String(entryScript || "");
  if (!requestedEntry || !path.isAbsolute(requestedEntry)) {
    throw new TypeError("runtime package entry must be an absolute path");
  }
  if (!expectedName || !expectedVersion || !PACKAGE_VERSION.test(expectedVersion)) {
    throw new TypeError("runtime package identity requires a valid expected name and version");
  }

  const entryInfo = lstatSync(requestedEntry);
  if (entryInfo.isSymbolicLink() || !entryInfo.isFile() || Number(entryInfo.nlink) !== 1
      || (platform !== "win32" && (Number(entryInfo.mode) & 0o022) !== 0)) {
    throw new Error("runtime package entry must be a private regular file");
  }
  const lexicalBin = path.dirname(requestedEntry);
  const lexicalRoot = path.resolve(lexicalBin, "..");
  for (const [candidate, label] of [[lexicalBin, "bin directory"], [lexicalRoot, "package root"]]) {
    const info = lstatSync(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`runtime package ${label} must be a real directory`);
  }
  const canonicalEntry = realpathSync(requestedEntry);
  const canonicalPackageRoot = realpathSync(lexicalRoot);
  const expectedEntry = path.join(canonicalPackageRoot, "bin", "machine-mcp.mjs");
  let canonicalExpectedEntry;
  try { canonicalExpectedEntry = realpathSync(expectedEntry); }
  catch (error) { throw new Error("runtime package CLI is missing", { cause: error }); }
  const sameEntry = platform === "win32"
    ? canonicalExpectedEntry.toLowerCase() === canonicalEntry.toLowerCase()
    : canonicalExpectedEntry === canonicalEntry;
  if (!sameEntry) throw new Error("runtime package entry is not the package CLI");

  const manifestPath = path.join(canonicalPackageRoot, "package.json");
  const manifestBytes = readBoundedRegularFileSync(
    manifestPath,
    MAX_PACKAGE_MANIFEST_BYTES,
    "runtime package manifest",
    { verifyPathIdentity: true, rejectMultipleLinks: true },
  );
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  catch (error) { throw new Error("runtime package manifest is not valid JSON", { cause: error }); }
  const version = String(manifest?.version || "");
  if (manifest?.name !== expectedName || !PACKAGE_VERSION.test(version)) {
    throw new Error("runtime package identity is invalid");
  }
  if (version !== expectedVersion) {
    throw new Error(`runtime package version ${version} does not match expected version ${expectedVersion}`);
  }
  return Object.freeze({ name: expectedName, version, packageRoot: canonicalPackageRoot, entry: canonicalEntry });
}
