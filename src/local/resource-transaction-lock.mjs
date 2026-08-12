import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { removeOwnedJsonFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { filesystemIdentity, filesystemTimeMs } from "./filesystem-identity.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance } from "./process-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { recoverResourceTransactionOwnerStaging } from "./resource-staging-recovery.mjs";
const LOCK_NAME = "transaction.lock";
const OWNER_NAME = "owner.json";
const LOCK_PURPOSE = "resource-coordinator";
const LOCK_WAIT_MS = 5_000;
const INCOMPLETE_OWNER_GRACE_MS = 5_000;
const MAX_OWNER_BYTES = 8 * 1024;
// Keep the schema-1 directory wire shape while beta.60 can still be the live daemon.
// The directory mkdir is the cross-version transition mutex; owner.json is atomically
// materialized immediately afterwards and incomplete claims are only reclaimable after
// the bounded incomplete-owner grace.
export async function withResourceTransactionLock(root, callback, options = {}) {
  if (typeof callback !== "function") throw new TypeError("resource transaction lock requires a callback");
  const lockPath = join(root, LOCK_NAME);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const deadline = createMonotonicDeadline(positiveInteger(options.timeoutMs, LOCK_WAIT_MS));
  const owner = directoryOwner(now());

  while (true) {
    const acquired = tryAcquireDirectoryLock(lockPath, owner);
    if (acquired) return runWithDirectoryLock(lockPath, acquired, owner.token, callback);
    const observed = inspectExistingLock(lockPath, now());
    if (observed.kind === "missing") continue;
    if (observed.reclaimable && typeof options.beforeReclaim === "function") await options.beforeReclaim(observed);
    if (observed.reclaimable && reclaimObservedLock(lockPath, observed, options)) continue;
    if (deadline.expired()) throw Object.assign(new Error("resource coordinator transaction state is busy; retry after the current operation finishes"), { code: "MBM_RESOURCE_TRANSACTION_BUSY" });
    await sleep(Math.min(25 + Math.floor(random() * 50), Math.max(1, deadline.remainingMs())));
  }
}

function tryAcquireDirectoryLock(lockPath, owner) {
  try { mkdirSync(lockPath, { mode: 0o700 }); }
  catch (error) { if (error?.code === "EEXIST") return null; throw error; }
  const identity = directoryIdentity(lstatDirectory(lockPath));
  try {
    replaceFileAtomicallySync(join(lockPath, OWNER_NAME), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    return identity;
  } catch (error) {
    let cleanupError = null;
    try { removeDirectoryGeneration(lockPath, identity, null, "failed acquisition"); } catch (failure) { cleanupError = failure; }
    if (cleanupError) throw new AggregateError([error, cleanupError], "resource transaction acquisition failed and cleanup was incomplete");
    throw error;
  }
}

async function runWithDirectoryLock(lockPath, identity, token, callback) {
  let result;
  let callbackError = null;
  try { result = await callback(); } catch (error) { callbackError = error; }
  let releaseError = null;
  try {
    if (!removeDirectoryGeneration(lockPath, identity, token, "release")) {
      releaseError = new Error("resource coordinator transaction lock changed before release; state may require inspection");
    }
  } catch (error) {
    releaseError = new Error("resource coordinator transaction lock release failed; state may require inspection", { cause: error });
  }
  if (callbackError && releaseError) throw new AggregateError([callbackError, releaseError], "resource transaction failed and lock release was incomplete");
  if (releaseError) throw releaseError;
  if (callbackError) throw callbackError;
  return result;
}

function inspectExistingLock(lockPath, now) {
  let info;
  try { info = lstatSync(lockPath, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return { kind: "missing", reclaimable: false }; throw error; }
  if (info.isSymbolicLink()) throw new Error("resource coordinator transaction lock must not be a symbolic link");
  if (info.isDirectory()) return inspectDirectoryLock(lockPath, info, now);
  if (info.isFile()) return inspectPriorFileLock(lockPath);
  throw new Error("resource coordinator transaction lock has an unsupported filesystem type");
}

function inspectDirectoryLock(lockPath, info, now) {
  const identity = directoryIdentity(info);
  let owner;
  try { owner = readJson(join(lockPath, OWNER_NAME), MAX_OWNER_BYTES, "resource transaction owner"); }
  catch (error) {
    if (!isMissing(error)) throw error;
    const age = now - filesystemTimeMs(info.mtimeMs, "resource transaction lock modification time");
    return { kind: "directory", identity, owner: null, reclaimable: age >= INCOMPLETE_OWNER_GRACE_MS };
  }
  if (!validDirectoryOwner(owner)) throw new Error("resource coordinator transaction owner is invalid");
  const status = inspectProcessInstance({ pid: owner.pid, startedAt: owner.started_at, processStartedAt: owner.process_started_at });
  return { kind: "directory", identity, owner, reclaimable: status.reclaimable === true };
}

function inspectPriorFileLock(lockPath) {
  const owner = readJson(lockPath, MAX_OWNER_BYTES, "resource transaction owner-state lock");
  if (!validPriorFileOwner(owner)) throw new Error("resource coordinator prior owner-state lock is invalid");
  const status = inspectProcessInstance(owner);
  return { kind: "file", owner, reclaimable: status.reclaimable === true };
}

function reclaimObservedLock(lockPath, observed, options = {}) {
  if (observed.kind === "file") {
    return removeOwnedJsonFileSync(lockPath, { token: observed.owner.token, purpose: LOCK_PURPOSE }, { maxBytes: MAX_OWNER_BYTES });
  }
  return removeDirectoryGeneration(lockPath, observed.identity, observed.owner?.token ?? null, "stale recovery", {
    expectedOwnerMissing: observed.owner === null,
    beforeRestore: options.beforeRestore,
  });
}

function removeDirectoryGeneration(lockPath, expectedIdentity, expectedToken, reason, { expectedOwnerMissing = false, beforeRestore = null } = {}) {
  if (expectedOwnerMissing) {
    let current; try { current = lstatDirectory(lockPath); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    if (!sameDirectoryIdentity(expectedIdentity, directoryIdentity(current))) return false;
    try { readJson(join(lockPath, OWNER_NAME), MAX_OWNER_BYTES, "resource transaction owner"); return false; }
    catch (error) { if (!isMissing(error)) throw error; }
    if (!recoverResourceTransactionOwnerStaging(lockPath)) return false;
    try { rmdirSync(lockPath); return true; }
    catch (error) { if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) return false; throw error; }
  }
  const quarantine = `${lockPath}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
  try { renameSync(lockPath, quarantine); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  let verified = false;
  try {
    const movedInfo = lstatDirectory(quarantine);
    if (!sameDirectoryIdentity(expectedIdentity, directoryIdentity(movedInfo))) throw new Error(`resource transaction directory changed during ${reason}`);
    if (expectedToken !== null) {
      const movedOwner = readJson(join(quarantine, OWNER_NAME), MAX_OWNER_BYTES, "resource transaction owner");
      if (!validDirectoryOwner(movedOwner) || movedOwner.token !== expectedToken) throw new Error(`resource transaction owner changed during ${reason}`);
    }
    verified = true;
  } finally { if (!verified) restoreQuarantine(lockPath, quarantine, beforeRestore); }
  rmSync(quarantine, { recursive: true, force: false });
  return true;
}
function restoreQuarantine(lockPath, quarantine, beforeRestore = null) {
  if (typeof beforeRestore === "function") beforeRestore({ lockPath, quarantine });
  try { lstatSync(lockPath); throw new Error("resource transaction lock was replaced before quarantine restore; state requires inspection"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  try { renameSync(quarantine, lockPath); }
  catch (error) { throw new Error("resource transaction quarantine could not be restored; state requires inspection", { cause: error }); }
}
function directoryOwner(now) {
  return { schema_version: 1, token: randomBytes(16).toString("hex"), pid: process.pid,
    started_at: new Date(now).toISOString(), process_started_at: new Date(currentProcessStartTimeMs()).toISOString() };
}

function validDirectoryOwner(owner) {
  return Number.isInteger(owner?.pid) && owner.pid > 0
    && Number.isFinite(Date.parse(String(owner.started_at || "")))
    && Number.isFinite(Date.parse(String(owner.process_started_at || "")))
    && /^[a-f0-9]{32}$/.test(String(owner.token || ""));
}

function validPriorFileOwner(owner) {
  return Number.isInteger(owner?.pid) && owner.pid > 0
    && owner.purpose === LOCK_PURPOSE
    && Number.isFinite(Date.parse(String(owner.startedAt || "")))
    && Number.isFinite(Date.parse(String(owner.processStartedAt || "")))
    && /^[a-f0-9]{32}$/.test(String(owner.token || ""));
}

function readJson(file, maxBytes, label) {
  const text = readBoundedRegularFileSync(file, maxBytes, label, { verifyPathIdentity: true, rejectMultipleLinks: true }).toString("utf8");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must contain a JSON object`);
  return value;
}

function lstatDirectory(path) {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("resource coordinator transaction lock must be a real directory");
  return info;
}

function directoryIdentity(info) {
  const identity = filesystemIdentity(info, "resource transaction directory");
  return { dev: identity.dev, ino: identity.ino };
}
function sameDirectoryIdentity(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }
function isMissing(error) { return error?.code === "ENOENT" || error?.cause?.code === "ENOENT"; }
function positiveInteger(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback; }
function defaultSleep(milliseconds) { return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); }); }
