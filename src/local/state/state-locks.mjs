import { randomBytes } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";
import { isPlainRecord } from "../../shared/records.mjs";
import { createExclusiveFileSync, replaceFileAtomicallySync, verifyExclusiveFilePublicationResidueSync, removeOwnedJsonFileSync, readWithPublicationRepairSync } from "../core/exclusive-file.mjs";
import { exactFilesystemInteger, filesystemIdentity, filesystemTimeMs, sameFilesystemIdentity } from "../core/filesystem-identity.mjs";
import { createMonotonicDeadline, appName } from "../core/timing.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance, createPidLockOwner, isValidPidLockOwner, inspectProcessInstanceAsync } from "../process/identity.mjs";
import { retryProcessLockIdentityReadSync } from "../process/settlement.mjs";
import { ensureOwnerOnlyDir, inspectPathIfPresentSync, ownerOnlyFile, readBoundedRegularFileWithInfoSync, retryTransientMultipleLinksSync, ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "../core/secure-file.mjs";
import { MAX_LOCK_BYTES, boundedPositiveInteger, sameWorkspaceIdentity } from "./state-storage.mjs";
import { expandHome, expandHomeFrom } from "../files/workspace-paths.mjs";
import { positiveInteger } from "../../shared/numbers.mjs";

const STARTUP_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const MAINTENANCE_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const MACHINE_SERVICE_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function daemonLockPathForState(state) {
  return lockPathForState(state, "daemon.lock");
}

function startupLockPathForState(state) {
  return lockPathForState(state, "startup.lock");
}

function lockPathForState(state, name) {
  const profileDir = state?.paths?.profileDir;
  if (!profileDir) throw new Error("state profile dir is missing");
  return path.join(profileDir, name);
}

export function machineServiceControlRoot(options = {}) {
  const home = path.resolve(String(options.home || os.homedir()));
  if (options.controlRoot) return path.resolve(expandHomeFrom(String(options.controlRoot), home));
  if (String(options.platform || process.platform) === "win32") {
    const environment = options.environment && typeof options.environment === "object" ? options.environment : process.env;
    const base = environment.APPDATA ? expandHomeFrom(String(environment.APPDATA), home) : path.join(home, "AppData", "Roaming");
    return path.join(base, `${appName}-control`);
  }
  return path.join(home, ".local", "state", `${appName}-control`);
}

export function machineServiceLockPath(options = {}) {
  return path.join(machineServiceControlRoot(options), "service-operation.lock");
}

export function acquireMachineServiceLock(metadata = {}, options = {}) {
  const root = machineServiceControlRoot(options);
  ensureOwnerOnlyDir(root);
  assertNoForeignMaintenance(root);
  const operation = typeof metadata.operation === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(metadata.operation)
    ? metadata.operation
    : "service-operation";
  return acquireProcessLock(machineServiceLockPath({ controlRoot: root }), {
    workspace: { path: "" },
    paths: { profileDir: root, stateRoot: root },
  }, "machine-service", { operation }, { maxAgeMs: MACHINE_SERVICE_LOCK_MAX_AGE_MS });
}

export async function acquireMachineServiceLockWithWait(options = {}) {
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, 30_000);
  const pollMs = boundedPositiveInteger(options.pollMs, 100);
  const logger = options.logger || { info() {} };
  const metadata = { operation: options.operation };
  let lock = acquireMachineServiceLock(metadata, options);
  if (lock.acquired) return lock;
  logger.info?.("waiting for another process to finish the current machine-service operation");
  const deadline = createMonotonicDeadline(timeoutMs);
  while (!deadline.expired()) {
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, Math.min(pollMs, Math.max(1, deadline.remainingMs()))); });
    lock = acquireMachineServiceLock(metadata, options);
    if (lock.acquired) {
      logger.info?.("the previous machine-service operation finished; continuing");
      return lock;
    }
  }
  const pid = lock.owner?.pid ? `pid ${lock.owner.pid}` : "unknown pid";
  const operation = typeof lock.owner?.operation === "string" ? ` (${lock.owner.operation})` : "";
  throw new Error(`another machine-service operation did not finish within ${Math.ceil(timeoutMs / 1000)} seconds (${pid}${operation}); inspect the process before retrying`);
}

export function acquireMaintenanceLock(stateRoot, metadata = {}) {
  const root = path.resolve(expandHome(stateRoot));
  if (!inspectPathIfPresentSync(root, "state root")) throw new Error("cannot acquire maintenance lock for a missing state root");
  const operation = typeof metadata.operation === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(metadata.operation)
    ? metadata.operation
    : "maintenance";
  return acquireProcessLock(path.join(root, "maintenance.lock"), {
    workspace: { path: "" },
    paths: { profileDir: root, stateRoot: root },
  }, "maintenance", { operation }, { maxAgeMs: MAINTENANCE_LOCK_MAX_AGE_MS });
}

