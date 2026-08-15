import { randomBytes } from "node:crypto";
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance, processStartTimeMs } from "./process-identity.mjs";
import { ownerOnlyFile, readBoundedRegularFileWithInfoSync, retryTransientMultipleLinksSync } from "./secure-file.mjs";
import { exactFilesystemInteger, filesystemIdentity, filesystemTimeMs, sameFilesystemIdentity } from "./filesystem-identity.mjs";

export function acquireRecoveryLock(dir) {
  return acquirePidLock(join(dir, "recovery.lock"), { allowHandoff: true });
}

export function acquireJobCapacityLock(jobRoot) {
  return acquirePidLock(join(jobRoot, "capacity.lock"));
}

export function acquireJobTransitionLock(dir) {
  return acquirePidLock(join(dir, "transition.lock"));
}

export function activeManagedJobLock(file) {
  let snapshot;
  try { snapshot = readPidLockSnapshot(file); } catch {
    return { active: true, pid: null, reason: "invalid_or_unreadable_lock" };
  }
  if (!snapshot) return null;
  const age = Date.now() - snapshot.info.mtimeMs;
  if (!snapshot.owner || !Number.isInteger(snapshot.owner.pid) || snapshot.owner.pid <= 0
      || !Number.isFinite(Date.parse(String(snapshot.owner.startedAt || "")))) {
    return age < 60_000 ? { active: true, pid: null, reason: "recent_malformed_lock" } : null;
  }
  const identity = inspectProcessInstance(snapshot.owner, { maxAgeMs: 5 * 60_000 });
  if (identity.current || (identity.alive && !identity.reclaimable)) {
    return { active: true, pid: snapshot.owner.pid, reason: identity.reason };
  }
  return null;
}

function acquirePidLock(file, { allowHandoff = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = pidLockOwner(process.pid, currentProcessStartTimeMs());
    try {
      createExclusiveFileSync(file, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      return {
        ...(allowHandoff ? {
          handoff(pid) {
            if (!Number.isInteger(pid) || pid <= 0) return;
            const nextOwner = { ...pidLockOwner(pid, processStartTimeMs(pid)), token: owner.token };
            replacePrivateTextFile(file, `${JSON.stringify(nextOwner)}\n`);
          },
        } : {}),
        token: owner.token,
        release() { removePidLockOwnedBy(file, owner.token); },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const snapshot = readPidLockSnapshot(file);
      if (!snapshot) continue;
      const age = Date.now() - snapshot.info.mtimeMs;
      const identity = snapshot.owner ? inspectProcessInstance(snapshot.owner, { maxAgeMs: 5 * 60_000 }) : null;
      const definitelyStale = !snapshot.owner ? age >= 60_000 : identity.reclaimable === true;
      if (!definitelyStale) return null;
      removePidLockSnapshot(file, snapshot);
    }
  }
  return null;
}

function pidLockOwner(pid, startedAtMs) {
  return {
    pid,
    token: randomBytes(16).toString("hex"),
    startedAt: new Date().toISOString(),
    processStartedAt: Number.isFinite(startedAtMs) && startedAtMs > 0 ? new Date(startedAtMs).toISOString() : null,
  };
}

function readPidLockSnapshot(file) {
  let opened;
  try {
    opened = retryTransientMultipleLinksSync(() => readBoundedRegularFileWithInfoSync(file, 1024, "job lock", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    }));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return null;
    throw error;
  }
  let owner = null;
  try {
    const parsed = JSON.parse(opened.buffer.toString("utf8").trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) owner = parsed;
  } catch { /* Successfully read malformed JSON may be reclaimed only after the stale grace. */ }
  return { owner, info: pidLockIdentity(opened.identityInfo, opened.identity) };
}

function removePidLockOwnedBy(file, token) {
  const snapshot = readPidLockSnapshot(file);
  if (!snapshot || snapshot.owner?.token !== token) return false;
  return removePidLockSnapshot(file, snapshot);
}

function removePidLockSnapshot(file, snapshot) {
  let current;
  try { current = lstatSync(file, { bigint: true }); } catch (error) { return error?.code === "ENOENT"; }
  if (current.isSymbolicLink() || !current.isFile()) return false;
  if (!samePidLockIdentity(snapshot.info, pidLockIdentity(current))) return false;
  if (snapshot.owner?.token) {
    const currentOwner = readPidLockSnapshot(file)?.owner;
    if (currentOwner?.token !== snapshot.owner.token) return false;
  }
  try { rmSync(file); return true; } catch (error) { return error?.code === "ENOENT"; }
}

function pidLockIdentity(info, identity = filesystemIdentity(info, "managed-job lock")) {
  return {
    ...identity,
    size: exactFilesystemInteger(info.size, "managed-job lock size"),
    nlink: exactFilesystemInteger(info.nlink, "managed-job lock link count"),
    mtimeMs: filesystemTimeMs(info.mtimeMs, "managed-job lock modification time"),
  };
}

function samePidLockIdentity(left, right) {
  return sameFilesystemIdentity(left, right) && left.size === right.size && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs;
}

function replacePrivateTextFile(file, content) {
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
  ownerOnlyFile(file);
}
