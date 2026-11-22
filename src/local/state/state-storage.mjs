import { readdirSync, closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, renameSync, rmSync, existsSync, realpathSync, statSync, unlinkSync } from "node:fs";
import path, { join, basename, dirname } from "node:path";
import { inspectPathIfPresentSync, ensureOwnerOnlyDir, ownerOnlyFile, readBoundedRegularFileSync, readBoundedRegularFileWithInfoSync, unlinkRegularFileIfIdentitySync } from "../core/secure-file.mjs";
import { randomBytes, createHash } from "node:crypto";
import { filesystemIdentity, sameFilesystemIdentity } from "../core/filesystem-identity.mjs";
import os from "node:os";
import { createExclusiveFileSync, replaceFileAtomicallySync, preserveFileSnapshotSync } from "../core/exclusive-file.mjs";
import { appName, packageRoot } from "../core/timing.mjs";
import { canonicalizePotentialPath, expandHome, resolveWorkspace } from "../files/workspace-paths.mjs";

const TOOLCHAIN_DIRECTORY = /^(?:npm-[0-9A-Za-z.+_-]+-hardened-[a-f0-9]{16}|wrangler-[0-9A-Za-z.+_-]+-[a-f0-9]{16})$/;

const TOOLCHAIN_LOCK_TEMP = /^\.wrangler-toolchain\.lock\.\d+\.[a-f0-9]{16}\.tmp$/;

const ACTIVATION_RECORD = /^v[0-9A-Za-z.-]+\.json$/;

const ACTIVATION_TEMP = /^\.v[0-9A-Za-z.-]+\.json\.\d+\.[a-f0-9]{16}\.tmp$/;

const RUNTIME_DIRECTORY = /^v[0-9A-Za-z.-]+-[0-9a-f]{12}-[0-9a-f]{12}$/;

export function isCandidateRuntimeDirectoryName(name) { return RUNTIME_DIRECTORY.test(String(name || "")); }

export function validateOwnedStateNamespaces(root) {
  validateToolchains(join(root, "toolchains"));
  validateReleaseChannels(join(root, "release-channels"));
}

function validateToolchains(directory) {
  if (!realDirectoryIfPresent(directory, "toolchain state namespace")) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "wrangler-toolchain.lock" || TOOLCHAIN_LOCK_TEMP.test(entry.name)) {
      if (!entry.isFile()) throw new Error("Wrangler toolchain lock state has an invalid type before state removal");
      continue;
    }
    if (!TOOLCHAIN_DIRECTORY.test(entry.name) || !entry.isDirectory()) {
      throw new Error("toolchain state namespace contains an unexpected entry; state was kept for inspection");
    }
  }
}

function validateReleaseChannels(directory) {
  if (!realDirectoryIfPresent(directory, "release-channel state namespace")) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !["activations", "runtimes", "browser-extension"].includes(entry.name)) {
      throw new Error("release-channel state namespace contains an unexpected entry; state was kept for inspection");
    }
  }
  validateNamedChildren(join(directory, "activations"), "activation record", [ACTIVATION_RECORD, ACTIVATION_TEMP], "file");
  validateNamedChildren(join(directory, "runtimes"), "candidate runtime", [RUNTIME_DIRECTORY], "directory");
  validateBrowserExtension(join(directory, "browser-extension"));
}

function validateBrowserExtension(directory) {
  if (!realDirectoryIfPresent(directory, "release browser-extension namespace")) return;
  let visited = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      visited += 1;
      if (visited > 512) throw new Error("release browser-extension namespace contains too many entries; state was kept for inspection");
      if (entry.isDirectory()) { walk(join(current, entry.name)); continue; }
      if (!entry.isFile()) throw new Error("release browser-extension namespace contains an unexpected entry; state was kept for inspection");
    }
  };
  walk(directory);
}

function validateNamedChildren(directory, label, patterns, kind) {
  if (!realDirectoryIfPresent(directory, `${label} namespace`)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const rightType = kind === "file" ? entry.isFile() : entry.isDirectory();
    if (!rightType || !patterns.some((pattern) => pattern.test(entry.name))) {
      throw new Error(`${label} namespace contains an unexpected entry; state was kept for inspection`);
    }
  }
}

