import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { filesystemIdentity } from "./filesystem-identity.mjs";

export const MANAGED_JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;

export function resolveManagedJobDirectory(jobRoot, value, options = {}) {
  const id = String(value || "");
  if (!MANAGED_JOB_ID.test(id)) throw new Error("invalid job id");
  const root = resolveManagedJobRootIfPresent(jobRoot, options);
  if (!root) throw new Error("job not found or expired");
  const candidate = join(root, id);
  return withPinnedDirectory(candidate, "managed job directory", options, false, (pinned, verify) => {
    const canonical = (options.realpathSync || realpathSync)(candidate);
    requireContained(root, canonical);
    if (!sameDirectory(pinned, verify(candidate)) || !sameDirectory(pinned, verify(canonical))) {
      throw new Error("managed job directory identity changed during inspection");
    }
    return canonical;
  });
}

export function resolveManagedJobRootIfPresent(jobRoot, options = {}) {
  const target = resolve(String(jobRoot || ""));
  return withPinnedDirectory(target, "managed job root", options, true, (pinned, verify) => {
    const canonical = (options.realpathSync || realpathSync)(target);
    if (!sameDirectory(pinned, verify(target))) throw new Error("managed job root identity changed during inspection");
    if (!sameDirectory(pinned, verify(canonical))) {
      throw new Error("managed job root canonical target does not match the inspected directory");
    }
    return canonical;
  });
}

function withPinnedDirectory(target, label, options, missingAllowed, callback) {
  const verify = options.lstatSync || ((value) => lstatSync(value, { bigint: true }));
  const platform = String(options.platform || process.platform);
  if (platform === "win32") {
    let info;
    try { info = verify(target); } catch (error) {
      if (missingAllowed && error?.code === "ENOENT") return null;
      throw error;
    }
    if (info.isSymbolicLink?.() || !info.isDirectory?.()) throw new Error(`${label} must be a real directory and not a symbolic link`);
    return callback(info, verify);
  }
  const open = options.openSync || openSync;
  let fd;
  try { fd = open(target, Number(fsConstants.O_RDONLY) | Number(fsConstants.O_NOFOLLOW) | Number(fsConstants.O_DIRECTORY)); }
  catch (error) {
    if (missingAllowed && error?.code === "ENOENT") return null;
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) throw new Error(`${label} must be a real directory and not a symbolic link`, { cause: error });
    if (error?.code === "ENOENT") throw new Error("job not found or expired", { cause: error });
    throw error;
  }
  try {
    const info = (options.fstatSync || ((value) => fstatSync(value, { bigint: true })))(fd);
    if (!info.isDirectory?.()) throw new Error(`${label} must be a real directory and not a symbolic link`);
    return callback(info, verify);
  } finally { (options.closeSync || closeSync)(fd); }
}

function sameDirectory(left, right) {
  try {
    if (right.isSymbolicLink?.() || !right.isDirectory?.()) return false;
    const a = filesystemIdentity(left, "managed job directory");
    const b = filesystemIdentity(right, "managed job directory");
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

function requireContained(root, candidate) {
  const value = relative(root, candidate);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error("managed job directory escapes the managed job root");
}
