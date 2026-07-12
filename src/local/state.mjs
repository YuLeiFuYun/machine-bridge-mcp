import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, chmodSync, realpathSync, rmSync, unlinkSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
import { replaceFileSync } from "./atomic-fs.mjs";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance } from "./process-identity.mjs";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const appName = String(serverMetadata.name);
const STATE_MARKER = ".machine-bridge-mcp-state";
const MAX_STATE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_MARKER_BYTES = 4096;
const STARTUP_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MALFORMED_LOCK_GRACE_MS = 60_000;
const MAINTENANCE_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function expandHome(input = "") {
  if (!input || input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolveWorkspace(input = process.cwd()) {
  const resolved = path.resolve(expandHome(input));
  return realpathSync.native ? realpathSync.native(resolved) : realpathSync(resolved);
}

export function defaultStateRoot() {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, appName);
  }
  if (process.env.XDG_STATE_HOME) return path.join(expandHome(process.env.XDG_STATE_HOME), appName);
  return path.join(os.homedir(), ".local", "state", appName);
}


function configPath(stateRoot = defaultStateRoot()) {
  return path.join(expandHome(stateRoot), "config.json");
}

export function loadGlobalConfig(stateRoot = defaultStateRoot()) {
  const root = path.resolve(expandHome(stateRoot));
  assertNoForeignMaintenance(root);
  const file = configPath(root);
  if (!existsSync(file)) return {};
  ownerOnlyFile(file);
  return readJsonObjectOrBackup(file);
}

export function saveGlobalConfig(config, stateRoot = defaultStateRoot()) {
  const requestedRoot = path.resolve(expandHome(stateRoot));
  assertNoForeignMaintenance(requestedRoot);
  const root = ensureStateRoot(requestedRoot);
  assertNoForeignMaintenance(root);
  const file = configPath(root);
  atomicWriteJson(file, { ...config, updatedAt: new Date().toISOString() });
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
  if (!existsSync(root)) return { exists: false, root };
  const canonical = assertSafeStateRootForRemoval(root);
  return { exists: true, root: canonical };
}