function realDirectoryIfPresent(directory, label) {
  const info = inspectPathIfPresentSync(directory, label);
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory before state removal`);
  return true;
}
export function inspectStateRootGeneration(root, label = "state root") {
  const info = inspectDirectory(root, label);
  return filesystemIdentity(info, label);
}

export function stateRootRetirementPath(root, identity, nonce = randomBytes(18).toString("base64url")) {
  if (!/^[A-Za-z0-9_-]{24}$/.test(nonce)) throw new Error("state-root retirement nonce is invalid");
  return join(dirname(root), `.${basename(root)}.retired_state_${nonce}_d${identity.dev}_i${identity.ino}`);
}

export function retiredStateRootDirectories(root) {
  const parent = dirname(root);
  const prefix = `.${basename(root)}.retired_state_`;
  let entries;
  try { entries = readdirSync(parent, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const retired = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const match = /^([A-Za-z0-9_-]{24})_d([0-9]+)_i([0-9]+)$/.exec(entry.name.slice(prefix.length));
    const path = join(parent, entry.name);
    if (!match) { retired.push({ path, identity: null, reclaimable: false }); continue; }
    if (!entry.isDirectory()) { retired.push({ path, identity: null, reclaimable: false }); continue; }
    try {
      const identity = filesystemIdentity(inspectDirectory(path, "retired state root"), "retired state root");
      retired.push({ path, identity, reclaimable: identity.dev === BigInt(match[2]) && identity.ino === BigInt(match[3]) });
    } catch (error) {
      if (error?.code !== "ENOENT") retired.push({ path, identity: null, reclaimable: false });
    }
  }
  return retired;
}

export function removeStateRootGenerationIfCurrent(root, expectedIdentity, verifyMovedRoot, options = {}) {
  const rename = typeof options.renameSync === "function" ? options.renameSync : renameSync;
  let current;
  try { current = inspectStateRootGeneration(root); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (!sameFilesystemIdentity(expectedIdentity, current)) return false;
  let pinned;
  try { pinned = pinDirectoryGeneration(root, expectedIdentity, options); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (String(options.platform || process.platform) !== "win32" && !pinned) return false;
  const retired = stateRootRetirementPath(options.retirementRoot || root, expectedIdentity);
  try {
    try { rename(root, retired); }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    const moved = inspectStateRootGeneration(retired, "retired state root");
    const stable = pinned?.identity || expectedIdentity;
    if (moved.dev !== stable.dev || moved.ino !== stable.ino) return false;
    verifyMovedRoot(retired);
    const verified = inspectStateRootGeneration(retired, "verified retired state root"); if (verified.dev !== stable.dev || verified.ino !== stable.ino) return false;
    rmSync(retired, { recursive: true, force: false });
    return true;
  } finally { pinned?.close(); }
}

export function pruneRetiredStateRootDirectories(root, verifyMovedRoot) {
  for (const retired of retiredStateRootDirectories(root)) {
    if (!retired.reclaimable || !retired.identity) throw new Error("retired state-root generation is inconsistent; state requires inspection");
    if (!removeStateRootGenerationIfCurrent(retired.path, retired.identity, verifyMovedRoot, { retirementRoot: root })) {
      throw new Error("retired state-root generation changed during cleanup; state requires inspection");
    }
  }
}

function inspectDirectory(path, label) {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
  return info;
}

function pinDirectoryGeneration(root, expectedIdentity, options) {
  if (String(options.platform || process.platform) === "win32") return null;
  const open = options.openSync || openSync;
  const inspect = options.fstatSync || ((fd) => fstatSync(fd, { bigint: true }));
  const close = options.closeSync || closeSync;
  const fd = open(root, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY, 0o700);
  try {
    const identity = filesystemIdentity(inspect(fd), "state root descriptor");
    if (!sameFilesystemIdentity(expectedIdentity, identity)) { close(fd); return null; }
    return { identity, close: () => close(fd) };
  } catch (error) { close(fd); throw error; }
}
export const STATE_MARKER = ".machine-bridge-mcp-state";

export const STATE_MARKER_SCHEMA = 2;

export const GLOBAL_CONFIG_SCHEMA = 1;

export const RECOVERY_MARKER_SCHEMA = 1;

export const CORRUPT_RECOVERY = Symbol("corrupt-recovery");

export const MAX_STATE_JSON_BYTES = 2 * 1024 * 1024;

export const MAX_LOCK_BYTES = 64 * 1024;

export const MAX_MARKER_BYTES = 4096;

export function boundedPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

export function workspaceHash(workspace) {
  const canonical = resolveWorkspace(workspace);
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

export function profileDirForWorkspace(workspace, stateRoot = defaultWorkspaceStateRoot()) {
  return path.join(expandHome(stateRoot), "profiles", workspaceHash(workspace));
}

function defaultWorkspaceStateRoot() {
  return path.join(os.homedir(), ".local", "state", appName);
}

export function samePotentialPathIdentity(left, right) {
  try {
    const a = canonicalizePotentialPath(String(left));
    const b = canonicalizePotentialPath(String(right));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

export function sameWorkspaceIdentity(left, right) {
  try {
    const a = resolveWorkspace(left);
    const b = resolveWorkspace(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

export function readBoundedUtf8(filePath, maxBytes, label, options = {}) {
  return decodeUtf8(readBoundedRegularFileSync(filePath, maxBytes, label, options), label);
}

export function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (cause) {
    throw Object.assign(new Error(`${label} is not valid UTF-8`, { cause }), { code: "ERR_INVALID_UTF8" });
  }
}

export function readJsonObjectOrBackup(filePath, options = {}) {
  const opened = readBoundedRegularFileWithInfoSync(filePath, MAX_STATE_JSON_BYTES, "state JSON", {
    verifyPathIdentity: true, rejectMultipleLinks: true,
  });
  const text = decodeUtf8(opened.buffer, "state JSON");
  try {
    const parsed = JSON.parse(text);
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

export function recoveryMarkerPath(statePath) {
  return `${statePath}.recovery-required`;
}

export function readRecoveryMarker(markerPath, statePath) {
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
      || typeof marker.detectedAt !== "string" || !Number.isFinite(Date.parse(marker.detectedAt))) {
    throw new Error("workspace state recovery marker is invalid; inspect the profile manually before continuing");
  }
  return {
    marker: Object.freeze({ schemaVersion: marker.schemaVersion, backup: marker.backup, detectedAt: marker.detectedAt }),
    identity: opened.identity,
  };
}

export function recoveryRequiredError(marker) {
  const backup = marker?.backup || "the bounded corrupt backup";
  const error = new Error(`workspace state recovery is required; invalid JSON was preserved as ${backup}. Restore a valid current-schema state.json or intentionally remove this profile before restarting`);
  error.code = "state_recovery_required";
  return error;
}

export function ensureStateRoot(inputRoot) {
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

export function validateStateRootForRemoval(stateRoot) {
  const root = path.resolve(expandHome(stateRoot));
  if (!inspectPathIfPresentSync(root, "state root")) return { exists: false, root };
  const canonical = assertSafeStateRootForRemoval(root);
  return { exists: true, root: canonical };
}

export function removeStateRoot(stateRoot) {
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

export function assertValidStateMarker(marker) {
  const content = readBoundedUtf8(marker, MAX_MARKER_BYTES, "state marker", { verifyPathIdentity: true, rejectMultipleLinks: true });
  let value;
  try { value = JSON.parse(content); } catch { throw new Error(`invalid state root marker: ${marker}`); }
  if (value?.app !== appName || value?.schema !== STATE_MARKER_SCHEMA) {
    throw new Error("state root schema is obsolete; preserve the state root and use a supported upgrade or backup recovery path");
  }
}

function hasOnlyStateEntries(entries) {
  const allowed = new Set([STATE_MARKER, "config.json", "browser-bridge.json", "maintenance.lock", "profiles", "logs", "service-environment.json", "service-launcher.cmd", "toolchains", "release-channels"]);
  return entries.every((entry) => allowed.has(entry) || /^config\.json\.corrupt-\d+(?:-[a-f0-9]{8})?$/.test(entry));
}

function currentEntrypointInsideStateRoot(root) {
  const entry = String(process.argv[1] || "").trim();
  if (!entry) return false;
  let canonicalRoot;
  let resolved;
  try {
    canonicalRoot = canonicalizePotentialPath(root);
    resolved = canonicalizePotentialPath(entry);
  } catch {
    canonicalRoot = path.resolve(root);
    resolved = path.resolve(entry);
  }
  const relative = path.relative(canonicalRoot, resolved);
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

export function atomicWriteJson(filePath, value) {
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
      .filter((name) => name.startsWith(prefix) && /^\d+(?:-[a-f0-9]{8})?$/.test(name.slice(prefix.length)))
      .map((name) => ({ path: path.join(dir, name), info: lstatSync(path.join(dir, name), { bigint: true }) }))
      .filter(({ info }) => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n)
      .sort((a, b) => Number(b.info.mtimeNs - a.info.mtimeNs));
  } catch {
    return;
  }
  for (const backup of backups.slice(keep)) {
    try { unlinkRegularFileIfIdentitySync(backup.path, filesystemIdentity(backup.info, "corrupt state backup")); }
    catch { /* Backup pruning is bounded housekeeping; retained backups are safer than failing state recovery. */ }
  }
}
