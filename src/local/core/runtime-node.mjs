import { accessSync, constants, statSync, lstatSync, realpathSync } from "node:fs";
import path, { posix, win32 } from "node:path";
import { packageName, packageVersion } from "./timing.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";

export function resolveRuntimeNodeExecutable({
  execPath = process.execPath,
  argv0 = process.argv0,
  platform = process.platform,
  isExecutable = null,
} = {}) {
  const executable = typeof isExecutable === "function"
    ? (candidate) => safeExecutableCheck(isExecutable, candidate)
    : (candidate) => executableFile(candidate, platform);
  const execPathAvailable = absoluteCandidate(execPath, platform) && executable(execPath);
  const launcherAvailable = trustedOriginalNodeLauncher(argv0, platform) && executable(argv0);
  if (execPathAvailable) return {
    available: true, command: execPath, source: "exec_path", exec_path_available: true,
    original_launcher_available: launcherAvailable, fallback_active: false,
  };
  if (launcherAvailable) return {
    available: true, command: argv0, source: "original_launcher", exec_path_available: false,
    original_launcher_available: true, fallback_active: true,
  };
  return {
    available: false, command: null, source: "unavailable", exec_path_available: false,
    original_launcher_available: false, fallback_active: false,
  };
}

export function runtimeNodeExecutableCheck(runtimeNode) {
  return {
    layer: "runtime-node-executable",
    ok: runtimeNode.available,
    source: runtimeNode.source,
    exec_path_available: runtimeNode.exec_path_available,
    original_launcher_available: runtimeNode.original_launcher_available,
    fallback_active: runtimeNode.fallback_active,
    error_class: runtimeNode.available ? null : "not_found",
  };
}

export async function runtimeNodeProcessCheck({
  runtimeNode, runFixedInternal, timeoutMs, context, workspace, classifyError,
}) {
  if (!runtimeNode.available) return {
    layer: "local-process-spawn", ok: false, error_class: "not_found",
    runtime_executable_source: runtimeNode.source,
  };
  const direct = await runFixedInternal(
    runtimeNode.command, ["-e", "process.stdout.write('ok')"], timeoutMs, true, 1024, context, workspace,
  ).catch((error) => ({ code: 127, stdout: "", stderr: "", error_class: classifyError(error) }));
  return {
    layer: "local-process-spawn",
    ok: direct.code === 0 && direct.stdout === "ok",
    runtime_executable_source: runtimeNode.source,
    error_class: direct.error_class
      || (direct.code === 0 ? null : classifyError(direct.stderr || direct.stdout || "execution failed")),
  };
}

function absoluteCandidate(value, platform) {
  return typeof value === "string" && value.length > 0 && pathApi(platform).isAbsolute(value);
}

function trustedOriginalNodeLauncher(value, platform) {
  if (!absoluteCandidate(value, platform)) return false;
  const name = pathApi(platform).basename(value).toLowerCase();
  return name === "node" || name === "node.exe";
}

function executableFile(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

function safeExecutableCheck(check, candidate) {
  try { return check(candidate) === true; } catch { return false; }
}

function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}
const MAX_PACKAGE_MANIFEST_BYTES = 2 * 1024 * 1024;

const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function inspectRuntimePackageIdentity(entryScript, options = {}) {
  const expectedName = options.expectedName ?? packageName;
  const expectedVersion = options.expectedVersion ?? packageVersion;
  const platform = options.platform ?? process.platform;
  const requestedEntry = entryScript;
  if (typeof requestedEntry !== "string" || !requestedEntry || !path.isAbsolute(requestedEntry)) {
    throw new TypeError("runtime package entry must be an absolute path");
  }
  if (typeof expectedName !== "string" || typeof expectedVersion !== "string"
      || typeof platform !== "string" || !expectedName || !expectedVersion || !PACKAGE_VERSION.test(expectedVersion)) {
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
  const version = manifest?.version;
  if (manifest?.name !== expectedName || typeof version !== "string" || !PACKAGE_VERSION.test(version)) {
    throw new Error("runtime package identity is invalid");
  }
  if (version !== expectedVersion) {
    throw new Error(`runtime package version ${version} does not match expected version ${expectedVersion}`);
  }
  return Object.freeze({ name: expectedName, version, packageRoot: canonicalPackageRoot, entry: canonicalEntry });
}
