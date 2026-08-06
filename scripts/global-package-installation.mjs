import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readBoundedRegularFileSync } from "../src/local/secure-file.mjs";

const MAX_PACKAGE_MANIFEST_BYTES = 2 * 1024 * 1024;

export function inspectGlobalPackageInstallation(globalRoot, packageName) {
  const rootInput = String(globalRoot || "").trim();
  const name = String(packageName || "");
  if (!rootInput || !isAbsolute(rootInput) || !name || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new TypeError("global package inspection requires a valid package name and absolute root");
  }
  let root;
  try { root = realpathSync(resolve(rootInput)); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const packageRoot = join(root, name);
  let packageInfo;
  try { packageInfo = lstatSync(packageRoot); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (packageInfo.isSymbolicLink() || !packageInfo.isDirectory()) {
    throw new Error("globally installed package root must be a real directory");
  }
  const canonicalPackageRoot = realpathSync(packageRoot);
  const packageRelative = relative(root, canonicalPackageRoot);
  if (!packageRelative || packageRelative.startsWith(`..${sep}`) || packageRelative === ".." || isAbsolute(packageRelative)) {
    throw new Error("globally installed package root escapes the npm global root");
  }
  const packagePath = join(canonicalPackageRoot, "package.json");
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(packagePath, MAX_PACKAGE_MANIFEST_BYTES, "globally installed package manifest", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("globally installed package manifest is missing", { cause: error });
    throw error;
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("globally installed package manifest is not valid JSON"); }
  const version = String(value?.version || "");
  if (value?.name !== name || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("globally installed package identity is invalid");
  }
  const entry = join(canonicalPackageRoot, "bin", "machine-mcp.mjs");
  let info;
  try { info = lstatSync(entry); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("globally installed package CLI is missing", { cause: error });
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || Number(info.nlink) !== 1 || (process.platform !== "win32" && (Number(info.mode) & 0o022) !== 0)) {
    throw new Error("globally installed package CLI must be a private regular file");
  }
  const canonicalEntry = realpathSync(entry);
  const entryRelative = relative(canonicalPackageRoot, canonicalEntry);
  if (!entryRelative || entryRelative.startsWith(`..${sep}`) || entryRelative === ".." || isAbsolute(entryRelative)) {
    throw new Error("globally installed package CLI escapes the package root");
  }
  return Object.freeze({ version, entry: canonicalEntry });
}
