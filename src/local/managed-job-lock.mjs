import { randomBytes } from "node:crypto";
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance, processStartTimeMs } from "./process-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { ownerOnlyFile } from "./state.mjs";

export function acquireRecoveryLock(dir) {
  return acquirePidLock(join(dir, "recovery.lock"), { allowHandoff: true });
}

export function acquireJobTransitionLock(dir) {
  return acquirePidLock(join(dir, "transition.lock"));
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
  let info;
  try { info = lstatSync(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("job lock must be a regular non-symbolic-link file");
  let owner = null;
  try {
    const parsed = JSON.parse(readBoundedRegularFileSync(file, 1024).toString("utf8").trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) owner = parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
  }
  return { owner, info: pidLockIdentity(info) };
}

function removePidLockOwnedBy(file, token) {
  const snapshot = readPidLockSnapshot(file);
  if (!snapshot || snapshot.owner?.token !== token) return false;
  return removePidLockSnapshot(file, snapshot);
}

function removePidLockSnapshot(file, snapshot) {
  let current;
  try { current = lstatSync(file); } catch (error) { return error?.code === "ENOENT"; }
  if (current.isSymbolicLink() || !current.isFile()) return false;
  if (!samePidLockIdentity(snapshot.info, pidLockIdentity(current))) return false;
  if (snapshot.owner?.token) {
    const currentOwner = readPidLockSnapshot(file)?.owner;
    if (currentOwner?.token !== snapshot.owner.token) return false;
  }
  try { rmSync(file); return true; } catch (error) { return error?.code === "ENOENT"; }
}

function pidLockIdentity(info) {
  return { dev: Number(info.dev), ino: Number(info.ino), size: Number(info.size), mtimeMs: Number(info.mtimeMs) };
}

function samePidLockIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function replacePrivateTextFile(file, content) {
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
  ownerOnlyFile(file);
}
