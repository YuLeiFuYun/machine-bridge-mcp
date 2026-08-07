import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { inspectPathIfPresentSync } from "./secure-file.mjs";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";

export const MANAGED_JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;

export function resolveManagedJobDirectory(jobRoot, value, options = {}) {
  const id = String(value || "");
  if (!MANAGED_JOB_ID.test(id)) throw new Error("invalid job id");
  const canonicalize = options.realpathSync || realpathSync;
  const root = canonicalize(resolve(String(jobRoot || "")));
  const candidate = join(root, id);
  const verify = options.lstatSync || ((target) => lstatSync(target, { bigint: true }));
  const inspect = options.inspectPath || ((target) => inspectPathIfPresentSync(
    target,
    "managed job directory",
    { ...(options.inspectOptions || {}), lstatSync: verify },
  ));
  const before = inspect(candidate);
  if (!before) throw new Error("job not found or expired");
  if (before.isSymbolicLink?.() || !before.isDirectory?.()) {
    throw new Error("managed job directory must be a real directory and not a symbolic link");
  }
  const canonical = canonicalize(candidate);
  requireContained(root, canonical);
  const after = verify(candidate);
  if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(before, after)) {
    throw new Error("managed job directory identity changed during inspection");
  }
  return canonical;
}

export function resolveManagedJobRootIfPresent(jobRoot, options = {}) {
  const target = resolve(String(jobRoot || ""));
  const verify = options.lstatSync || ((value) => lstatSync(value, { bigint: true }));
  const inspect = options.inspectPath || ((value) => inspectPathIfPresentSync(
    value,
    "managed job root",
    { ...(options.inspectOptions || {}), lstatSync: verify },
  ));
  const before = inspect(target);
  if (!before) return null;
  if (before.isSymbolicLink?.() || !before.isDirectory?.()) {
    throw new Error("managed job root must be a real directory and not a symbolic link");
  }
  const canonicalize = options.realpathSync || realpathSync;
  const canonical = canonicalize(target);
  const after = verify(target);
  if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(before, after)) {
    throw new Error("managed job root identity changed during inspection");
  }
  const canonicalInfo = verify(canonical);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory() || !sameIdentity(after, canonicalInfo)) {
    throw new Error("managed job root canonical target does not match the inspected directory");
  }
  return canonical;
}

function requireContained(root, candidate) {
  const value = relative(root, candidate);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error("managed job directory escapes the managed job root");
  }
}

function sameIdentity(left, right) {
  try {
    return sameFilesystemIdentity(
      filesystemIdentity(left, "managed job directory"),
      filesystemIdentity(right, "managed job directory"),
    );
  } catch {
    return false;
  }
}
