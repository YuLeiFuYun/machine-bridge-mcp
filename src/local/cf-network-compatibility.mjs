import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { privateToolchainIntegrityError, throwOperationalOrIntegrity } from "./private-toolchain-integrity.mjs";

export const CF_NETWORK_COMPATIBILITY = Object.freeze({
  version: "1.0.0-beta.5",
  undici: "7.29.1",
  bundle: "dist/dist-DfMipWKR.mjs",
  originalSha256: "5d55682ff9886ca43946efaea575b4f00438df592ef20db1faaa85493e1929c7",
  patchedSha256: "719025f199195ddd646e67473c406740de8ac2fa38f5de244cceb960459843f1",
});
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const FACTORY_START = 869268;
const FACTORY_END = 873255;
const PATCH_IMPORT = 'import __mbmUndici from "undici";\n';

export function transformCfNetworkBundle(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) throw new TypeError("cf bundle must be text or bytes");
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length > MAX_BUNDLE_BYTES) throw privateToolchainIntegrityError("cf network bundle exceeds its byte limit");
  const digest = sha256(bytes);
  if (digest === CF_NETWORK_COMPATIBILITY.patchedSha256) return bytes.toString("utf8");
  if (digest !== CF_NETWORK_COMPATIBILITY.originalSha256) {
    throw privateToolchainIntegrityError("cf network bundle does not match the pinned upstream or patched artifact");
  }
  const source = bytes.toString("utf8");
  const firstLineEnd = source.indexOf("\n") + 1;
  if (!source.startsWith("#!/usr/bin/env node\n")
      || source.slice(FACTORY_START, FACTORY_START + 5) !== "Ry=e("
      || source.slice(FACTORY_END, FACTORY_END + 9) !== ",zy=Ry();") {
    throw privateToolchainIntegrityError("cf network factory layout is not the reviewed layout");
  }
  const replaced = source.slice(0, FACTORY_START) + "Ry=()=>__mbmUndici" + source.slice(FACTORY_END);
  const patched = replaced.slice(0, firstLineEnd) + PATCH_IMPORT + replaced.slice(firstLineEnd);
  if (sha256(Buffer.from(patched, "utf8")) !== CF_NETWORK_COMPATIBILITY.patchedSha256) {
    throw privateToolchainIntegrityError("cf network transformation did not produce the reviewed artifact");
  }
  return patched;
}

export function applyCfNetworkCompatibility(root, { allowAbsent = false } = {}) {
  const canonicalRoot = realpathSync(path.resolve(String(root)));
  const cfRoot = path.join(canonicalRoot, "node_modules", "cf");
  let cfInfo;
  try { cfInfo = lstatSync(cfRoot); }
  catch (error) {
    if (allowAbsent && error?.code === "ENOENT") return { present: false, changed: false };
    throwOperationalOrIntegrity(error, "cf package is missing or structurally invalid");
  }
  if (cfInfo.isSymbolicLink() || !cfInfo.isDirectory()) throw privateToolchainIntegrityError("cf package must be a real directory");
  const manifestPath = path.join(cfRoot, "package.json");
  requireContainedRegularFile(canonicalRoot, manifestPath);
  const manifest = JSON.parse(readBoundedRegularFileSync(manifestPath, 16 * 1024, "cf package manifest", {
    verifyPathIdentity: true, rejectMultipleLinks: true,
  }).toString("utf8"));
  if (manifest.name !== "cf" || manifest.version !== CF_NETWORK_COMPATIBILITY.version) {
    throw privateToolchainIntegrityError("cf package version does not match the reviewed compatibility artifact");
  }
  const file = path.join(cfRoot, CF_NETWORK_COMPATIBILITY.bundle);
  requireContainedRegularFile(canonicalRoot, file);
  const before = readBoundedRegularFileSync(file, MAX_BUNDLE_BYTES, "cf network bundle", {
    verifyPathIdentity: true, rejectMultipleLinks: true,
  });
  const patched = transformCfNetworkBundle(before);
  const changed = !before.equals(Buffer.from(patched, "utf8"));
  if (changed) replaceFileAtomicallySync(file, patched, { mode: 0o600 });
  requireContainedRegularFile(canonicalRoot, file);
  const verified = readBoundedRegularFileSync(file, MAX_BUNDLE_BYTES, "patched cf network bundle", {
    verifyPathIdentity: true, rejectMultipleLinks: true,
  });
  if (sha256(verified) !== CF_NETWORK_COMPATIBILITY.patchedSha256) {
    throw privateToolchainIntegrityError("cf network bundle changed before verification");
  }
  return { present: true, changed, version: manifest.version, bundleSha256: CF_NETWORK_COMPATIBILITY.patchedSha256 };
}

function requireContainedRegularFile(root, file) {
  let info;
  try { info = lstatSync(file); }
  catch (error) { throwOperationalOrIntegrity(error, "cf artifact is missing or structurally invalid"); }
  const relative = path.relative(root, realpathSync(file));
  if (info.isSymbolicLink() || !info.isFile() || Number(info.nlink) !== 1
      || !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || (process.platform !== "win32" && (Number(info.mode) & 0o022) !== 0)) {
    throw privateToolchainIntegrityError("cf artifact must be a contained private regular file");
  }
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

// A consumer installation omits cf. Source installations patch the exact dev
// dependency before its public bin or config imports can run.
if (process.argv[2] === "--install-if-present" && process.argv[1]
    && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyCfNetworkCompatibility(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), { allowAbsent: true });
}
