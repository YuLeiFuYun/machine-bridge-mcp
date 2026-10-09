import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { privateToolchainIntegrityError, throwOperationalOrIntegrity } from "./private-toolchain-integrity.mjs";

export const CF_NETWORK_ARTIFACT = Object.freeze({
  version: "1.0.0-beta.13",
  bundledUndici: "7.30.0",
  bundle: "dist/dist-BHEmAAHr.mjs",
  sha256: "44d51802036f7c7d936c2f467386c435e8487fd4cef61b2ace3c5ad53efbed57",
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
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw privateToolchainIntegrityError("cf artifact must remain inside its private toolchain");
  }
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
