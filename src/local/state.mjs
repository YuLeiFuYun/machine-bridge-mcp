import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync, chmodSync, realpathSync, rmSync, unlinkSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
import { replaceFileSync } from "./atomic-fs.mjs";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const appName = String(serverMetadata.name);
const STATE_MARKER = ".machine-bridge-mcp-state";
const MAX_STATE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_MARKER_BYTES = 4096;

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
  const file = configPath(stateRoot);
  if (!existsSync(file)) return {};
  ownerOnlyFile(file);
  return readJsonObjectOrBackup(file);
}

export function saveGlobalConfig(config, stateRoot = defaultStateRoot()) {
  const root = ensureStateRoot(expandHome(stateRoot));
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
  const stateRoot = ensureStateRoot(options.stateDir ? expandHome(options.stateDir) : defaultStateRoot());
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

export function acquireDaemonLock(state, metadata = {}) {
  const details = {};
  if (metadata?.mode === "foreground" || metadata?.mode === "service") details.mode = metadata.mode;
  if (typeof metadata?.version === "string" && /^[0-9A-Za-z.+_-]{1,64}$/.test(metadata.version)) details.version = metadata.version;
  return acquireProcessLock(daemonLockPathForState(state), state, "daemon", details);
}

export function acquireStartupLock(state) {
  return acquireProcessLock(startupLockPathForState(state), state, "startup");
}

function acquireProcessLock(lockPath, state, purpose, details = {}) {
  ensureOwnerOnlyDir(path.dirname(lockPath));
  const token = randomBytes(16).toString("hex");
  const payload = {
    pid: process.pid,
    token,
    purpose,
    workspace: state?.workspace?.path || "",
    startedAt: new Date().toISOString(),
    entryScript: process.argv[1] || "",
    ...details,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      ownerOnlyFile(lockPath);
      return {
        acquired: true,
        path: lockPath,
        owner: payload,
        release() { releaseProcessLock(lockPath, token); },
      };
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
      const owner = readDaemonLockOwner(lockPath);
      if (owner?.pid && isPidAlive(owner.pid)) {
        return { acquired: false, path: lockPath, owner, release() {} };
      }
      try { unlinkSync(lockPath); } catch {}
    }
  }
  const owner = readDaemonLockOwner(lockPath);
  return { acquired: false, path: lockPath, owner, release() {} };
}

function releaseProcessLock(lockPath, token) {
  const owner = readDaemonLockOwner(lockPath);
  if (owner?.token !== token) return;
  try { unlinkSync(lockPath); } catch {}
}

export function readDaemonLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(readBoundedUtf8(lockPath, MAX_LOCK_BYTES, "lock file"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readJsonObjectOrBackup(filePath) {
  try {
    const parsed = JSON.parse(readBoundedUtf8(filePath, MAX_STATE_JSON_BYTES, "state JSON"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON root must be an object");
    return parsed;
  } catch {
    const backupPath = `${filePath}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
    try {
      replaceFileSync(filePath, backupPath);
      ownerOnlyFile(backupPath);
      pruneBackups(filePath, 3);
    } catch {}
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
      writeFileSync(marker, `${JSON.stringify({ app: appName, schema: 1 })}\n`, { mode: 0o600, flag: "wx" });
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
  const allowed = new Set([STATE_MARKER, "config.json", "browser-bridge.json", "profiles", "logs"]);
  return entries.every((entry) => allowed.has(entry) || /^config\.json\.corrupt-\d+(?:-[a-f0-9]{8})?$/.test(entry));
}

function looksLikeSourceTree(root) {
  return [".git", ".hg", ".svn", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"].some((name) => existsSync(path.join(root, name)));
}

function stateRootMatchesRecordedWorkspace(root) {
  const profiles = path.join(root, "profiles");
  if (!existsSync(profiles)) return false;
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const stateFile = path.join(profiles, entry.name, "state.json");
      if (!existsSync(stateFile)) continue;
      const value = JSON.parse(readBoundedUtf8(stateFile, MAX_STATE_JSON_BYTES, "state JSON"));
      if (typeof value?.workspace?.path !== "string") continue;
      try { if (realpathSync(value.workspace.path) === root) return true; } catch {}
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
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STATE_JSON_BYTES) throw new Error(`state JSON exceeds ${MAX_STATE_JSON_BYTES} bytes`);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    replaceFileSync(tempPath, filePath);
    ownerOnlyFile(filePath);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
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
