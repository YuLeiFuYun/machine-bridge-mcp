// @ts-check
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { activeStateJobs, activeStateLocks } from "./state-inventory.mjs";
import { inspectProcessInstance } from "./process-identity.mjs";
import { autostartStatus } from "./service.mjs";
import { serviceOwnerPath } from "./service-owner.mjs";
import {
  STATE_SCHEMA_VERSION,
  acquireMachineServiceLockWithWait,
  acquireMaintenanceLock,
  defaultStateRoot,
  expandHome,
  loadGlobalConfig,
  resolveWorkspace,
  saveGlobalConfig,
  selectedWorkspace,
  setSelectedWorkspace,
} from "./state.mjs";
import {
  inspectPathIfPresentSync,
  ownerOnlyFile,
  readBoundedRegularFileWithInfoSync,
  unlinkRegularFileIfIdentitySync,
} from "./secure-file.mjs";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const MARKER_NAME = "workspace-migration.json";
const MARKER_SCHEMA_VERSION = 1;
const PROFILE_NAME = /^[a-f0-9]{24}$/;
const SERVICE_OWNER_SCHEMA_VERSION = 1;
const SERVICE_OWNER_VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;
const SERVICE_OWNER_TRANSACTION = /^[A-Za-z0-9_-]{20,128}$/;
const KNOWN_PROFILE_LOCKS = Object.freeze([
  ["daemon.lock", Number.POSITIVE_INFINITY],
  ["startup.lock", 2 * 60 * 60 * 1000],
  ["operation-authorization.lock", Number.POSITIVE_INFINITY],
  ["security-audit.lock", Number.POSITIVE_INFINITY],
]);

export function historicalWorkspaceHash(workspace, options = {}) {
  const normalized = normalizeHistoricalWorkspace(workspace);
  const identity = String(options.platform || process.platform) === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

export function retireMatchingServiceOwner(spec = {}, options = {}) {
  const file = serviceOwnerPath(options);
  const info = inspectPathIfPresentSync(file, "machine service owner file");
  if (!info) return { retired: false, reason: "missing" };
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("machine service owner file must be a regular file and not a symbolic link");
  const opened = readBoundedRegularFileWithInfoSync(file, 64 * 1024, "machine service owner file", {
    verifyPathIdentity: true,
    rejectMultipleLinks: true,
  });
  let record;
  try { record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened.buffer)); }
  catch (cause) { throw new Error("machine service owner file is not valid JSON/UTF-8", { cause }); }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("machine service owner must be an object");
  if (record.schemaVersion !== SERVICE_OWNER_SCHEMA_VERSION || record.status !== "committed") {
    throw new Error("workspace migration requires a committed machine service owner or no owner record");
  }
  if (typeof record.transactionId !== "string" || !SERVICE_OWNER_TRANSACTION.test(record.transactionId)
      || typeof record.version !== "string" || !SERVICE_OWNER_VERSION.test(record.version)) {
    throw new Error("workspace migration machine service owner metadata is invalid");
  }
  if (!Number.isFinite(Date.parse(String(record.createdAt || "")))
      || !Number.isFinite(Date.parse(String(record.committedAt || "")))) {
    throw new Error("workspace migration machine service owner timestamps are invalid");
  }
  const expectedWorkspace = normalizeHistoricalWorkspace(spec.sourceWorkspace);
  const recordedWorkspace = normalizeHistoricalWorkspace(record.workspace);
  if (!samePath(expectedWorkspace, recordedWorkspace)) {
    throw new Error("machine service owner does not match the workspace profile being migrated");
  }
  const expectedStateRoot = canonicalStateRoot(spec.stateRoot);
  const recordedStateRoot = canonicalStateRoot(record.stateRoot);
  if (!samePath(expectedStateRoot, recordedStateRoot)) {
    throw new Error("machine service owner state root does not match the workspace profile being migrated");
  }
  const entryScript = inspectHistoricalRegularFile(record.entryScript, "entry script");
  if (!unlinkRegularFileIfIdentitySync(file, opened.identity, "machine service owner file")) {
    throw new Error("machine service owner changed before workspace-migration retirement");
  }
  return { retired: true, version: record.version, entryScript };
}

