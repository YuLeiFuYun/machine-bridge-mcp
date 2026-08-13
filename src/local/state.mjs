import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { preserveFileSnapshotSync } from "./file-snapshot-preservation.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { createDeviceIdentity } from "./device-identity.mjs";
import { validateDeviceRootIdentity } from "./device-root-provider.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance } from "./process-identity.mjs";
import { ensureOwnerOnlyDir, inspectPathIfPresentSync, ownerOnlyFile, readBoundedRegularFileSync, readBoundedRegularFileWithInfoSync, retryTransientMultipleLinksSync, unlinkRegularFileIfIdentitySync } from "./secure-file.mjs";
import { isPlainRecord } from "./records.mjs";
import { exactFilesystemInteger, filesystemIdentity, filesystemTimeMs, sameFilesystemIdentity } from "./filesystem-identity.mjs";
import { appName, packageRoot } from "./package-identity.mjs";
import { inspectStateRootGeneration, pruneRetiredStateRootDirectories, removeStateRootGenerationIfCurrent } from "./state-root-retirement.mjs";
import { validateOwnedStateNamespaces } from "./state-root-owned-namespaces.mjs";

const STATE_MARKER = ".machine-bridge-mcp-state";
const STATE_MARKER_SCHEMA = 2;
export const STATE_SCHEMA_VERSION = 6;
const GLOBAL_CONFIG_SCHEMA = 1;
const RECOVERY_MARKER_SCHEMA = 1;
const CORRUPT_RECOVERY = Symbol("corrupt-recovery");
const MAX_STATE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_MARKER_BYTES = 4096;
const STARTUP_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MALFORMED_LOCK_GRACE_MS = 60_000;
const MAINTENANCE_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MACHINE_SERVICE_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function expandHome(input = "") {
  if (!input || input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function expandHomeFrom(input, home) {
  if (!input || input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

export function resolveWorkspace(input = process.cwd()) {
  const resolved = path.resolve(expandHome(input));
  return realpathSync.native ? realpathSync.native(resolved) : realpathSync(resolved);
}

export function defaultFirstRunWorkspace({ platform = process.platform, home = os.homedir(), cwd = process.cwd() } = {}) {
  return path.resolve(platform === "win32" ? path.join(home, "MachineBridge") : cwd);
}

export function ensureWorkspaceDirectory(input) {
  const requested = path.resolve(expandHome(input));
  mkdirSync(requested, { recursive: true });
  return resolveWorkspace(requested);
}

export function defaultStateRoot(options = {}) {
  const platform = String(options.platform || process.platform);
  const home = path.resolve(String(options.home || os.homedir()));
  const environment = options.environment && typeof options.environment === "object" ? options.environment : process.env;
  if (platform === "win32") {
    const base = environment.APPDATA ? expandHomeFrom(String(environment.APPDATA), home) : path.join(home, "AppData", "Roaming");
    return path.join(base, appName);
  }
  if (environment.XDG_STATE_HOME) return path.join(expandHomeFrom(String(environment.XDG_STATE_HOME), home), appName);
  return path.join(home, ".local", "state", appName);
}


function configPath(stateRoot = defaultStateRoot()) {
  return path.join(expandHome(stateRoot), "config.json");
}

export function loadGlobalConfig(stateRoot = defaultStateRoot(), options = {}) {
  const root = path.resolve(expandHome(stateRoot));
  assertNoForeignMaintenance(root);
  const file = configPath(root);
  const inspect = options.inspectPathIfPresentSync || inspectPathIfPresentSync;
  const info = inspect(file, "global configuration file");
  if (!info) return { schemaVersion: GLOBAL_CONFIG_SCHEMA };
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("global configuration file must be a regular file and not a symbolic link");
  ownerOnlyFile(file);
  const config = readJsonObjectOrBackup(file, { allowEmptyRecovery: true });
  if (config[CORRUPT_RECOVERY]) return { schemaVersion: GLOBAL_CONFIG_SCHEMA };
  if (config.schemaVersion !== GLOBAL_CONFIG_SCHEMA) {
    throw new Error("global configuration schema is obsolete; remove the state root and initialize the current version");
  }
  return config;
}

export function saveGlobalConfig(config, stateRoot = defaultStateRoot()) {
  const requestedRoot = path.resolve(expandHome(stateRoot));
  assertNoForeignMaintenance(requestedRoot);
  const root = ensureStateRoot(requestedRoot);
  assertNoForeignMaintenance(root);
  const file = configPath(root);
  atomicWriteJson(file, { ...config, schemaVersion: GLOBAL_CONFIG_SCHEMA, updatedAt: new Date().toISOString() });
}

export function setSelectedWorkspace(workspace, stateRoot = defaultStateRoot()) {
  const root = expandHome(stateRoot);
  const canonicalWorkspace = resolveWorkspace(workspace);
  const config = loadGlobalConfig(root);
  config.selectedWorkspace = canonicalWorkspace;
  config.selectedWorkspaceHash = workspaceHash(canonicalWorkspace);
  saveGlobalConfig(config, root);
  return config;
}

export function selectedWorkspace(stateRoot = defaultStateRoot()) {
  const value = loadGlobalConfig(stateRoot).selectedWorkspace;
  return typeof value === "string" && value.trim() ? value : "";
}

export function validateStateRootForRemoval(stateRoot = defaultStateRoot()) {
  const root = path.resolve(expandHome(stateRoot));
  if (!inspectPathIfPresentSync(root, "state root")) return { exists: false, root };
  const canonical = assertSafeStateRootForRemoval(root);
  return { exists: true, root: canonical };
}

export function removeStateRoot(stateRoot = defaultStateRoot()) {
  const requested = path.resolve(expandHome(stateRoot));
  pruneRetiredStateRootDirectories(requested, assertSafeStateRootForRemoval);
  const validation = validateStateRootForRemoval(requested);
  if (!validation.exists) return false;
  const generation = inspectStateRootGeneration(validation.root);
  if (removeStateRootGenerationIfCurrent(validation.root, generation, assertSafeStateRootForRemoval)) return true;
  pruneRetiredStateRootDirectories(requested, assertSafeStateRootForRemoval);
  if (!inspectPathIfPresentSync(validation.root, "state root")) return false;
  throw new Error("state root changed during generation-bound removal; state requires inspection");
}

function workspaceHash(workspace) {
  const canonical = resolveWorkspace(workspace);
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

function profileDirForWorkspace(workspace, stateRoot = defaultStateRoot()) {
  return path.join(expandHome(stateRoot), "profiles", workspaceHash(workspace));
}



function canonicalizePotentialPath(input) {
  let existing = path.resolve(input);
  const suffix = [];
  while (!inspectPathIfPresentSync(existing, "path identity")) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalExisting = realpathSync.native ? realpathSync.native(existing) : realpathSync(existing);
  return path.join(canonicalExisting, ...suffix);
}

function assertStateRootSeparatedFromWorkspace(stateRoot, workspace) {
  const canonicalStateRoot = canonicalizePotentialPath(stateRoot);
  const stateIdentity = process.platform === "win32" ? canonicalStateRoot.toLowerCase() : canonicalStateRoot;
  const workspaceIdentity = process.platform === "win32" ? workspace.toLowerCase() : workspace;
  const relativeWorkspace = path.relative(canonicalStateRoot, workspace);
  const relativeState = path.relative(workspace, canonicalStateRoot);
  const contains = (value) => value === "" || (!value.startsWith(`..${path.sep}`) && value !== ".." && !path.isAbsolute(value));
  if (stateIdentity === workspaceIdentity || contains(relativeWorkspace) || contains(relativeState)) {
    throw new Error("state root and selected workspace must be separate, non-overlapping directories");
  }
}

function samePotentialPathIdentity(left, right) {
  try {
    const a = canonicalizePotentialPath(String(left));
    const b = canonicalizePotentialPath(String(right));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

function sameWorkspaceIdentity(left, right) {
  try {
    const a = resolveWorkspace(left);
    const b = resolveWorkspace(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

export function loadState(workspace, options = {}) {
  const canonicalWorkspace = resolveWorkspace(workspace);
  const requestedStateRoot = path.resolve(options.stateDir ? expandHome(options.stateDir) : defaultStateRoot());
  assertStateRootSeparatedFromWorkspace(requestedStateRoot, canonicalWorkspace);
  assertNoForeignMaintenance(requestedStateRoot);
  const stateRoot = ensureStateRoot(requestedStateRoot);
  assertNoForeignMaintenance(stateRoot);
  const profileDir = profileDirForWorkspace(canonicalWorkspace, stateRoot);
  const statePath = path.join(profileDir, "state.json");
  ensureOwnerOnlyDir(profileDir);
  removeObsoleteOperationLeaseState(profileDir);
  const recoveryPath = recoveryMarkerPath(statePath);
  const recoveryPending = Boolean(inspectPathIfPresentSync(recoveryPath, "state recovery marker"));
  const recoverySnapshot = recoveryPending ? readRecoveryMarker(recoveryPath, statePath) : null;
  const recoveryMarker = recoverySnapshot?.marker || null;
  let state = {};
  if (inspectPathIfPresentSync(statePath, "workspace state")) {
    ownerOnlyFile(statePath);
    state = readJsonObjectOrBackup(statePath, { recoveryPath });
    if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
      throw new Error("workspace state schema is obsolete; remove the state root and initialize the current version");
    }
    assertWorkspaceStateEnvelope(state, { canonicalWorkspace, stateRoot, profileDir, statePath });
    if (recoverySnapshot && !unlinkRegularFileIfIdentitySync(recoveryPath, recoverySnapshot.identity, "state recovery marker")) {
      throw new Error("workspace state recovery marker changed before removal");
    }
  } else if (recoveryPending) {
    throw recoveryRequiredError(recoveryMarker);
  }
  state.schemaVersion = STATE_SCHEMA_VERSION;
  state.workspace = {
    path: canonicalWorkspace,
    hash: path.basename(profileDir),
    updatedAt: new Date().toISOString(),
  };
  state.paths = { stateRoot, profileDir, statePath };
  state.worker ||= {};
  delete state.worker.accountAdminSecret;
  state.policy ||= {};
  state.resources ||= {};
  return state;
}

function removeObsoleteOperationLeaseState(profileDir) {
  const file = path.join(profileDir, "operation-leases.json");
  const info = inspectPathIfPresentSync(file, "obsolete operation lease state", {
    lstatSync: (target) => lstatSync(target, { bigint: true }),
  });
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
    throw new Error("obsolete operation lease state must be a single-link regular file before migration cleanup");
  }
  const identity = filesystemIdentity(info, "obsolete operation lease state");
  if (!unlinkRegularFileIfIdentitySync(file, identity, "obsolete operation lease state")) {
    throw new Error("obsolete operation lease state changed before migration cleanup");
  }
  return true;
}

export function saveState(state) {
  const envelope = assertWorkspaceStateEnvelope(state);
  assertNoForeignMaintenance(envelope.stateRoot);
  assertValidStateMarker(path.join(envelope.stateRoot, STATE_MARKER));
  ensureOwnerOnlyDir(envelope.profileDir);
  atomicWriteJson(envelope.statePath, { ...state });
  const recoveryPath = recoveryMarkerPath(envelope.statePath);
  if (inspectPathIfPresentSync(recoveryPath, "state recovery marker")) {
    const recoverySnapshot = readRecoveryMarker(recoveryPath, envelope.statePath);
    if (!unlinkRegularFileIfIdentitySync(recoveryPath, recoverySnapshot.identity, "state recovery marker")) {
      throw new Error("workspace state recovery marker changed before removal");
    }
  }
}

function assertWorkspaceStateEnvelope(state, expected = {}) {
  if (!isPlainRecord(state) || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error("workspace state envelope is incomplete or uses the wrong schema");
  }
  if (!isPlainRecord(state.workspace) || typeof state.workspace.path !== "string" || typeof state.workspace.hash !== "string") {
    throw new Error("workspace state envelope is missing workspace identity");
  }
  if (!isPlainRecord(state.paths) || !isPlainRecord(state.worker) || !isPlainRecord(state.policy) || !isPlainRecord(state.resources)) {
    throw new Error("workspace state envelope is missing required object fields");
  }
  const canonicalWorkspace = resolveWorkspace(expected.canonicalWorkspace || state.workspace.path);
  const expectedHash = workspaceHash(canonicalWorkspace);
  if (!sameWorkspaceIdentity(state.workspace.path, canonicalWorkspace) || state.workspace.hash !== expectedHash) {
    throw new Error("workspace state envelope does not match the selected workspace");
  }
  if (typeof state.paths.stateRoot !== "string" || !state.paths.stateRoot
      || typeof state.paths.profileDir !== "string" || !state.paths.profileDir
      || typeof state.paths.statePath !== "string" || !state.paths.statePath) {
    throw new Error("workspace state envelope is missing canonical state paths");
  }
  const stateRoot = canonicalizePotentialPath(expected.stateRoot || state.paths.stateRoot);
  const profileDir = canonicalizePotentialPath(expected.profileDir || state.paths.profileDir);
  const statePath = canonicalizePotentialPath(expected.statePath || state.paths.statePath);
  const expectedProfileDir = canonicalizePotentialPath(profileDirForWorkspace(canonicalWorkspace, stateRoot));
  const expectedStatePath = canonicalizePotentialPath(path.join(expectedProfileDir, "state.json"));
  if (!samePotentialPathIdentity(profileDir, expectedProfileDir) || !samePotentialPathIdentity(statePath, expectedStatePath)) {
    throw new Error("workspace state envelope contains inconsistent state paths");
  }
  if (!samePotentialPathIdentity(state.paths.stateRoot, stateRoot)
      || !samePotentialPathIdentity(state.paths.profileDir, profileDir)
      || !samePotentialPathIdentity(state.paths.statePath, statePath)) {
    throw new Error("workspace state envelope does not match the active state location");
  }
  assertStateRootSeparatedFromWorkspace(stateRoot, canonicalWorkspace);
  return { canonicalWorkspace, stateRoot, profileDir, statePath };
}

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

function assertNoForeignMaintenance(stateRoot) {
  if (!stateRoot) return;
  const file = path.join(path.resolve(expandHome(stateRoot)), "maintenance.lock");
  const snapshot = readProcessLockSnapshot(file);
  if (!snapshot) return;
  if (!snapshot.owner) {
    const ageMs = Date.now() - snapshot.info.mtimeMs;
    if (ageMs < MALFORMED_LOCK_GRACE_MS) throw new Error("state maintenance lock is recent but unreadable");
    if (!removeLockSnapshot(file, snapshot)) {
      throw new Error("state maintenance lock changed during inspection; retry after checking the owning process");
    }
    return;
  }
  if (snapshot.owner.purpose !== "maintenance") throw new Error("state maintenance lock contains mismatched purpose metadata");
  const identity = inspectProcessInstance(snapshot.owner, { maxAgeMs: MAINTENANCE_LOCK_MAX_AGE_MS });
  if (identity.current) {
    if (Number(snapshot.owner.pid) === process.pid) return;
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
        const ageMs = Date.now() - snapshot.info.mtimeMs;
        if (ageMs < MALFORMED_LOCK_GRACE_MS) {
          return { acquired: false, path: lockPath, owner: null, reason: "recent_invalid_lock", release() {} };
        }
        if (!removeLockSnapshot(lockPath, snapshot)) continue;
        continue;
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
    opened = retryTransientMultipleLinksSync(() => readBoundedRegularFileWithInfoSync(lockPath, MAX_LOCK_BYTES, "process lock", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    }));
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
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) owner = parsed;
  } catch { /* Successfully read malformed JSON remains eligible for bounded stale recovery. */ }
  return { owner, info };
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

function boundedPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

function readBoundedUtf8(filePath, maxBytes, label, options = {}) {
  return decodeUtf8(readBoundedRegularFileSync(filePath, maxBytes, label, options), label);
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (cause) {
    throw Object.assign(new Error(`${label} is not valid UTF-8`, { cause }), { code: "ERR_INVALID_UTF8" });
  }
}

function readJsonObjectOrBackup(filePath, options = {}) {
  const opened = readBoundedRegularFileWithInfoSync(filePath, MAX_STATE_JSON_BYTES, "state JSON", {
    verifyPathIdentity: true, rejectMultipleLinks: true,
  });
  const text = decodeUtf8(opened.buffer, "state JSON");
  let parsed;
  try {
    parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON root must be an object");
    return parsed;
  } catch {
    const backupPath = `${filePath}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
    preserveFileSnapshotSync(filePath, backupPath, opened.buffer, opened.identity, { label: "state JSON", mode: 0o600 });
    ownerOnlyFile(backupPath);
    pruneBackups(filePath, 3);
    if (options.allowEmptyRecovery === true) {
      const recovered = {};
      Object.defineProperty(recovered, CORRUPT_RECOVERY, { value: true });
      return recovered;
    }
    const recoveryPath = options.recoveryPath || recoveryMarkerPath(filePath);
    const marker = { schemaVersion: RECOVERY_MARKER_SCHEMA, backup: path.basename(backupPath), detectedAt: new Date().toISOString() };
    replaceFileAtomicallySync(recoveryPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    ownerOnlyFile(recoveryPath);
    throw recoveryRequiredError(marker);
  }
}

function recoveryMarkerPath(statePath) { return `${statePath}.recovery-required`; }

function readRecoveryMarker(markerPath, statePath) {
  ownerOnlyFile(markerPath);
  let opened;
  let marker;
  try {
    opened = readBoundedRegularFileWithInfoSync(markerPath, MAX_MARKER_BYTES, "state recovery marker", {
      verifyPathIdentity: true, rejectMultipleLinks: true,
    });
    marker = JSON.parse(decodeUtf8(opened.buffer, "state recovery marker"));
  } catch { throw new Error("workspace state recovery marker is invalid; inspect the profile manually before continuing"); }
  if (marker?.schemaVersion !== RECOVERY_MARKER_SCHEMA || typeof marker.backup !== "string"
      || !marker.backup.startsWith(`${path.basename(statePath)}.corrupt-`) || path.basename(marker.backup) !== marker.backup
      || !Number.isFinite(Date.parse(String(marker.detectedAt || "")))) {
    throw new Error("workspace state recovery marker is invalid; inspect the profile manually before continuing");
  }
  return {
    marker: Object.freeze({ schemaVersion: marker.schemaVersion, backup: marker.backup, detectedAt: marker.detectedAt }),
    identity: opened.identity,
  };
}

function recoveryRequiredError(marker) {
  const backup = marker?.backup || "the bounded corrupt backup";
  const error = new Error(`workspace state recovery is required; invalid JSON was preserved as ${backup}. Restore a valid current-schema state.json or intentionally remove this profile before restarting`);
  error.code = "state_recovery_required";
  return error;
}

function ensureStateRoot(inputRoot) {
  const root = path.resolve(expandHome(inputRoot));
  if (existsSync(root)) {
    const info = lstatSync(root);
    if (info.isSymbolicLink()) throw new Error(`state root must not be a symbolic link: ${root}`);
    if (!info.isDirectory()) throw new Error(`state root is not a directory: ${root}`);
  } else {
    ensureOwnerOnlyDir(root);
  }
  const marker = path.join(root, STATE_MARKER);
  if (!existsSync(marker)) {
    const entries = readdirSync(root);
    if (entries.length) throw new Error(`state root must be empty before initializing the current schema: ${root}`);
    createExclusiveFileSync(marker, `${JSON.stringify({ app: appName, schema: STATE_MARKER_SCHEMA })}\n`, { mode: 0o600 });
  }
  assertValidStateMarker(marker);
  ensureOwnerOnlyDir(root);
  ownerOnlyFile(marker);
  cleanupStaleAtomicTemps(root);
  return realpathSync(root);
}

function assertSafeStateRootForRemoval(root) {
  const info = lstatSync(root);
  if (info.isSymbolicLink()) throw new Error(`refusing to remove symbolic-link state root: ${root}`);
  const canonical = realpathSync(root);
  const forbidden = new Set([
    path.parse(canonical).root,
    path.resolve(os.homedir()),
    path.resolve(process.cwd()),
    path.resolve(packageRoot),
  ]);
  if (forbidden.has(canonical)) throw new Error(`refusing to remove unsafe state root: ${canonical}`);
  if (currentEntrypointInsideStateRoot(canonical)) {
    throw new Error("refusing to remove a state root that contains the currently executing Machine Bridge CLI; run uninstall from an installation outside that state root");
  }
  if (looksLikeSourceTree(canonical) || stateRootMatchesRecordedWorkspace(canonical)) {
    throw new Error(`refusing to remove state root that appears to be a workspace: ${canonical}`);
  }
  const entries = readdirSync(canonical);
  if (!hasOnlyStateEntries(entries)) {
    throw new Error(`refusing to remove state root containing unrelated entries: ${canonical}`);
  }
  validateOwnedStateNamespaces(canonical);
  const marker = path.join(canonical, STATE_MARKER);
  if (existsSync(marker)) {
    assertValidStateMarker(marker);
    return canonical;
  }
  throw new Error(`refusing to remove unrecognized state root without ${STATE_MARKER}: ${canonical}`);
}

function assertValidStateMarker(marker) {
  const content = readBoundedUtf8(marker, MAX_MARKER_BYTES, "state marker", { verifyPathIdentity: true, rejectMultipleLinks: true });
  let value;
  try { value = JSON.parse(content); } catch { throw new Error(`invalid state root marker: ${marker}`); }
  if (value?.app !== appName || value?.schema !== STATE_MARKER_SCHEMA) {
    throw new Error("state root schema is obsolete; remove it and initialize the current version");
  }
}

function hasOnlyStateEntries(entries) {
  const allowed = new Set([STATE_MARKER, "config.json", "browser-bridge.json", "maintenance.lock", "profiles", "logs", "service-environment.json", "service-launcher.cmd", "toolchains", "release-channels", "release-tasks"]);
  return entries.every((entry) => allowed.has(entry) || /^config\.json\.corrupt-\d+(?:-[a-f0-9]{8})?$/.test(entry));
}

function currentEntrypointInsideStateRoot(root) {
  const entry = String(process.argv[1] || "").trim();
  if (!entry) return false;
  let resolved;
  try { resolved = canonicalizePotentialPath(entry); } catch { resolved = path.resolve(entry); }
  const relative = path.relative(root, resolved);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function looksLikeSourceTree(root) {
  return [".git", ".hg", ".svn", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"].some((name) => existsSync(path.join(root, name)));
}

function stateRootMatchesRecordedWorkspace(root) {
  const config = readOptionalRemovalJson(path.join(root, "config.json"), "state-root config");
  if (typeof config?.selectedWorkspace === "string" && sameWorkspaceIdentity(config.selectedWorkspace, root)) return true;

  const profiles = path.join(root, "profiles");
  const profilesInfo = inspectPathIfPresentSync(profiles, "state-root profiles");
  if (!profilesInfo) return false;
  if (profilesInfo.isSymbolicLink() || !profilesInfo.isDirectory()) {
    throw new Error("state-root profiles must be a real directory before removal");
  }
  const entries = readdirSync(profiles, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileDir = path.join(profiles, entry.name);
    const state = readOptionalRemovalJson(path.join(profileDir, "state.json"), "profile state");
    if (typeof state?.workspace?.path === "string" && sameWorkspaceIdentity(state.workspace.path, root)) return true;
    const owner = readOptionalRemovalJson(path.join(profileDir, "daemon.lock"), "daemon lock");
    if (typeof owner?.workspace === "string" && sameWorkspaceIdentity(owner.workspace, root)) return true;
  }
  return false;
}

function readOptionalRemovalJson(file, label) {
  let text;
  try {
    text = readBoundedUtf8(file, MAX_STATE_JSON_BYTES, label, { verifyPathIdentity: true, rejectMultipleLinks: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return null;
    throw new Error(`${label} could not be verified before state removal`, { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON; refusing state removal`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object; refusing state removal`);
  }
  return value;
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  ensureOwnerOnlyDir(dir);
  cleanupStaleAtomicTemps(dir, path.basename(filePath));
  const serialized = `${JSON.stringify(value, null, 2)}
`;
  if (Buffer.byteLength(serialized) > MAX_STATE_JSON_BYTES) throw new Error(`state JSON exceeds ${MAX_STATE_JSON_BYTES} bytes`);
  replaceFileAtomicallySync(filePath, serialized, { mode: 0o600 });
}

function cleanupStaleAtomicTemps(dir, baseName = "") {
  const now = Date.now();
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!/^\..+\.\d+\.[a-f0-9]+\.tmp$/.test(name)) continue;
    if (baseName && !name.startsWith(`.${baseName}.`)) continue;
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > 60 * 60 * 1000) unlinkSync(file);
    } catch { /* Stale-temp cleanup is opportunistic and must not block the authoritative state write. */ }
  }
}

function pruneBackups(filePath, keep) {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.corrupt-`;
  let backups = [];
  try {
    backups = readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .map(name => ({ path: path.join(dir, name), mtime: statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return;
  }
  for (const backup of backups.slice(keep)) {
    try { unlinkSync(backup.path); }
    catch { /* Backup pruning is bounded housekeeping; retained backups are safer than failing state recovery. */ }
  }
}

export function ensureWorkerSecrets(state, options = {}) {
  state.worker ||= {};
  delete state.worker.accountAdminSecret;
  const enrollingDeviceIdentity = !state.worker.deviceIdentity;
  if (enrollingDeviceIdentity || (options.rotateSecrets && !options.deferDeviceRotation)) state.worker.deviceIdentity = createDeviceIdentity();
  else validateDeviceRootIdentity(state.worker.deviceIdentity);
  if (state.worker.pendingDeviceIdentity) validateDeviceRootIdentity(state.worker.pendingDeviceIdentity);
  delete state.worker.daemonSecret;
  if (!state.worker.oauthTokenVersion || enrollingDeviceIdentity || options.rotateSecrets) {
    state.worker.oauthTokenVersion = randomToken("token_version");
  }

  const requestedName = options.workerName || "";
  if (!state.worker.name) {
    state.worker.name = requestedName || defaultWorkerName(state.workspace.hash);
    return;
  }
  if (!requestedName || requestedName === state.worker.name) return;
  if (!options.allowWorkerRename) {
    throw new Error(`this workspace already uses Worker ${state.worker.name}; changing --worker-name to ${requestedName} would create another Worker. Re-run with --force-worker only when that replacement is intentional`);
  }

  const previous = String(state.worker.name);
  const previousNames = Array.isArray(state.worker.previousNames) ? state.worker.previousNames : [];
  state.worker.previousNames = [...new Set([...previousNames, previous])].slice(-32);
  state.worker.name = requestedName;
  delete state.worker.url;
  delete state.worker.mcpServerUrl;
  delete state.worker.deployHash;
  delete state.worker.deployedVersion;
  delete state.worker.updatedAt;
}

export function deploymentDeviceIdentity(state) {
  const identity = state?.worker?.pendingDeviceIdentity || state?.worker?.deviceIdentity;
  return validateDeviceRootIdentity(identity);
}

export function promotePendingDeviceIdentity(state) {
  const pending = state?.worker?.pendingDeviceIdentity;
  if (!pending) return false;
  validateDeviceRootIdentity(pending);
  const current = state.worker.deviceIdentity;
  if (current) {
    const previous = Array.isArray(state.worker.previousDeviceIdentities) ? state.worker.previousDeviceIdentities : [];
    state.worker.previousDeviceIdentities = [...previous, publicDeviceRootRecord(current)].slice(-2);
  }
  state.worker.deviceIdentity = pending;
  delete state.worker.pendingDeviceIdentity;
  return true;
}

function publicDeviceRootRecord(identity) {
  validateDeviceRootIdentity(identity);
  return {
    scheme: identity.scheme,
    provider: identity.provider || "portable-jwk-v1",
    brokerProtocol: identity.brokerProtocol || undefined,
    brokerPath: identity.brokerPath || undefined,
    brokerIdentifier: identity.brokerIdentifier || undefined,
    brokerTeamIdentifier: identity.brokerTeamIdentifier || undefined,
    keyTag: identity.keyTag || undefined,
    publicJwk: identity.publicJwk,
    keyId: identity.keyId,
    createdAt: identity.createdAt,
    retiredAt: new Date().toISOString(),
  };
}

function defaultWorkerName(hash) {
  return `mbm-${String(hash || "default").slice(0, 12)}`;
}

function randomToken(prefix) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function redactState(state) {
  const clone = redactHomeInValue(JSON.parse(JSON.stringify(state)));
  if (clone.worker?.deviceIdentity?.privateJwk?.d) clone.worker.deviceIdentity.privateJwk.d = "<redacted>";
  redactBrokerPaths(clone.worker);
  if (clone.worker?.oauthTokenVersion) clone.worker.oauthTokenVersion = "<redacted>";
  if (clone.resources && typeof clone.resources === "object") {
    for (const value of Object.values(clone.resources)) {
      if (!value || typeof value !== "object") continue;
      if (value.path) value.path = "<local-resource-path>";
      delete value.pathAliases;
    }
  }
  return clone;
}


function redactBrokerPaths(worker) {
  if (!worker || typeof worker !== "object") return;
  for (const identity of [
    worker.deviceIdentity,
    worker.pendingDeviceIdentity,
    ...(Array.isArray(worker.previousDeviceIdentities) ? worker.previousDeviceIdentities : []),
  ]) {
    if (identity?.brokerPath) identity.brokerPath = "<local-broker-path>";
  }
}

function redactHomeInValue(value) {
  const home = os.homedir();
  if (typeof value === "string") {
    const insideHome = home && (value === home || value.startsWith(`${home}${path.sep}`));
    return insideHome ? `~${value.slice(home.length)}` : value;
  }
  if (Array.isArray(value)) return value.map(redactHomeInValue);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = redactHomeInValue(value[key]);
  }
  return value;
}
