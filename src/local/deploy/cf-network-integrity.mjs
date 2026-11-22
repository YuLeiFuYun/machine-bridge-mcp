import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { readBoundedRegularFileSync } from "../core/secure-file.mjs";
import { requireContainedPath } from "../../shared/path-containment.mjs";

const OPERATIONAL_ERROR_CODES = new Set([
  "EACCES",
  "EPERM",
  "EIO",
  "ENOSPC",
  "EDQUOT",
  "ENOMEM",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EAGAIN",
  "ENOBUFS",
  "EINTR",
  "ESTALE",
  "EBUSY",
  "ETIMEDOUT",
]);

export class PrivateToolchainIntegrityError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PrivateToolchainIntegrityError";
    this.code = "private_toolchain_integrity_invalid";
  }
}

export function privateToolchainIntegrityError(message, cause = undefined) {
  return new PrivateToolchainIntegrityError(message, cause === undefined ? {} : { cause });
}

export function isPrivateToolchainIntegrityError(error) {
  return error instanceof PrivateToolchainIntegrityError
    || error?.code === "private_toolchain_integrity_invalid";
}

export function throwOperationalOrIntegrity(error, message) {
  if (error instanceof TypeError || error instanceof RangeError || operationalErrorCode(error)) throw error;
  throw privateToolchainIntegrityError(message, error);
}

export function operationalErrorCode(error) {
  const pending = [error];
  const seen = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const code = String(current.code || "");
    if (OPERATIONAL_ERROR_CODES.has(code)) return code;
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return "";
}
export const CF_NETWORK_ARTIFACT = Object.freeze({
  version: "1.0.0-rc.2",
  bundledUndici: "8.12.4",
  bundle: "dist/dist-aDyCGA5i.mjs",
  sha256: "a7c9b6202e476f6f75608d707f8e65e9e7e138bd3eb726baabd720299d39f6a8",
  undiciExport: "H",
});

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

export function verifyCfNetworkArtifact(root, { allowAbsent = false } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("cf toolchain root must be a path string");
  const canonicalRoot = realpathSync(path.resolve(root));
  const cfRoot = path.join(canonicalRoot, "node_modules", "cf");
  let cfInfo;
  try { cfInfo = lstatSync(cfRoot); }
  catch (error) {
    if (allowAbsent && error?.code === "ENOENT") return { present: false };
    throwOperationalOrIntegrity(error, "cf package is missing or structurally invalid");
  }
  if (cfInfo.isSymbolicLink() || !cfInfo.isDirectory()) throw privateToolchainIntegrityError("cf package must be a real directory");
  const manifestPath = path.join(cfRoot, "package.json");
  requireContainedRegularFile(canonicalRoot, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readBoundedRegularFileSync(manifestPath, 16 * 1024, "cf package manifest", {
      verifyPathIdentity: true, rejectMultipleLinks: true,
    }).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw privateToolchainIntegrityError("cf package manifest is not valid JSON");
    throw error;
  }
  if (manifest?.name !== "cf" || manifest.version !== CF_NETWORK_ARTIFACT.version) {
    throw privateToolchainIntegrityError("cf package version does not match the reviewed upstream artifact");
  }
  if (manifest?.devDependencies?.undici !== CF_NETWORK_ARTIFACT.bundledUndici) {
    throw privateToolchainIntegrityError("cf package bundled Undici version does not match the reviewed artifact");
  }
  const file = path.join(cfRoot, CF_NETWORK_ARTIFACT.bundle);
  requireContainedRegularFile(canonicalRoot, file);
  const bytes = readBoundedRegularFileSync(file, MAX_BUNDLE_BYTES, "cf network bundle", {
    verifyPathIdentity: true, rejectMultipleLinks: true,
  });
  if (createHash("sha256").update(bytes).digest("hex") !== CF_NETWORK_ARTIFACT.sha256) {
    throw privateToolchainIntegrityError("cf network bundle does not match the pinned upstream artifact");
  }
  return { present: true, version: manifest.version, bundleSha256: CF_NETWORK_ARTIFACT.sha256 };
}

function requireContainedRegularFile(root, file) {
  requireContainedPath(root, file, "cf artifact must remain inside its private toolchain", privateToolchainIntegrityError);
  const relative = path.relative(root, file);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) { throwOperationalOrIntegrity(error, "cf artifact is missing or structurally invalid"); }
    if (info.isSymbolicLink() || (current !== file && !info.isDirectory())
        || (current === file && (!info.isFile() || Number(info.nlink) !== 1
          || (process.platform !== "win32" && (Number(info.mode) & 0o022) !== 0)))) {
      throw privateToolchainIntegrityError("cf artifact must be a contained private regular file without aliases");
    }
  }
}
