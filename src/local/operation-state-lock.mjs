import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createExclusiveFileSync, removeOwnedJsonFileSync } from "./exclusive-file.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance } from "./process-identity.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "./secure-file.mjs";

const LOCK_PURPOSE = "operation-authorization";
const LOCK_FILE = "operation-authorization.lock";
const MAX_LOCK_BYTES = 8 * 1024;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_POLL_MS = 25;

export async function withOperationStateLock(root, callback, options = {}) {
  if (typeof callback !== "function") throw new TypeError("operation-state lock requires a callback");
  const requestedRoot = String(root || "").trim();
  if (!requestedRoot) throw new Error("operation-state lock root is missing");
  const directory = path.resolve(requestedRoot);
  ensureOwnerOnlyDirectorySync(directory);
  const lockPath = path.join(directory, LOCK_FILE);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_WAIT_MS);
  const pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS);
  const deadline = createMonotonicDeadline(timeoutMs);
  const owner = lockOwner();

  while (true) {
    try {
      createExclusiveFileSync(lockPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readLockOwner(lockPath);
      if (!existing) throw new Error("operation authorization lock is malformed; inspect the owner-only state directory");
      if (existing.purpose !== LOCK_PURPOSE) throw new Error("operation authorization lock contains mismatched purpose metadata");
      const identity = inspectProcessInstance(existing, { maxAgeMs: Number.POSITIVE_INFINITY });
      if (identity.reclaimable) {
        if (removeOwnedJsonFileSync(lockPath, { token: existing.token, purpose: LOCK_PURPOSE }, { maxBytes: MAX_LOCK_BYTES })) continue;
      }
      if (deadline.expired()) {
        const pid = Number.isInteger(existing.pid) ? `pid ${existing.pid}` : "unknown process";
        throw new Error(`operation authorization state is busy (${pid}); retry after the current approval operation finishes`);
      }
      await delay(Math.min(pollMs, Math.max(1, deadline.remainingMs())));
    }
  }

  let result;
  let callbackError;
  try {
    result = await callback();
  } catch (error) {
    callbackError = error;
  }
  const released = removeOwnedJsonFileSync(lockPath, { token: owner.token, purpose: LOCK_PURPOSE }, { maxBytes: MAX_LOCK_BYTES });
  if (!released) throw new Error("operation authorization lock changed before release; approval state may require inspection");
  if (callbackError) throw callbackError;
  return result;
}

function lockOwner() {
  return {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    purpose: LOCK_PURPOSE,
    startedAt: new Date().toISOString(),
    processStartedAt: new Date(currentProcessStartTimeMs()).toISOString(),
    entryScript: String(process.argv[1] || "").slice(0, 4096),
  };
}

function readLockOwner(file) {
  if (!existsSync(file)) return null;
  let parsed;
  try { parsed = JSON.parse(readBoundedRegularFileSync(file, MAX_LOCK_BYTES, "operation authorization lock").toString("utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  if (!/^[a-f0-9]{32}$/.test(String(parsed.token || ""))) return null;
  if (parsed.purpose !== LOCK_PURPOSE) return null;
  if (!Number.isFinite(Date.parse(String(parsed.startedAt || "")))) return null;
  if (!Number.isFinite(Date.parse(String(parsed.processStartedAt || "")))) return null;
  return parsed;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
}