export function assertStateMaintenanceAvailable(stateRoot) {
  assertNoForeignMaintenance(stateRoot);
}

export function assertNoForeignMaintenance(stateRoot) {
  if (!stateRoot) return;
  const file = path.join(path.resolve(expandHome(stateRoot)), "maintenance.lock");
  const snapshot = readProcessLockSnapshot(file);
  if (!snapshot) return;
  if (!snapshot.owner) {
    throw new Error("state maintenance lock is malformed; inspect the owner-only state directory");
  }
  if (snapshot.owner.purpose !== "maintenance") throw new Error("state maintenance lock contains mismatched purpose metadata");
  const identity = inspectProcessInstance(snapshot.owner, { maxAgeMs: MAINTENANCE_LOCK_MAX_AGE_MS });
  if (identity.current) {
    if (snapshot.owner.pid === process.pid) return;
    throw new Error(`state maintenance is active in another process (pid ${snapshot.owner.pid})`);
  }
  if (!identity.reclaimable) throw new Error(`state maintenance lock cannot be verified safely (${identity.reason})`);
  if (!removeLockSnapshot(file, snapshot)) {
    throw new Error("state maintenance lock changed during inspection; retry after checking the owning process");
  }
}

export function acquireDaemonLock(state, metadata = {}) {
  assertNoForeignMaintenance(state?.paths?.stateRoot);
  const details = { startupReady: false, startupReadyAt: null, nodeVersion: process.versions.node };
  if (metadata?.mode === "foreground" || metadata?.mode === "service") details.mode = metadata.mode;
  if (typeof metadata?.version === "string" && /^[0-9A-Za-z.+_-]{1,64}$/.test(metadata.version)) details.version = metadata.version;
  return acquireProcessLock(daemonLockPathForState(state), state, "daemon", details, { maxAgeMs: Number.POSITIVE_INFINITY });
}

export function acquireStartupLock(state, metadata = {}) {
  assertNoForeignMaintenance(state?.paths?.stateRoot);
  const details = {};
  if (typeof metadata?.operation === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(metadata.operation)) details.operation = metadata.operation;
  return acquireProcessLock(startupLockPathForState(state), state, "startup", details, { maxAgeMs: STARTUP_LOCK_MAX_AGE_MS });
}

export async function acquireStartupLockWithWait(state, options = {}) {
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, 30_000);
  const pollMs = boundedPositiveInteger(options.pollMs, 100);
  const logger = options.logger || { info() {} };
  const metadata = { operation: options.operation };
  let lock = acquireStartupLock(state, metadata);
  if (lock.acquired) return lock;
  logger.info?.("waiting for another process to finish the current startup/state operation");
  const deadline = createMonotonicDeadline(timeoutMs);
  while (!deadline.expired()) {
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, Math.min(pollMs, Math.max(1, deadline.remainingMs()))); });
    lock = acquireStartupLock(state, metadata);
    if (lock.acquired) {
      logger.info?.("the previous startup/state operation finished; continuing");
      return lock;
    }
  }
  const pid = lock.owner?.pid ? `pid ${lock.owner.pid}` : "unknown pid";
  const operation = typeof lock.owner?.operation === "string" ? ` (${lock.owner.operation})` : "";
  throw new Error(`another startup/state operation did not finish within ${Math.ceil(timeoutMs / 1000)} seconds (${pid}${operation}); inspect the process before retrying`);
}

function acquireProcessLock(lockPath, state, purpose, details = {}, options = {}) {
  ensureOwnerOnlyDir(path.dirname(lockPath));
  const token = randomBytes(16).toString("hex");
  const payload = {
    pid: process.pid,
    token,
    purpose,
    workspace: state?.workspace?.path || "",
    startedAt: new Date().toISOString(),
    processStartedAt: new Date(currentProcessStartTimeMs()).toISOString(),
    entryScript: process.argv[1] || "",
    ...details,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      createExclusiveFileSync(lockPath, `${JSON.stringify(payload, null, 2)}
`, { mode: 0o600 });
      ownerOnlyFile(lockPath);
      const lock = {
        acquired: true,
        path: lockPath,
        owner: payload,
        update(patch) {
          lock.owner = updateProcessLock(lockPath, token, patch);
          return lock.owner;
        },
        release() { releaseProcessLock(lockPath, token); },
      };
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const snapshot = readProcessLockSnapshot(lockPath);
      if (!snapshot) continue;
      if (!snapshot.owner) {
        throw new Error(`${purpose} lock is malformed; inspect the owner-only state directory`);
      }
      if (snapshot.owner.purpose !== purpose) throw new Error(`${purpose} lock contains mismatched purpose metadata`);
      if (snapshot.owner.workspace && state?.workspace?.path && !sameWorkspaceIdentity(snapshot.owner.workspace, state.workspace.path)) {
        throw new Error(`${purpose} lock belongs to a different workspace`);
      }
      const identity = inspectProcessInstance(snapshot.owner, { maxAgeMs: options.maxAgeMs });
      if (identity.current || !identity.reclaimable) {
        return { acquired: false, path: lockPath, owner: snapshot.owner, reason: identity.reason, release() {} };
      }
      if (!removeLockSnapshot(lockPath, snapshot)) continue;
    }
  }
  const owner = readDaemonLockOwner(lockPath);
  return { acquired: false, path: lockPath, owner, release() {} };
}

