import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.mjs";

export function resolveTrustedExecutable(options = {}) {
  const platform = String(options.platform || process.platform);
  const candidates = Array.isArray(options.candidates) ? options.candidates : [];
  const deniedRoots = [options.workspace, options.stateRoot, options.runtimeDir, options.home || safeHome()]
    .filter(Boolean).map((value) => canonicalOrResolved(String(value), options.realpath || realpathSync));
  const realpath = options.realpath || realpathSync;
  const stat = options.stat || statSync;
  const access = options.access || accessSync;
  for (const candidate of candidates) {
    if (!path.isAbsolute(String(candidate || ""))) continue;
    let canonical;
    let info;
    try {
      canonical = realpath(String(candidate));
      info = stat(canonical);
      if (!info.isFile()) continue;
      if (platform !== "win32") access(canonical, fsConstants.X_OK);
    } catch { continue; }
    if (platform !== "win32" && (Number(info.mode) & 0o022) !== 0) continue;
    if (deniedRoots.some((root) => isWithin(canonical, root, platform))) continue;
    return canonical;
  }
  const label = String(options.label || "required executable").replace(/[^A-Za-z0-9._ -]/g, "").trim() || "required executable";
  const reason = String(options.reason || "trusted_executable_unavailable").replace(/[^A-Za-z0-9_-]/g, "_");
  throw new BridgeError("unavailable", `trusted ${label} is unavailable`, { details: { reason, platform } });
}

export function createTrustedExecutableResolver(options = {}) {
  const injected = typeof options.resolve === "function" ? options.resolve : null;
  let cached = "";
  return () => {
    if (cached) return cached;
    cached = String(injected ? injected() : resolveTrustedExecutable(options));
    if (!path.isAbsolute(cached)) throw new BridgeError("unavailable", `trusted ${options.label || "executable"} is unavailable`);
    return cached;
  };
}

function canonicalOrResolved(value, realpath) {
  try { return realpath(path.resolve(value)); } catch { return path.resolve(value); }
}
function isWithin(candidate, root, platform) {
  const left = platform === "win32" ? candidate.toLowerCase() : candidate;
  const right = platform === "win32" ? root.toLowerCase() : root;
  const relative = path.relative(right, left);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function safeHome() { try { return os.homedir(); } catch { return ""; } }
