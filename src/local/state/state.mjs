import path from "node:path";
import { isPlainRecord } from "../../shared/records.mjs";
import { normalizeIdleSleepMode } from "../core/idle-sleep-assertions.mjs";
import { ensureOwnerOnlyDir, inspectPathIfPresentSync, ownerOnlyFile, unlinkRegularFileIfIdentitySync } from "../core/secure-file.mjs";
import { assertNoForeignMaintenance } from "./state-locks.mjs";
import { CORRUPT_RECOVERY, GLOBAL_CONFIG_SCHEMA, STATE_MARKER, assertValidStateMarker, atomicWriteJson, ensureStateRoot, profileDirForWorkspace, readJsonObjectOrBackup, readRecoveryMarker, recoveryMarkerPath, recoveryRequiredError, samePotentialPathIdentity, sameWorkspaceIdentity, workspaceHash } from "./state-storage.mjs";
import { assertStateRootSeparatedFromWorkspace, canonicalizePotentialPath, defaultStateRoot, expandHome, resolveWorkspace } from "../files/workspace-paths.mjs";

export const STATE_SCHEMA_VERSION = 6;

export {
  expandHome,
  resolveWorkspace,
  defaultFirstRunWorkspace,
  ensureWorkspaceDirectory,
  defaultStateRoot,
  canonicalizePotentialPath,
  assertStateRootSeparatedFromWorkspace,
} from "../files/workspace-paths.mjs";

export { profileDirForWorkspace, removeStateRoot, validateStateRootForRemoval } from "./state-storage.mjs";

export {
  acquireDaemonLock,
  acquireMachineServiceLock,
  acquireMachineServiceLockWithWait,
  acquireMaintenanceLock,
  acquireStartupLock,
  acquireStartupLockWithWait,
  assertStateMaintenanceAvailable,
  daemonLockPathForState,
  machineServiceControlRoot,
  machineServiceLockPath,
  readDaemonLockOwner,
} from "./state-locks.mjs";

export {
  deploymentDeviceIdentity,
  ensureWorkerSecrets,
  promotePendingDeviceIdentity,
  redactState,
} from "./state-secrets.mjs";

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
    throw new Error("global configuration schema is obsolete; preserve the state root and use a supported upgrade or backup recovery path");
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

export function configuredIdleSleepMode(stateRoot = defaultStateRoot()) {
  return normalizeIdleSleepMode(loadGlobalConfig(stateRoot).idleSleepMode || "activity");
}

export function setConfiguredIdleSleepMode(mode, stateRoot = defaultStateRoot()) {
  const config = loadGlobalConfig(stateRoot);
  config.idleSleepMode = normalizeIdleSleepMode(mode);
  saveGlobalConfig(config, stateRoot);
  return config.idleSleepMode;
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
  const recoveryPath = recoveryMarkerPath(statePath);
  const recoveryPending = Boolean(inspectPathIfPresentSync(recoveryPath, "state recovery marker"));
  const recoverySnapshot = recoveryPending ? readRecoveryMarker(recoveryPath, statePath) : null;
  const recoveryMarker = recoverySnapshot?.marker || null;
  let state = {};
  if (inspectPathIfPresentSync(statePath, "workspace state")) {
    ownerOnlyFile(statePath);
    state = readJsonObjectOrBackup(statePath, { recoveryPath });
    if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
      throw new Error("workspace state schema is obsolete; preserve the state root and use a supported upgrade or backup recovery path");
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
