import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { filesystemIdentity, filesystemTimeMs, sameFilesystemIdentity } from "../core/filesystem-identity.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance, processStartTimeFromSnapshot, createPidLockOwner, isValidPidLockOwner, inspectProcessInstanceAsync } from "./identity.mjs";
import { randomBytes } from "node:crypto";
import { createExclusiveFileSync, removeOwnedJsonFileSync, isPublicationStagingArtifactName, readWithPublicationRepairSync, sweepPublicationStagingArtifactsSync, verifyExclusiveFilePublicationResidueSync } from "../core/exclusive-file.mjs";
import { readBoundedRegularFileSync, retryTransientMultipleLinksSync } from "../core/secure-file.mjs";
import { normalizeResourceRequest, validateResourceRequest } from "./resource-metrics.mjs";
import { createMonotonicDeadline } from "../core/timing.mjs";
import { positiveInteger } from "../../shared/numbers.mjs";

const changeSignals = new WeakMap();

export function resourceSleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error("resource admission cancelled"));
    };
    timer = setTimeout(() => { cleanup(); resolvePromise(); }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function resourceChangeSignal(owner) {
  let controller = changeSignals.get(owner);
  if (!controller || controller.signal.aborted) { controller = new AbortController(); changeSignals.set(owner, controller); }
  return controller.signal;
}

export function signalResourceChange(owner) {
  const previous = changeSignals.get(owner);
  changeSignals.set(owner, new AbortController());
  previous?.abort(new Error("resource capacity changed"));
}

export async function waitForResourceChange(changeSignal, ms, sleep = resourceSleep, signal) {
  const combined = signal ? AbortSignal.any([signal, changeSignal]) : changeSignal;
  try { await sleep(ms, combined); return false; }
  catch (error) { if (changeSignal.aborted && !signal?.aborted) return true; throw error; }
}

export function resourceRetryDelayMs({ attempt = 0, priority = "ordinary", reason = "", remainingMs = 0, random = Math.random } = {}) {
  const base = priority === "interactive" ? 100 : priority === "background" ? 500 : 200;
  const cap = priority === "interactive" ? 600 : priority === "background" ? 3_000 : 1_500;
  const step = Math.max(0, Math.min(4, Math.floor(Number(attempt) || 0)));
  let minimum = Math.min(cap, base * (2 ** step));
  if (reason === "host_pressure_red") minimum = Math.max(minimum, Math.min(cap, priority === "interactive" ? 300 : 600));
  else if (reason === "cpu_pressure_window") minimum = Math.max(minimum, Math.min(cap, priority === "interactive" ? 150 : 300));
  const maximum = Math.min(cap, Math.max(minimum, Math.floor(minimum * 1.5)));
  const unit = Math.max(0, Math.min(1, Number(random?.()) || 0));
  const delay = minimum + Math.floor((maximum - minimum) * unit);
  const remaining = Math.max(1, Math.floor(Number(remainingMs) || 1));
  return Math.max(1, Math.min(delay, remaining));
}
const STAGING = /^\.(?<target>(?<kind>lease|wait)_[a-f0-9]{32}\.json)\.(?<pid>[1-9][0-9]*)\.(?<nonce>[a-f0-9]{16})\.tmp$/;

const FINAL = Object.freeze({ lease: /^lease_[a-f0-9]{32}\.json$/, wait: /^wait_[a-f0-9]{32}\.json$/ });

export const RESOURCE_STAGING_BUSY_CODE = "MBM_RESOURCE_STAGING_BUSY";

/**
 * Desktop indexers and file browsers may place metadata in an owner-only state directory.
 * These names carry no runtime authority and must not turn every coordinator operation into
 * a permanent failure. Unknown names still fail closed in the enumeration paths below.
 */
export function isIgnorableCoordinatorMetadata(name) {
  return name === ".DS_Store" || name === "Icon\r" || name === "Thumbs.db" || name === "desktop.ini";
}

export function recoverResourceDirectoryStaging(dir, entries, kind, processStarts = null) {
  const expected = FINAL[kind];
  if (!expected) throw new Error("resource staging kind is invalid");
  let recovered = false;
  for (const entry of entries) {
    if (entry.isFile() && isIgnorableCoordinatorMetadata(entry.name)) continue;
    if (entry.isFile() && expected.test(entry.name)) continue;
    const match = entry.isFile() ? STAGING.exec(entry.name) : null;
    if (match?.groups?.kind === kind) {
      const publisherPid = Number(match.groups.pid);
      if (!Number.isSafeInteger(publisherPid) || publisherPid <= 0) {
        throw new Error("resource coordinator staging publisher PID is invalid; retaining state for inspection");
      }
      recoverStagingAlias(dir, entry.name, match.groups.target, publisherPid, processStarts);
      recovered = true;
      continue;
    }
    throw new Error(`resource coordinator ${kind} directory contains an unexpected entry`);
  }
  return recovered;
}

function recoverStagingAlias(dir, stagingName, targetName, publisherPid, processStarts) {
  const stagingPath = join(dir, stagingName);
  const targetPath = join(dir, targetName);
  const staging = inspect(stagingPath, "resource coordinator staging file");
  const target = inspectOptional(targetPath, "resource coordinator published file");
  if (target) {
    const sameObject = sameFilesystemIdentity(staging.identity, target.identity);
    if (sameObject) {
      if (staging.nlink !== 2n || target.nlink !== 2n) throw new Error("resource coordinator committed staging alias has unexpected links");
      verifyPair(stagingPath, targetPath, staging, target, true);
      unlinkSync(stagingPath);
      return;
    }
    if (stagingPublisherMayBeCurrent(publisherPid, staging, processStarts)) throw Object.assign(new Error("resource coordinator staging file is still owned by a live publisher"), { code: RESOURCE_STAGING_BUSY_CODE });
    if (staging.nlink !== 1n || target.nlink !== 1n) throw new Error("resource coordinator uncommitted replacement staging has unexpected links");
    verifyPair(stagingPath, targetPath, staging, target, false);
    unlinkSync(stagingPath);
    return;
  }
  if (stagingPublisherMayBeCurrent(publisherPid, staging, processStarts)) throw Object.assign(new Error("resource coordinator staging file is still owned by a live publisher"), { code: RESOURCE_STAGING_BUSY_CODE });
  if (staging.nlink !== 1n) throw new Error("resource coordinator uncommitted staging file has unexpected links");
  const current = inspect(stagingPath, "resource coordinator staging file");
  if (current.nlink !== 1n || !sameFilesystemIdentity(staging.identity, current.identity)) {
    throw new Error("resource coordinator staging file changed during recovery");
  }
  unlinkSync(stagingPath);
}

function verifyPair(stagingPath, targetPath, staging, target, requireSameObject) {
  const currentStaging = inspect(stagingPath, "resource coordinator staging file");
  const currentTarget = inspect(targetPath, "resource coordinator published file");
  if (currentStaging.nlink !== staging.nlink || currentTarget.nlink !== target.nlink
      || !sameFilesystemIdentity(staging.identity, currentStaging.identity)
      || !sameFilesystemIdentity(target.identity, currentTarget.identity)
      || (requireSameObject && !sameFilesystemIdentity(currentStaging.identity, currentTarget.identity))) {
    throw new Error("resource coordinator staging file changed during recovery");
  }
}

function inspect(file, label) {
  const info = lstatSync(file, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  return {
    nlink: info.nlink,
    identity: filesystemIdentity(info, label),
    modified_at: new Date(filesystemTimeMs(info.mtimeMs, `${label} modification time`)).toISOString(),
  };
}

function inspectOptional(file, label) {
  try { return inspect(file, label); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function stagingPublisherMayBeCurrent(pid, staging, processStarts = undefined) {
  const options = {
    getProcessStartTime: (value) => value === process.pid ? currentProcessStartTimeMs() : processStartTimeFromSnapshot(processStarts, value),
  };
  const status = inspectProcessInstance({ pid, startedAt: staging.modified_at }, options);
  return status.alive === true && status.reclaimable !== true;
}
const SCHEMA = 1;

const WAITER_FILE = /^wait_[a-f0-9]{32}\.json$/;

const MAX_WAITER_BYTES = 16 * 1024;

const WAITER_GRACE_MS = 5_000;

const AGING_MS = 120_000;

const LEASE_DRAIN_REASONS = new Set(["project_resource_busy", "cpu_reservation", "io_reservation", "memory_reservation", "disk_reserve_floor"]);

export function createResourceWaiter(waitersDir, request, waitMs, now = Date.now()) {
  const waiterId = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  const expiresAt = now + Math.max(5_000, Number(waitMs) || 0) + WAITER_GRACE_MS;
  const waiter = {
    schema_version: SCHEMA,
    waiter_id: waiterId,
    token,
    enqueued_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    owner: { pid: process.pid, process_started_at: new Date(currentProcessStartTimeMs()).toISOString() },
    request: normalizeResourceRequest(request),
  };
  createExclusiveFileSync(waiterPath(waitersDir, waiterId), `${JSON.stringify(waiter)}\n`, { mode: 0o600 });
  return waiter;
}

export function removeResourceWaiter(waitersDir, waiter) {
  if (!waiter?.waiter_id || !waiter?.token) return false;
  return removeOwnedJsonFileSync(waiterPath(waitersDir, waiter.waiter_id), {
    waiter_id: waiter.waiter_id, token: waiter.token,
  }, { maxBytes: MAX_WAITER_BYTES });
}

export function pruneAndReadResourceWaiters(waitersDir, entries, now = Date.now(), processStarts = null) {
  sweepPublicationStagingArtifactsSync(waitersDir, { minAgeMs: 60_000 });
  const waiters = [];
  for (const entry of entries) {
    if (entry.isFile() && isIgnorableCoordinatorMetadata(entry.name)) continue;
    if (entry.isFile() && isPublicationStagingArtifactName(entry.name)) continue;
    if (!entry.isFile() || !WAITER_FILE.test(entry.name)) throw new Error("resource coordinator waiter directory contains an unexpected entry");
    const file = join(waitersDir, entry.name);
    let waiter;
    try { waiter = readWaiter(file); }
    catch (error) { if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") continue; throw error; }
    validateWaiter(waiter);
    if (waiterIsStale(waiter, now, processStarts)) {
      if (!removeResourceWaiter(waitersDir, waiter)) throw new Error("resource waiter changed during stale pruning");
      continue;
    }
    waiters.push(waiter);
  }
  return waiters;
}

export function selectedResourceWaiter(waiters, leases, host, evaluate, now = Date.now()) { return resourceWaiterSelectionState(waiters, leases, host, evaluate, now).selected; }

export function resourceWaiterDrainActive(waiters, leases, host, evaluate, now = Date.now()) { return resourceWaiterSelectionState(waiters, leases, host, evaluate, now).drainActive; }

function resourceWaiterSelectionState(waiters, leases, host, evaluate, now) {
  const ranked = [...waiters].sort((left, right) => compareWaiters(left, right, now));
  const selected = ranked.find((waiter) => evaluate(host, leases, waiter.request, now, waiter).admitted) || null;
  const protectedWaiter = leases.length ? ranked.find((waiter) => {
    const current = evaluate(host, leases, waiter.request, now, waiter); const empty = evaluate(host, [], waiter.request, now, waiter);
    return resourceWaiterProtected(waiter, now) && LEASE_DRAIN_REASONS.has(current.reason) && (empty.admitted || empty.reason === "cpu_pressure_window");
  }) : null;
  const drainActive = Boolean(protectedWaiter && (!selected || compareWaiters(protectedWaiter, selected, now) <= 0));
  return { selected: drainActive ? null : selected, drainActive };
}

export function resourceWaiterRank(waiter, now = Date.now()) {
  const base = waiterBaseRank(waiter);
  const enqueued = Date.parse(String(waiter?.enqueued_at || ""));
  const ageBoost = Number.isFinite(enqueued) ? Math.floor(Math.max(0, now - enqueued) / AGING_MS) : 0;
  return Math.max(0, base - ageBoost);
}

export function resourceWaiterProtected(waiter, now = Date.now()) {
  const enqueued = Date.parse(String(waiter?.enqueued_at || ""));
  if (!Number.isFinite(enqueued) || resourceWaiterRank(waiter, now) !== 0) return false;
  const protectionAge = Math.max(AGING_MS, waiterBaseRank(waiter) * AGING_MS);
  return Math.max(0, now - enqueued) >= protectionAge;
}

export function resourceWaiterQueueSnapshot(waiters, now = Date.now()) {
  const byPriority = { interactive: 0, ordinary: 0, background: 0 };
  let oldest = null;
  for (const waiter of waiters || []) {
    const priority = ["interactive", "ordinary", "background"].includes(waiter?.request?.priority) ? waiter.request.priority : "ordinary";
    byPriority[priority] += 1;
    const enqueued = Date.parse(String(waiter?.enqueued_at || ""));
    if (Number.isFinite(enqueued) && (oldest === null || enqueued < oldest)) oldest = enqueued;
  }
  return {
    active: (waiters || []).length,
    by_priority: byPriority,
    protected: (waiters || []).filter((waiter) => resourceWaiterProtected(waiter, now)).length,
    oldest_ms: oldest === null ? 0 : Math.max(0, now - oldest),
  };
}

function waiterBaseRank(waiter) {
  return waiter?.request?.priority === "interactive" ? 0 : waiter?.request?.priority === "ordinary" ? 1 : 2;
}

function compareWaiters(left, right, now) {
  const rank = resourceWaiterRank(left, now) - resourceWaiterRank(right, now);
  if (rank) return rank;
  const time = Date.parse(left.enqueued_at) - Date.parse(right.enqueued_at);
  return time || String(left.waiter_id).localeCompare(String(right.waiter_id));
}

function waiterIsStale(waiter, now, processStarts) {
  if (Date.parse(waiter.expires_at) < now) return true;
  const status = inspectProcessInstance({ pid: waiter.owner.pid, startedAt: waiter.enqueued_at,
    processStartedAt: waiter.owner.process_started_at }, {
    getProcessStartTime: (pid) => pid === process.pid ? currentProcessStartTimeMs() : processStartTimeFromSnapshot(processStarts, pid),
  });
  return status.reclaimable === true;
}

function validateWaiter(waiter) {
  if (waiter?.schema_version !== SCHEMA || typeof waiter.waiter_id !== "string" || !/^[a-f0-9]{32}$/.test(waiter.waiter_id)
      || typeof waiter.token !== "string" || !/^[a-f0-9]{64}$/.test(waiter.token)) throw new Error("resource coordinator waiter is invalid");
  if (typeof waiter.enqueued_at !== "string" || !Number.isFinite(Date.parse(waiter.enqueued_at))
      || typeof waiter.expires_at !== "string" || !Number.isFinite(Date.parse(waiter.expires_at))
      || !Number.isSafeInteger(waiter.owner?.pid) || waiter.owner.pid <= 0 || typeof waiter.owner?.process_started_at !== "string"
      || !Number.isFinite(Date.parse(waiter.owner.process_started_at))) throw new Error("resource coordinator waiter ownership is invalid");
  validateResourceRequest(waiter.request);
}

function readWaiter(file) {
  const read = () => readBoundedRegularFileSync(file, MAX_WAITER_BYTES, "resource waiter", { verifyPathIdentity: true, rejectMultipleLinks: true });
  const value = JSON.parse(readWithPublicationRepairSync(read, file).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("resource coordinator waiter is invalid");
  return value;
}

function waiterPath(waitersDir, id) {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new Error("invalid resource waiter id");
  return join(waitersDir, `wait_${id}.json`);
}
export function resourceWaiterDiagnosticSnapshot(waiters = [], leases = [], host = {}, evaluate, now = Date.now()) {
  return {
    ...resourceWaiterQueueSnapshot(waiters, now),
    drain_active: resourceWaiterDrainActive(waiters, leases, host, evaluate, now),
    diagnostics: resourceWaiterDiagnostics(waiters, leases, host, evaluate, now),
  };
}

export function resourceWaiterDiagnostics(waiters = [], leases = [], host = {}, evaluate, now = Date.now(), maximum = 4) {
  if (typeof evaluate !== "function") return [];
  return [...waiters]
    .sort((left, right) => Date.parse(String(left?.enqueued_at || "")) - Date.parse(String(right?.enqueued_at || "")))
    .slice(0, Math.max(0, Math.min(8, Number(maximum) || 0)))
    .map((waiter) => waiterDiagnostic(waiter, leases, host, evaluate, now));
}

function waiterDiagnostic(waiter, leases, host, evaluate, now) {
  const request = waiter?.request || {};
  const enqueuedMs = Date.parse(String(waiter?.enqueued_at || ""));
  const expiresMs = Date.parse(String(waiter?.expires_at || ""));
  const current = safeDecision(evaluate, host, leases, request, now, waiter);
  const withoutLeases = safeDecision(evaluate, host, [], request, now, waiter);
  return {
    age_ms: Number.isFinite(enqueuedMs) ? Math.max(0, now - enqueuedMs) : 0,
    expires_in_ms: Number.isFinite(expiresMs) ? Math.max(0, expiresMs - now) : 0,
    priority: token(request.priority), family: token(request.family), resource_class: token(request.resource_class),
    cpu: number(request.cpu), io: number(request.io), memory_mb: number(request.memory_mb),
    heavy: request.heavy === true, unbounded: request.unbounded === true,
    compiler_jobs: Number.isSafeInteger(request.compiler_jobs) ? request.compiler_jobs : null,
    serialize_project: request.serialize_project === true, protected: resourceWaiterProtected(waiter, now),
    admitted_now: current.admitted === true, admission_reason: token(current.reason),
    would_admit_without_leases: withoutLeases.admitted === true,
  };
}

function safeDecision(evaluate, host, leases, request, now, waiter) {
  try { return evaluate(host, leases, request, now, waiter) || {}; } catch { return { admitted: false, reason: "diagnostic_unavailable" }; }
}

function token(value) { return String(value || "unknown").replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 80) || "unknown"; }

function number(value) { const result = Number(value); return Number.isFinite(result) && result >= 0 ? result : 0; }
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
  const owner = createPidLockOwner({ purpose: LOCK_PURPOSE, nowMs: now(), startedAtMs: currentProcessStartTimeMs() });

  while (true) {
    const acquired = tryAcquireFileLock(lockPath, owner);
    if (acquired) return runWithFileLock(lockPath, owner.token, callback);
    const observed = await inspectExistingLock(lockPath);
    if (observed.kind === "missing") {
      if (deadline.expired()) throw transactionBusyError();
      continue;
    }
    if (observed.reclaimable && typeof options.beforeReclaim === "function") await options.beforeReclaim(observed);
    if (observed.reclaimable && reclaimObservedLock(lockPath, observed)) continue;
    if (deadline.expired()) throw transactionBusyError();
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
  if (info.isFile()) {
    try { return await inspectFileLock(lockPath); }
    catch (error) {
      // A live owner may release after lstat. Retry exclusive acquisition; a
      // missing observation never authorizes reclaiming another owner's lock.
      if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return { kind: "missing", reclaimable: false };
      throw error;
    }
  }
  throw new Error("resource coordinator transaction lock has an unsupported filesystem type");
}

async function inspectFileLock(lockPath) {
  const snapshot = readJson(lockPath, MAX_OWNER_BYTES, "resource transaction owner-state lock");
  const owner = snapshot.value;
  if (!validFileOwner(owner)) throw new Error("resource coordinator owner-state lock is invalid");
  const status = await inspectProcessInstanceAsync(owner);
  return { kind: "file", owner, reclaimable: status.reclaimable === true, residueIdentity: snapshot.residueIdentity };
}

function reclaimObservedLock(lockPath, observed) {
  return removeOwnedJsonFileSync(lockPath, { token: observed.owner.token, purpose: LOCK_PURPOSE }, {
    maxBytes: MAX_OWNER_BYTES,
    allowedMultipleLinkIdentity: observed.residueIdentity,
  });
}

function validFileOwner(owner) {
  return isValidPidLockOwner(owner, { purpose: LOCK_PURPOSE });
}

function readJson(file, maxBytes, label) {
  let residueIdentity = null;
  const read = (verifiedResidueIdentity) => {
    residueIdentity = verifiedResidueIdentity;
    return readBoundedRegularFileSync(file, maxBytes, label, {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
      allowedMultipleLinkIdentity: verifiedResidueIdentity,
    });
  };
  const attempt = () => retryTransientMultipleLinksSync(read, { verifyResidue: () => verifyExclusiveFilePublicationResidueSync(file) });
  const bytes = readWithPublicationRepairSync(attempt, file);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must contain a JSON object`);
  return { value, residueIdentity };
}

function defaultSleep(milliseconds) { return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); }); }

function transactionBusyError() {
  return Object.assign(new Error("resource coordinator transaction state is busy; retry after the current operation finishes"), { code: "MBM_RESOURCE_TRANSACTION_BUSY" });
}