export function removeStateRoot(stateRoot = defaultStateRoot()) {
  const validation = validateStateRootForRemoval(stateRoot);
  if (!validation.exists) return false;
  rmSync(validation.root, { recursive: true, force: true });
  return true;
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
  while (!existsSync(existing)) {
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

function matchingLegacyProfileDir(canonicalWorkspace, stateRoot) {
  const profilesRoot = path.join(stateRoot, "profiles");
  if (!existsSync(profilesRoot)) return "";
  const matches = [];
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
    const profileDir = path.join(profilesRoot, entry.name);
    const stateFile = path.join(profileDir, "state.json");
    if (!existsSync(stateFile)) continue;
    try {
      const value = JSON.parse(readBoundedUtf8(stateFile, MAX_STATE_JSON_BYTES, "state JSON"));
      const storedWorkspace = value?.workspace?.path;
      if (typeof storedWorkspace !== "string") continue;
      if (sameWorkspaceIdentity(storedWorkspace, canonicalWorkspace)) matches.push(profileDir);
    } catch {}
  }
  if (matches.length > 1) throw new Error("multiple Machine Bridge profiles refer to the same canonical workspace; remove or merge the duplicate state profiles");
  return matches[0] || "";
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
  const canonicalProfileDir = profileDirForWorkspace(canonicalWorkspace, stateRoot);
  const profileDir = existsSync(canonicalProfileDir)
    ? canonicalProfileDir
    : matchingLegacyProfileDir(canonicalWorkspace, stateRoot) || canonicalProfileDir;
  const statePath = path.join(profileDir, "state.json");
  ensureOwnerOnlyDir(profileDir);
  let state = {};
  if (existsSync(statePath)) {
    ownerOnlyFile(statePath);
    state = readJsonObjectOrBackup(statePath);
  }
  state.schemaVersion = 5;
  state.workspace = {
    path: canonicalWorkspace,
    hash: path.basename(profileDir),
    updatedAt: new Date().toISOString(),
  };
  state.paths = { stateRoot, profileDir, statePath };
  state.worker ||= {};
  state.policy ||= {};
  state.resources ||= {};
  delete state.localApi;
  return state;
}

export function saveState(state) {
  assertNoForeignMaintenance(state?.paths?.stateRoot);
  const statePath = state?.paths?.statePath;
  if (!statePath) throw new Error("state path is missing");
  ensureOwnerOnlyDir(path.dirname(statePath));
  atomicWriteJson(statePath, { ...state });
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

export function acquireMaintenanceLock(stateRoot, metadata = {}) {
  const root = path.resolve(expandHome(stateRoot));
  if (!existsSync(root)) throw new Error("cannot acquire maintenance lock for a missing state root");
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
  if (!existsSync(file)) return;
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
  const details = {};
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
  const ownerPid = lock.owner?.pid ? `pid ${lock.owner.pid}` : "another process";
  logger.info?.(`waiting for ${ownerPid} to finish the current startup/state operation`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
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
      return {
        acquired: true,
        path: lockPath,
        owner: payload,
        release() { releaseProcessLock(lockPath, token); },
      };
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
  let info;
  try { info = lstatSync(lockPath); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`process lock must not be a symbolic link: ${lockPath}`);
  if (!info.isFile()) throw new Error(`process lock is not a regular file: ${lockPath}`);
  let owner = null;
  try {
    const parsed = JSON.parse(readBoundedUtf8(lockPath, MAX_LOCK_BYTES, "lock file"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) owner = parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
  }
  return { owner, info: lockIdentity(info) };
}

function removeLockSnapshot(lockPath, snapshot) {
  let current;
  try { current = lstatSync(lockPath); } catch (error) { return error?.code === "ENOENT"; }
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

function lockIdentity(info) {
  return {
    dev: Number(info.dev),
    ino: Number(info.ino),
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
  };
}

function sameLockIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function releaseProcessLock(lockPath, token) {
  let snapshot;
  try { snapshot = readProcessLockSnapshot(lockPath); } catch { return; }
  if (!snapshot || snapshot.owner?.token !== token) return;
  removeLockSnapshot(lockPath, snapshot);
}

export function readDaemonLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(readBoundedUtf8(lockPath, MAX_LOCK_BYTES, "lock file"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

function readBoundedUtf8(filePath, maxBytes, label) {
  const pathInfo = lstatSync(filePath);
  if (pathInfo.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(filePath, Number(fsConstants.O_RDONLY) | noFollow);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    if (info.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new Error(`${label} is not valid UTF-8`);
    }
  } finally {
    closeSync(fd);
  }
}

function readJsonObjectOrBackup(filePath) {
  const text = readBoundedUtf8(filePath, MAX_STATE_JSON_BYTES, "state JSON");
  let parsed;
  try {
    parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON root must be an object");
    return parsed;
  } catch {
    const backupPath = `${filePath}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
    replaceFileSync(filePath, backupPath);
    ownerOnlyFile(backupPath);
    pruneBackups(filePath, 3);
    return {};
  }
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
    if (entries.length) {
      if (!hasOnlyStateEntries(entries)) {
        throw new Error(`state root must be a dedicated directory; unexpected entries found in ${root}`);
      }
      if (!isRecognizableLegacyStateRoot(root)) {
        throw new Error(`state root is non-empty but does not contain recognizable Machine Bridge state: ${root}`);
      }
    }
    try {
      createExclusiveFileSync(marker, `${JSON.stringify({ app: appName, schema: 1 })}\n`, { mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      assertValidStateMarker(marker, { migrateLegacy: true });
    }
  } else {
    assertValidStateMarker(marker, { migrateLegacy: true });
  }
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
  if (looksLikeSourceTree(canonical) || stateRootMatchesRecordedWorkspace(canonical)) {
    throw new Error(`refusing to remove state root that appears to be a workspace: ${canonical}`);
  }
  const entries = readdirSync(canonical);
  if (!hasOnlyStateEntries(entries)) {
    throw new Error(`refusing to remove state root containing unrelated entries: ${canonical}`);
  }
  const marker = path.join(canonical, STATE_MARKER);
  if (existsSync(marker)) {
    assertValidStateMarker(marker);
    return canonical;
  }
  if (isRecognizableLegacyStateRoot(canonical)) return canonical;
  throw new Error(`refusing to remove unrecognized state root without ${STATE_MARKER}: ${canonical}`);
}

function assertValidStateMarker(marker, options = {}) {
  const content = readBoundedUtf8(marker, MAX_MARKER_BYTES, "state marker");
  try {
    const value = JSON.parse(content);
    if (value?.app === appName && value?.schema === 1) return;
  } catch {}
  if (content.trim() === `${appName} state root`) {
    if (options.migrateLegacy) atomicWriteJson(marker, { app: appName, schema: 1 });
    return;
  }
  throw new Error(`invalid state root marker: ${marker}`);
}

function hasOnlyStateEntries(entries) {
  const allowed = new Set([STATE_MARKER, "config.json", "browser-bridge.json", "maintenance.lock", "profiles", "logs"]);
  return entries.every((entry) => allowed.has(entry) || /^config\.json\.corrupt-\d+(?:-[a-f0-9]{8})?$/.test(entry));
}

function looksLikeSourceTree(root) {
  return [".git", ".hg", ".svn", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"].some((name) => existsSync(path.join(root, name)));
}

function stateRootMatchesRecordedWorkspace(root) {
  const config = path.join(root, "config.json");
  if (existsSync(config)) {
    try {
      const value = JSON.parse(readBoundedUtf8(config, MAX_STATE_JSON_BYTES, "config JSON"));
      if (typeof value?.selectedWorkspace === "string" && sameWorkspaceIdentity(value.selectedWorkspace, root)) return true;
    } catch {}
  }
  const profiles = path.join(root, "profiles");
  if (!existsSync(profiles)) return false;
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profileDir = path.join(profiles, entry.name);
      const stateFile = path.join(profileDir, "state.json");
      if (existsSync(stateFile)) {
        try {
          const value = JSON.parse(readBoundedUtf8(stateFile, MAX_STATE_JSON_BYTES, "state JSON"));
          if (typeof value?.workspace?.path === "string" && sameWorkspaceIdentity(value.workspace.path, root)) return true;
        } catch {}
      }
      const owner = readDaemonLockOwner(path.join(profileDir, "daemon.lock"));
      if (typeof owner?.workspace === "string" && sameWorkspaceIdentity(owner.workspace, root)) return true;
    }
  } catch {}
  return false;
}

function isRecognizableLegacyStateRoot(root) {
  const config = path.join(root, "config.json");
  try {
    if (existsSync(config)) {
      const value = JSON.parse(readBoundedUtf8(config, MAX_STATE_JSON_BYTES, "config JSON"));
      if (
        value &&
        typeof value.selectedWorkspace === "string" &&
        typeof value.selectedWorkspaceHash === "string" &&
        workspaceHash(value.selectedWorkspace) === value.selectedWorkspaceHash
      ) return true;
    }
  } catch {}
  const profiles = path.join(root, "profiles");
  if (!existsSync(profiles)) return false;
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
      const stateFile = path.join(profiles, entry.name, "state.json");
      if (!existsSync(stateFile)) continue;
      const value = JSON.parse(readBoundedUtf8(stateFile, MAX_STATE_JSON_BYTES, "state JSON"));
      if (value?.workspace?.hash === entry.name && typeof value?.workspace?.path === "string") return true;
    }
  } catch {}
  return false;
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
    } catch {}
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
    try { unlinkSync(backup.path); } catch {}
  }
}

export function ensureWorkerSecrets(state, options = {}) {
  state.worker ||= {};
  if (!state.worker.oauthPassword || options.rotateSecrets) state.worker.oauthPassword = randomToken("mcp_password");
  if (!state.worker.daemonSecret || options.rotateSecrets) state.worker.daemonSecret = randomToken("daemon_secret");
  if (!state.worker.oauthTokenVersion || options.rotateSecrets) state.worker.oauthTokenVersion = randomToken("token_version");
  if (!state.worker.name || options.workerName) state.worker.name = options.workerName || defaultWorkerName(state.workspace.hash);
}

function defaultWorkerName(hash) {
  return `mbm-${String(hash || "default").slice(0, 12)}`;
}

function randomToken(prefix) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}


export function ensureOwnerOnlyDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
}

export function ownerOnlyFile(filePath) {
  const info = lstatSync(filePath);
  if (info.isSymbolicLink()) throw new Error(`owner-only file must not be a symbolic link: ${filePath}`);
  if (!info.isFile()) throw new Error(`owner-only path is not a regular file: ${filePath}`);
  try { chmodSync(filePath, 0o600); } catch {}
}

export function redactState(state) {
  const clone = redactHomeInValue(JSON.parse(JSON.stringify(state)));
  if (clone.worker?.oauthPassword) clone.worker.oauthPassword = "<redacted>";
  if (clone.worker?.daemonSecret) clone.worker.daemonSecret = "<redacted>";
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

export function previewSecret(_value) {
  return "<redacted>";
}
