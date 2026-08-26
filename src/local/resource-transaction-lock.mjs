import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { createExclusiveFileSync, removeOwnedJsonFileSync } from "./exclusive-file.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { currentProcessStartTimeMs, inspectProcessInstanceAsync } from "./process-identity.mjs";
import { readBoundedRegularFileSync, retryTransientMultipleLinksSync } from "./secure-file.mjs";

const LOCK_NAME = "transaction.lock";
const LOCK_PURPOSE = "resource-coordinator";
const LOCK_WAIT_MS = 5_000;
const MAX_OWNER_BYTES = 8 * 1024;

export async function withResourceTransactionLock(root, callback, options = {}) {
  if (typeof callback !== "function") throw new TypeError("resource transaction lock requires a callback");
  const lockPath = join(root, LOCK_NAME);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const deadline = createMonotonicDeadline(positiveInteger(options.timeoutMs, LOCK_WAIT_MS));
  const owner = fileOwner(now());

  while (true) {
    const acquired = tryAcquireFileLock(lockPath, owner);
    if (acquired) return runWithFileLock(lockPath, owner.token, callback);
    const observed = await inspectExistingLock(lockPath);
    if (observed.kind === "missing") continue;
    if (observed.reclaimable && typeof options.beforeReclaim === "function") await options.beforeReclaim(observed);
    if (observed.reclaimable && reclaimObservedLock(lockPath, observed)) continue;
    if (deadline.expired()) throw Object.assign(new Error("resource coordinator transaction state is busy; retry after the current operation finishes"), { code: "MBM_RESOURCE_TRANSACTION_BUSY" });
    await sleep(Math.min(25 + Math.floor(random() * 50), Math.max(1, deadline.remainingMs())));
  }
}

function tryAcquireFileLock(lockPath, owner) {
  try { createExclusiveFileSync(lockPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 }); }
  catch (error) { if (error?.code === "EEXIST") return false; throw error; }
  return true;
}

async function runWithFileLock(lockPath, token, callback) {
  let result;
  let callbackError = null;
  try { result = await callback(); } catch (error) { callbackError = error; }
  let releaseError = null;
  try {
    if (!removeOwnedJsonFileSync(lockPath, { token, purpose: LOCK_PURPOSE }, { maxBytes: MAX_OWNER_BYTES })) {
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

async function inspectExistingLock(lockPath) {
  let info;
  try { info = lstatSync(lockPath, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return { kind: "missing", reclaimable: false }; throw error; }
  if (info.isSymbolicLink()) throw new Error("resource coordinator transaction lock must not be a symbolic link");
  if (info.isDirectory()) {
    throw new Error("resource coordinator transaction lock uses an unsupported legacy directory format; preserve the state and upgrade through a supported transition");
  }
  if (info.isFile()) return inspectFileLock(lockPath);
  throw new Error("resource coordinator transaction lock has an unsupported filesystem type");
}

async function inspectFileLock(lockPath) {
  const owner = readJson(lockPath, MAX_OWNER_BYTES, "resource transaction owner-state lock");
  if (!validFileOwner(owner)) throw new Error("resource coordinator owner-state lock is invalid");
  const status = await inspectProcessInstanceAsync(owner);
  return { kind: "file", owner, reclaimable: status.reclaimable === true };
}

function reclaimObservedLock(lockPath, observed) {
  return removeOwnedJsonFileSync(lockPath, { token: observed.owner.token, purpose: LOCK_PURPOSE }, { maxBytes: MAX_OWNER_BYTES });
}

function fileOwner(now) {
  return { token: randomBytes(16).toString("hex"), pid: process.pid, purpose: LOCK_PURPOSE,
    startedAt: new Date(now).toISOString(), processStartedAt: new Date(currentProcessStartTimeMs()).toISOString() };
}

function validFileOwner(owner) {
  return Number.isInteger(owner?.pid) && owner.pid > 0
    && owner.purpose === LOCK_PURPOSE
    && Number.isFinite(Date.parse(String(owner.startedAt || "")))
    && Number.isFinite(Date.parse(String(owner.processStartedAt || "")))
    && /^[a-f0-9]{32}$/.test(String(owner.token || ""));
}

function readJson(file, maxBytes, label) {
  const text = retryTransientMultipleLinksSync(() => readBoundedRegularFileSync(file, maxBytes, label, {
    verifyPathIdentity: true, rejectMultipleLinks: true,
  })).toString("utf8");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must contain a JSON object`);
  return value;
}

function positiveInteger(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback; }
function defaultSleep(milliseconds) { return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); }); }