export function createWorkspaceCommand({ stateRootFromArgs, ask } = {}) {
  if (typeof stateRootFromArgs !== "function") throw new TypeError("workspace command requires stateRootFromArgs");
  if (typeof ask !== "function") throw new TypeError("workspace command requires ask");
  return async function workspaceCommand(args) {
    const action = String(args._[0] || "show");
    const stateRoot = stateRootFromArgs(args);
    if (action === "show") {
      const workspace = selectedWorkspace(stateRoot);
      console.log(workspace || "No workspace selected yet. Run `machine-mcp workspace set` or `mbm workspace set`.");
      return;
    }
    if (action === "set" || action === "select") {
      const raw = args.workspace || args._[1];
      let workspace;
      if (raw && raw !== true) workspace = resolveWorkspace(String(raw));
      else {
        const current = selectedWorkspace(stateRoot) || process.cwd();
        const answer = process.stdin.isTTY ? await ask(`Workspace path [${current}]: `) : current;
        workspace = resolveWorkspace(String(answer || current));
      }
      setSelectedWorkspace(workspace, stateRoot);
      console.log(`Selected workspace: ${workspace}`);
      console.log("Run `machine-mcp` (or `mbm`) to use this workspace.");
      return;
    }
    if (action === "migrate") {
      if (args.workspace) throw new Error("workspace migrate accepts OLD and NEW as positional paths; do not combine it with --workspace");
      const sourceWorkspace = args._[1];
      const destinationWorkspace = args._[2];
      if (!sourceWorkspace || !destinationWorkspace) throw new Error("workspace migrate requires OLD and NEW workspace paths");
      const result = await runWorkspaceMigrationCommand({
        sourceWorkspace: String(sourceWorkspace), destinationWorkspace: String(destinationWorkspace), stateRoot,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (action === "reset") {
      const config = loadGlobalConfig(stateRoot);
      delete config.selectedWorkspace;
      delete config.selectedWorkspaceHash;
      saveGlobalConfig(config, stateRoot);
      console.log("Workspace selection reset. Next start will ask again.");
      return;
    }
    throw new Error(`Unknown workspace action: ${action}`);
  };
}

export async function runWorkspaceMigrationCommand({
  sourceWorkspace,
  destinationWorkspace,
  stateRoot = defaultStateRoot(),
} = {}) {
  const machineLock = await acquireMachineServiceLockWithWait({ operation: "workspace-migrate" });
  if (!machineLock?.acquired || typeof machineLock.release !== "function") {
    throw new Error("workspace migration could not acquire the machine-service operation lock");
  }
  try {
    const maintenance = acquireMaintenanceLock(stateRoot, { operation: "workspace-migrate" });
    if (!maintenance?.acquired || typeof maintenance.release !== "function") {
      const pid = maintenance?.owner?.pid ? `pid ${maintenance.owner.pid}` : "unknown pid";
      throw new Error(`workspace migration could not acquire the state maintenance lock (${pid})`);
    }
    try {
      return await migrateWorkspaceProfile({ sourceWorkspace, destinationWorkspace, stateRoot });
    } finally {
      maintenance.release();
    }
  } finally {
    machineLock.release();
  }
}

export async function migrateWorkspaceProfile({
  sourceWorkspace,
  destinationWorkspace,
  stateRoot = defaultStateRoot(),
  readProvider = autostartStatus,
  listActiveJobs = activeStateJobs,
  listActiveLocks = activeStateLocks,
  retireServiceOwner = retireMatchingServiceOwner,
} = {}) {
  const root = canonicalStateRoot(stateRoot);
  const source = normalizeHistoricalWorkspace(sourceWorkspace);
  const destination = resolveWorkspace(requiredPath(destinationWorkspace, "destination workspace"));
  if (samePath(source, destination)) throw new Error("workspace migration requires different source and destination paths");

  const profilesRoot = path.join(root, "profiles");
  assertRealDirectory(profilesRoot, "state profile directory");
  const sourceHash = historicalWorkspaceHash(source);
  const destinationHash = historicalWorkspaceHash(destination);
  if (!PROFILE_NAME.test(sourceHash) || !PROFILE_NAME.test(destinationHash)) throw new Error("workspace migration profile identity is invalid");
  const sourceProfile = path.join(profilesRoot, sourceHash);
  const destinationProfile = path.join(profilesRoot, destinationHash);
  const sourceInfo = inspectPathIfPresentSync(sourceProfile, "source workspace profile");
  let destinationInfo = inspectPathIfPresentSync(destinationProfile, "destination workspace profile");

  let activeProfile;
  let phase;
  let destinationShellObserved = false;
  if (sourceInfo) {
    assertDirectoryInfo(sourceInfo, "source workspace profile");
    if (destinationInfo) {
      if (!isUnpopulatedProfileShell(destinationProfile)) {
        throw new Error("destination workspace profile already exists; refusing to merge workspace state");
      }
      destinationShellObserved = true;
    }
    activeProfile = sourceProfile;
    phase = "source";
  } else {
    if (!destinationInfo) throw new Error("source workspace profile does not exist for the supplied historical workspace path");
    assertDirectoryInfo(destinationInfo, "destination workspace profile");
    activeProfile = destinationProfile;
    phase = "destination";
  }
  assertProfileStructure(activeProfile);

  let marker = readMigrationMarker(activeProfile);
  let snapshot = readProfileState(activeProfile);
  if (phase === "source") {
    assertWorkspaceStateEnvelope(snapshot.state, {
      workspace: source, hash: sourceHash, stateRoot: root, profileDir: sourceProfile,
    });
    if (marker) assertMarker(marker.value, { source, sourceHash, destination, destinationHash, stateRoot: root });
  } else {
    if (!marker) throw new Error("destination workspace profile already exists without a matching migration marker");
    assertMarker(marker.value, { source, sourceHash, destination, destinationHash, stateRoot: root });
    if (samePath(snapshot.state?.workspace?.path, source)) {
      assertWorkspaceStateEnvelope(snapshot.state, {
        workspace: source, hash: sourceHash, stateRoot: root, profileDir: destinationProfile,
        allowRelocatedProfile: true,
      });
      if (digest(snapshot.buffer) !== marker.value.stateSha256) {
        throw new Error("workspace migration source state changed after the migration marker was written");
      }
    } else {
      assertWorkspaceStateEnvelope(snapshot.state, {
        workspace: destination, hash: destinationHash, stateRoot: root, profileDir: destinationProfile,
      });
    }
  }

  const provider = await readProvider();
  if (provider?.active !== false) {
    throw new Error("workspace migration requires the machine service provider to be stopped and verifiably inactive");
  }
  const profileName = path.basename(activeProfile);
  const jobs = listActiveJobs(root).filter((item) => item?.profile === profileName);
  if (jobs.length) throw new Error(`workspace migration refused because ${jobs.length} managed job(s) are still active in the source profile`);
  const locks = listActiveLocks(root).filter((item) => typeof item?.path === "string" && pathInside(activeProfile, item.path));
  if (locks.length) throw new Error(`workspace migration refused because ${locks.length} state lock(s) are still active in the source profile`);

  if (phase === "source" && destinationShellObserved) {
    if (!pruneUnpopulatedProfileShell(destinationProfile)) {
      throw new Error("destination workspace profile changed before migration; refusing to overwrite it");
    }
    destinationInfo = null;
  }

  if (!marker) {
    const value = {
      schemaVersion: MARKER_SCHEMA_VERSION,
      sourceWorkspace: source,
      sourceHash,
      destinationWorkspace: destination,
      destinationHash,
      stateRoot: root,
      stateSha256: digest(snapshot.buffer),
      createdAt: new Date().toISOString(),
    };
    writeMigrationMarker(activeProfile, value);
    marker = readMigrationMarker(activeProfile);
  }

  const owner = retireServiceOwner({ sourceWorkspace: source, stateRoot: root });
  removeReclaimableProfileLocks(activeProfile);

  if (phase === "source") {
    if (inspectPathIfPresentSync(destinationProfile, "destination workspace profile")) {
      if (!pruneUnpopulatedProfileShell(destinationProfile)) {
        throw new Error("destination workspace profile appeared during migration; refusing to overwrite it");
      }
    }
    renameSync(sourceProfile, destinationProfile);
    activeProfile = destinationProfile;
    marker = readMigrationMarker(activeProfile);
    snapshot = readProfileState(activeProfile);
  }

  if (!marker) throw new Error("workspace migration marker disappeared before state rewrite");
  assertMarker(marker.value, { source, sourceHash, destination, destinationHash, stateRoot: root });
  if (samePath(snapshot.state?.workspace?.path, source)) {
    if (digest(snapshot.buffer) !== marker.value.stateSha256) {
      throw new Error("workspace migration source state changed before destination rewrite");
    }
    const migrated = {
      ...snapshot.state,
      workspace: {
        ...snapshot.state.workspace,
        path: destination,
        hash: destinationHash,
        updatedAt: new Date().toISOString(),
      },
      paths: {
        ...snapshot.state.paths,
        stateRoot: root,
        profileDir: destinationProfile,
        statePath: path.join(destinationProfile, "state.json"),
      },
    };
    const statePath = path.join(destinationProfile, "state.json");
    replaceFileAtomicallySync(statePath, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 });
    ownerOnlyFile(statePath);
    snapshot = readProfileState(destinationProfile);
  }
  assertWorkspaceStateEnvelope(snapshot.state, {
    workspace: destination, hash: destinationHash, stateRoot: root, profileDir: destinationProfile,
  });
  setSelectedWorkspace(destination, root);
  removeMigrationMarker(destinationProfile);
  return {
    ok: true,
    source_workspace: source,
    destination_workspace: destination,
    source_profile_hash: sourceHash,
    destination_profile_hash: destinationHash,
    service_owner_retired: owner?.retired === true,
    selected_workspace: destination,
    profile_moved: true,
    next_steps: [
      "machine-mcp service install --workspace <destination>",
      "machine-mcp service start",
      "verify live version/readiness before archiving the old worktree",
    ],
  };
}

function normalizeHistoricalWorkspace(value) {
  const requested = path.resolve(expandHome(requiredPath(value, "source workspace")));
  const info = inspectPathIfPresentSync(requested, "source workspace");
  if (!info) return canonicalizePotentialPath(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("source workspace must be a real directory when it still exists");
  return realpathSync.native ? realpathSync.native(requested) : realpathSync(requested);
}

function canonicalizePotentialPath(input) {
  let existing = path.resolve(input);
  const suffix = [];
  while (!inspectPathIfPresentSync(existing, "historical workspace path identity")) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalExisting = realpathSync.native ? realpathSync.native(existing) : realpathSync(existing);
  return path.join(canonicalExisting, ...suffix);
}

function canonicalStateRoot(value) {
  const requested = path.resolve(expandHome(requiredPath(value, "state root")));
  const info = inspectPathIfPresentSync(requested, "state root");
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error("workspace migration requires an existing real state root");
  return realpathSync.native ? realpathSync.native(requested) : realpathSync(requested);
}

function assertRealDirectory(value, label) {
  const info = inspectPathIfPresentSync(value, label);
  if (!info) throw new Error(`${label} is missing`);
  assertDirectoryInfo(info, label);
}

function assertDirectoryInfo(info, label) {
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
}

function assertProfileStructure(profileDir) {
  for (const entry of readdirSync(profileDir, { withFileTypes: true })) {
    const target = path.join(profileDir, entry.name);
    const info = lstatSync(target, { bigint: true });
    if (info.isSymbolicLink()) throw new Error(`workspace profile contains a symbolic link: ${entry.name}`);
    if (info.isDirectory()) {
      if (entry.name !== "jobs") throw new Error(`workspace profile contains an unexpected directory: ${entry.name}`);
      continue;
    }
    if (!info.isFile()) throw new Error(`workspace profile contains an unsupported entry type: ${entry.name}`);
    if (info.nlink !== 1n) throw new Error(`workspace profile file must be single-link before migration: ${entry.name}`);
  }
}

function readProfileState(profileDir) {
  const statePath = path.join(profileDir, "state.json");
  if (inspectPathIfPresentSync(`${statePath}.recovery-required`, "state recovery marker")) {
    throw new Error("workspace state recovery is pending; resolve it before workspace migration");
  }
  const opened = readBoundedRegularFileWithInfoSync(statePath, MAX_STATE_BYTES, "workspace migration state", {
    verifyPathIdentity: true,
    rejectMultipleLinks: true,
  });
  let state;
  try { state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened.buffer)); }
  catch (cause) { throw new Error("workspace migration state is not valid JSON/UTF-8", { cause }); }
  return { state, buffer: opened.buffer, statePath };
}

function assertWorkspaceStateEnvelope(state, { workspace, hash, stateRoot, profileDir, allowRelocatedProfile = false }) {
  if (!state || typeof state !== "object" || Array.isArray(state) || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error("workspace migration state schema is invalid");
  }
  if (!state.workspace || !state.paths || !state.worker || !state.policy || !state.resources) {
    throw new Error("workspace migration state envelope is incomplete");
  }
  if (!samePath(state.workspace.path, workspace) || state.workspace.hash !== hash) {
    throw new Error("workspace migration source evidence does not match the requested historical workspace identity");
  }
  const expectedState = path.join(profileDir, "state.json");
  if (!samePath(state.paths.stateRoot, stateRoot)) throw new Error("workspace migration state root does not match the requested state root");
  if (!allowRelocatedProfile && !samePath(state.paths.profileDir, profileDir)) throw new Error("workspace migration profile path does not match its state envelope");
  if (!allowRelocatedProfile && !samePath(state.paths.statePath, expectedState)) throw new Error("workspace migration state path does not match its state envelope");
  if (allowRelocatedProfile) {
    const historicalProfile = path.join(stateRoot, "profiles", hash);
    if (!samePath(state.paths.profileDir, historicalProfile) || !samePath(state.paths.statePath, path.join(historicalProfile, "state.json"))) {
      throw new Error("relocated workspace migration state no longer proves its historical profile path");
    }
  }
}

function writeMigrationMarker(profileDir, value) {
  const file = path.join(profileDir, MARKER_NAME);
  replaceFileAtomicallySync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  ownerOnlyFile(file);
}

function readMigrationMarker(profileDir) {
  const file = path.join(profileDir, MARKER_NAME);
  if (!inspectPathIfPresentSync(file, "workspace migration marker")) return null;
  const opened = readBoundedRegularFileWithInfoSync(file, MAX_MARKER_BYTES, "workspace migration marker", {
    verifyPathIdentity: true,
    rejectMultipleLinks: true,
  });
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened.buffer)); }
  catch (cause) { throw new Error("workspace migration marker is invalid", { cause }); }
  return { value, identity: opened.identity };
}

