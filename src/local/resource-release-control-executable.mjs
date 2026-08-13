import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

const RELEASE_CONTROL_UNSAFE_ENVIRONMENT_KEYS = new Set([
  "NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "NODE_COMPILE_CACHE", "NODE_ICU_DATA",
  "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_REDIRECT_WARNINGS", "NODE_EXTRA_CA_CERTS", "NODE_PRESERVE_SYMLINKS",
  "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR", "SSLKEYLOGFILE", "OPENSSL_CONF",
  "UV_THREADPOOL_SIZE", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FALLBACK_FRAMEWORK_PATH",
]);

export function releaseControlEnvironmentIsTrusted(environment = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) return false;
  return !Object.keys(environment).some((key) => RELEASE_CONTROL_UNSAFE_ENVIRONMENT_KEYS.has(String(key).toUpperCase()));
}

export async function releaseControlExecutableIsTrusted(command, environment = {}, options = {}) {
  if (!releaseControlEnvironmentIsTrusted(environment)) return false;
  const platform = String(options.platform || process.platform);
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const cwd = pathApi.resolve(String(options.cwd || "."));
  const lookupOptions = { ...options, cwd, platform, pathApi };
  const invoked = await resolveInvokedExecutable(command, environment, lookupOptions);
  if (!invoked) return false;
  const runtime = await inspectExecutable(options.runtimeExecutable || process.execPath, lookupOptions);
  if (!runtime) return false;
  return samePath(invoked.path, runtime.path, platform);
}

async function resolveInvokedExecutable(command, environment, options) {
  const raw = String(command || "");
  if (!raw) return null;
  const { cwd, platform, pathApi } = options;
  if (pathApi.isAbsolute(raw) || raw.includes("/") || raw.includes("\\")) {
    return inspectExecutable(pathApi.resolve(cwd, raw), options);
  }
  const search = String(environment?.PATH || environment?.Path || "");
  if (!search) return null;
  const roots = search.split(pathApi.delimiter);
  if (platform === "win32") roots.unshift(cwd);
  const names = platform === "win32" ? windowsNames(raw, environment?.PATHEXT, pathApi) : [raw];
  for (const root of roots) {
    const directory = root ? (pathApi.isAbsolute(root) ? pathApi.resolve(root) : pathApi.resolve(cwd, root)) : cwd;
    for (const name of names) {
      const result = await inspectExecutable(pathApi.join(directory, name), options);
      if (result) return result;
    }
  }
  return null;
}

async function inspectExecutable(candidate, options) {
  try {
    if (options.platform !== "win32") await (options.access || access)(candidate, fsConstants.X_OK);
    const canonical = await (options.realpath || realpath)(candidate);
    const info = await (options.stat || stat)(canonical);
    return info.isFile() ? { path: canonical } : null;
  } catch { return null; }
}

function windowsNames(command, value, pathApi) {
  const extensions = String(value || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return pathApi.extname(command) ? [command] : [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function samePath(left, right, platform) {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