function readProcessLockSnapshot(lockPath) {
  let opened;
  try {
    opened = retryProcessLockIdentityReadSync(() => retryTransientMultipleLinksSync((residueIdentity) => readBoundedRegularFileWithInfoSync(lockPath, MAX_LOCK_BYTES, "process lock", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
      allowedMultipleLinkIdentity: residueIdentity,
    }), { verifyResidue: () => verifyExclusiveFilePublicationResidueSync(lockPath) }));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return null;
    throw error;
  }
  const info = lockIdentity(opened.identityInfo, opened.identity);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(opened.buffer); }
  catch { return { owner: null, info }; }
  let owner = null;
  try {
    const parsed = JSON.parse(text);
    if (validProcessLockOwner(parsed)) owner = parsed;
  } catch { /* Successfully read malformed JSON is retained as invalid ownership evidence. */ }
  return { owner, info };
}

function validProcessLockOwner(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.token === "string" && /^[a-f0-9]{32}$/.test(value.token)
    && typeof value.purpose === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(value.purpose)
    && typeof value.workspace === "string"
    && typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt))
    && typeof value.processStartedAt === "string" && Number.isFinite(Date.parse(value.processStartedAt))
    && typeof value.entryScript === "string";
}

function removeLockSnapshot(lockPath, snapshot) {
  let current;
  try { current = lstatSync(lockPath, { bigint: true }); } catch (error) { return error?.code === "ENOENT"; }
  if (current.isSymbolicLink() || !current.isFile()) return false;
  if (!sameLockIdentity(snapshot.info, lockIdentity(current))) return false;
  if (snapshot.owner?.token) {
    const currentOwner = readDaemonLockOwner(lockPath);
    if (currentOwner?.token !== snapshot.owner.token) return false;
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function lockIdentity(info, identity = filesystemIdentity(info, "process lock")) {
  return {
    ...identity,
    size: exactFilesystemInteger(info.size, "process lock size"),
    nlink: exactFilesystemInteger(info.nlink, "process lock link count"),
    mtimeMs: filesystemTimeMs(info.mtimeMs, "process lock modification time"),
  };
}

function sameLockIdentity(left, right) {
  return sameFilesystemIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function updateProcessLock(lockPath, token, patch) {
  if (!isPlainRecord(patch)) throw new TypeError("process lock update must be a plain record");
  const allowed = new Set(["startupReady", "startupReadyAt"]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new Error(`process lock field is immutable: ${key}`);
  }
  if (patch.startupReady !== true) {
    throw new TypeError("process lock startup readiness can only be published as true");
  }
  if (typeof patch.startupReadyAt !== "string" || !Number.isFinite(Date.parse(patch.startupReadyAt))) {
    throw new TypeError("process lock startupReadyAt update must be an ISO timestamp");
  }
  const snapshot = readProcessLockSnapshot(lockPath);
  if (!snapshot?.owner || snapshot.owner.token !== token || snapshot.owner.pid !== process.pid) {
    throw new Error("process lock ownership changed before update");
  }
  if (snapshot.owner.purpose !== "daemon") {
    throw new Error("only daemon locks can publish startup readiness");
  }
  if (snapshot.owner.startupReady === true || snapshot.owner.startupReadyAt !== null) {
    throw new Error("process lock startup readiness was already published");
  }
  const updated = { ...snapshot.owner, startupReady: true, startupReadyAt: patch.startupReadyAt };
  const content = `${JSON.stringify(updated, null, 2)}
`;
  if (Buffer.byteLength(content) > MAX_LOCK_BYTES) throw new Error("process lock update exceeds the size limit");
  replaceFileAtomicallySync(lockPath, content, { mode: 0o600 });
  ownerOnlyFile(lockPath);
  return updated;
}

function releaseProcessLock(lockPath, token) {
  let snapshot;
  try { snapshot = readProcessLockSnapshot(lockPath); } catch { return; }
  if (!snapshot || snapshot.owner?.token !== token) return;
  removeLockSnapshot(lockPath, snapshot);
}

export function readDaemonLockOwner(lockPath) {
  return readProcessLockSnapshot(lockPath)?.owner || null;
}
const OWNER_LOCK_MAX_BYTES = 8 * 1024;

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
  const owner = createPidLockOwner({ purpose, startedAtMs: currentProcessStartTimeMs(), entryScript: true });

  while (true) {
    try {
      createExclusiveFileSync(lockPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const inspected = readWithPublicationRepairSync(() => retryTransientMultipleLinksSync((residueIdentity) => readOwnerStateLock(lockPath, purpose, residueIdentity), {
        verifyResidue: () => verifyExclusiveFilePublicationResidueSync(lockPath),
      }), lockPath);
      if (inspected.kind === "missing") continue;
      if (inspected.kind === "invalid") {
        throw new Error(`${label} lock is malformed; inspect the owner-only state directory`);
      }
      const existing = inspected.owner;
      const identity = await inspectProcessInstanceAsync(existing, { maxAgeMs });
      if (identity.reclaimable) {
        if (removeOwnedJsonFileSync(lockPath, { token: existing.token, purpose }, {
          maxBytes: OWNER_LOCK_MAX_BYTES,
          allowedMultipleLinkIdentity: inspected.residueIdentity,
        })) continue;
      }
      if (deadline.expired()) {
        const pid = Number.isInteger(existing.pid) ? `pid ${existing.pid}` : "unknown process";
        throw new Error(`${label} state is busy (${pid}); retry after the current operation finishes`);
      }
      await ownerLockDelay(Math.min(pollMs, Math.max(1, deadline.remainingMs())));
    }
  }

  let result;
  let callbackError;
  try {
    result = await callback();
  } catch (error) {
    callbackError = error;
  }
  let releaseError;
  try {
    const released = removeOwnedJsonFileSync(lockPath, { token: owner.token, purpose }, { maxBytes: OWNER_LOCK_MAX_BYTES });
    if (!released) releaseError = new Error(`${label} lock changed before release; state may require inspection`);
  } catch (error) {
    releaseError = new Error(`${label} lock release failed; state may require inspection`, { cause: error });
  }
  if (callbackError && releaseError) {
    throw new AggregateError([callbackError, releaseError], `${label} operation failed and lock release was incomplete`);
  }
  if (releaseError) throw releaseError;
  if (callbackError) throw callbackError;
  return result;
}

export function readOwnerStateLock(file, purpose, residueIdentity = null) {
  let text;
  try {
    text = readBoundedRegularFileSync(file, OWNER_LOCK_MAX_BYTES, "owner-state lock", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
      allowedMultipleLinkIdentity: residueIdentity,
    }).toString("utf8");
  }
  catch (error) { if (error?.code === "ENOENT") return { kind: "missing" }; throw error; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { kind: "invalid", residueIdentity }; }
  if (!isValidPidLockOwner(parsed, { purpose })) return { kind: "invalid", residueIdentity };
  return { kind: "owner", owner: parsed, residueIdentity };
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

function ownerLockDelay(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
}
export function activeOwnerStateLocks(stateRoot) {
  const toolchains = resolve(stateRoot, "toolchains");
  const directory = inspectPathIfPresentSync(toolchains, "toolchain state");
  if (!directory) return [];
  if (directory.isSymbolicLink() || !directory.isDirectory()) return [blocker("toolchain-state", null, "invalid_or_unreadable_state")];
  const lockPath = resolve(toolchains, "wrangler-toolchain.lock");
  if (!inspectPathIfPresentSync(lockPath, "Wrangler toolchain lock")) return [];
  let inspected;
  try { inspected = readOwnerStateLock(lockPath, "wrangler-toolchain"); }
  catch { return [blocker("toolchain", null, "invalid_or_unreadable_lock")]; }
  if (inspected.kind === "missing") return [];
  if (inspected.kind !== "owner") return [blocker("toolchain", null, "invalid_or_unreadable_lock")];
  const identity = inspectProcessInstance(inspected.owner);
  if (!identity.current && !(identity.alive && !identity.reclaimable)) return [];
  return [blocker("toolchain", inspected.owner.pid, identity.reason)];
}

function blocker(kind, pid, reason) { return { kind, pid: Number.isInteger(pid) ? pid : null, reason }; }