function assertMarker(value, expected) {
  if (!value || value.schemaVersion !== MARKER_SCHEMA_VERSION
      || !samePath(value.sourceWorkspace, expected.source)
      || value.sourceHash !== expected.sourceHash
      || !samePath(value.destinationWorkspace, expected.destination)
      || value.destinationHash !== expected.destinationHash
      || !samePath(value.stateRoot, expected.stateRoot)
      || typeof value.stateSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.stateSha256)
      || !Number.isFinite(Date.parse(String(value.createdAt || "")))) {
    throw new Error("workspace migration marker does not match the requested migration");
  }
}

function removeMigrationMarker(profileDir) {
  const marker = readMigrationMarker(profileDir);
  if (!marker) return;
  const file = path.join(profileDir, MARKER_NAME);
  if (!unlinkRegularFileIfIdentitySync(file, marker.identity, "workspace migration marker")) {
    throw new Error("workspace migration marker changed before removal");
  }
}

function removeReclaimableProfileLocks(profileDir) {
  for (const [name, maxAgeMs] of KNOWN_PROFILE_LOCKS) {
    const file = path.join(profileDir, name);
    if (!inspectPathIfPresentSync(file, `${name} migration lock`)) continue;
    const opened = readBoundedRegularFileWithInfoSync(file, 64 * 1024, `${name} migration lock`, {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
    let owner;
    try { owner = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened.buffer)); }
    catch (cause) { throw new Error(`workspace migration cannot verify ${name}`, { cause }); }
    const identity = inspectProcessInstance(owner, { maxAgeMs });
    if (identity.current || !identity.reclaimable) {
      throw new Error(`workspace migration cannot reclaim ${name} safely (${identity.reason})`);
    }
    if (!unlinkRegularFileIfIdentitySync(file, opened.identity, `${name} migration lock`)) {
      throw new Error(`workspace migration ${name} changed before removal`);
    }
  }
}

