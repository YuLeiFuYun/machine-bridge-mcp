import { randomBytes } from "node:crypto";
import path from "node:path";
import { createExclusiveFileSync, removeOwnedJsonFileSync } from "./exclusive-file.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance } from "./process-identity.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "./secure-file.mjs";

const MAX_LOCK_BYTES = 8 * 1024;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_POLL_MS = 25;

export async function withOwnerStateLock(root, callback, options = {}) {
  if (typeof callback !== "function") throw new TypeError("owner-state lock requires a callback");
  const requestedRoot = String(root || "").trim();
  if (!requestedRoot) throw new Error("owner-state lock root is missing");
  const purpose = boundedIdentifier(options.purpose, "state");
  const fileName = boundedFileName(options.fileName, `${purpose}.lock`);
  const label = String(options.label || purpose).replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) || purpose;
  const directory = path.resolve(requestedRoot);
  ensureOwnerOnlyDirectorySync(directory);
  const lockPath = path.join(directory, fileName);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_WAIT_MS);
  const pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS);
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Math.max(1, Number(options.maxAgeMs)) : Number.POSITIVE_INFINITY;
  const deadline = createMonotonicDeadline(timeoutMs);
  const owner = lockOwner(purpose);

  while (true) {
    try {
      createExclusiveFileSync(lockPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const inspected = readLockOwner(lockPath, purpose);
      if (inspected.kind === "missing") continue;
      if (inspected.kind === "invalid") {
        throw new Error(`${label} lock is malformed; inspect the owner-only state directory`);
      }
      const existing = inspected.owner;
      const identity = inspectProcessInstance(existing, { maxAgeMs });
      if (identity.reclaimable) {
        if (removeOwnedJsonFileSync(lockPath, { token: existing.token, purpose }, { maxBytes: MAX_LOCK_BYTES })) continue;
      }
      if (deadline.expired()) {
        const pid = Number.isInteger(existing.pid) ? `pid ${existing.pid}` : "unknown process";
        throw new Error(`${label} state is busy (${pid}); retry after the current operation finishes`);
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
  const released = removeOwnedJsonFileSync(lockPath, { token: owner.token, purpose }, { maxBytes: MAX_LOCK_BYTES });
  if (!released) throw new Error(`${label} lock changed before release; state may require inspection`);
  if (callbackError) throw callbackError;
  return result;
}

function lockOwner(purpose) {
  return {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    purpose,
    startedAt: new Date().toISOString(),
    processStartedAt: new Date(currentProcessStartTimeMs()).toISOString(),
    entryScript: String(process.argv[1] || "").slice(0, 4096),
  };
}

function readLockOwner(file, purpose) {
  let parsed;
  try {
    parsed = JSON.parse(readBoundedRegularFileSync(file, MAX_LOCK_BYTES, "owner-state lock").toString("utf8"));
  } catch (error) {
    return error?.code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "invalid" };
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return { kind: "invalid" };
  if (!/^[a-f0-9]{32}$/.test(String(parsed.token || ""))) return { kind: "invalid" };
  if (parsed.purpose !== purpose) return { kind: "invalid" };
  if (!Number.isFinite(Date.parse(String(parsed.startedAt || "")))) return { kind: "invalid" };
  if (!Number.isFinite(Date.parse(String(parsed.processStartedAt || "")))) return { kind: "invalid" };
  return { kind: "owner", owner: parsed };
}

function boundedIdentifier(value, fallback) {
  const text = String(value || fallback).toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64);
  return text || fallback;
}

function boundedFileName(value, fallback) {
  const name = path.basename(String(value || fallback));
  if (!/^[a-z0-9][a-z0-9._-]{0,95}\.lock$/.test(name)) throw new Error("owner-state lock filename is invalid");
  return name;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
}