function pathInside(root, candidate) {
  const canonicalRoot = canonicalizePotentialPath(root);
  const canonicalCandidate = canonicalizePotentialPath(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function historicalAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`machine service owner ${label} must be absolute`);
  return path.resolve(value);
}

function inspectHistoricalRegularFile(value, label) {
  const requested = historicalAbsolutePath(value, label);
  const info = inspectPathIfPresentSync(requested, `machine service owner ${label}`);
  if (!info) return requested;
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`machine service owner ${label} must be a regular file when present`);
  return realpathSync.native ? realpathSync.native(requested) : realpathSync(requested);
}

export function isUnpopulatedProfileShell(profileDir) {
  const info = inspectPathIfPresentSync(profileDir, "destination workspace profile");
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) return false;
  const entries = readdirSync(profileDir, { withFileTypes: true });
  if (entries.length === 0) return true;
  if (entries.length === 1 && entries[0].name === "jobs" && entries[0].isDirectory() && !entries[0].isSymbolicLink()) {
    const jobEntries = readdirSync(path.join(profileDir, "jobs"), { withFileTypes: true });
    return jobEntries.length === 0;
  }
  return false;
}

export function pruneUnpopulatedProfileShell(profileDir) {
  if (!isUnpopulatedProfileShell(profileDir)) return false;
  try {
    const jobsDir = path.join(profileDir, "jobs");
    if (inspectPathIfPresentSync(jobsDir, "empty jobs directory")) {
      rmdirSync(jobsDir);
    }
    rmdirSync(profileDir);
    return true;
  } catch {
    return false;
  }
}

function samePath(left, right, platform = process.platform) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b) return true;
  try {
    const realA = realpathSync.native ? realpathSync.native(a) : realpathSync(a);
    const realB = realpathSync.native ? realpathSync.native(b) : realpathSync(b);
    return platform === "win32" ? realA.toLowerCase() === realB.toLowerCase() : realA === realB;
  } catch {
    return false;
  }
}

function digest(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value;
}
