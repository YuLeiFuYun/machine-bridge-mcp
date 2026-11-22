import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { isPlainRecord } from "../../shared/records.mjs";
import { createDeviceIdentity } from "./device-identity.mjs";
import { validateDeviceRootIdentity } from "./device-root-provider.mjs";
import { isOAuthTokenVersion, isPreviousWorkerNames, isWorkerName } from "./worker-identity-contract.mjs";

export function ensureWorkerSecrets(state, options = {}) {
  if (state.worker === undefined || state.worker === null) state.worker = {};
  if (!isPlainRecord(state.worker)) throw new Error("workspace Worker state is invalid");
  delete state.worker.accountAdminSecret;
  const enrollingDeviceIdentity = !state.worker.deviceIdentity;
  if (enrollingDeviceIdentity || (options.rotateSecrets && !options.deferDeviceRotation)) state.worker.deviceIdentity = createDeviceIdentity();
  else validateDeviceRootIdentity(state.worker.deviceIdentity);
  if (state.worker.pendingDeviceIdentity) validateDeviceRootIdentity(state.worker.pendingDeviceIdentity);
  delete state.worker.daemonSecret;
  if (enrollingDeviceIdentity || options.rotateSecrets) {
    state.worker.oauthTokenVersion = randomToken("token_version");
  } else if (!isOAuthTokenVersion(state.worker.oauthTokenVersion)) {
    throw new Error("workspace Worker OAuth token version is invalid");
  }

  const requestedName = options.workerName === undefined || options.workerName === null || options.workerName === false ? "" : options.workerName;
  if (typeof requestedName !== "string" || (requestedName && !isWorkerName(requestedName))) throw new Error("workspace Worker name is invalid");
  if (!isPreviousWorkerNames(state.worker.previousNames)) throw new Error("workspace previous Worker names are invalid");
  if (!state.worker.name) {
    state.worker.name = requestedName || defaultWorkerName(state.workspace.hash);
    return;
  }
  if (!isWorkerName(state.worker.name)) throw new Error("workspace Worker name is invalid");
  if (!requestedName || requestedName === state.worker.name) return;
  if (!options.allowWorkerRename) {
    throw new Error(`this workspace already uses Worker ${state.worker.name}; changing --worker-name to ${requestedName} would create another Worker. Re-run with --force-worker only when that replacement is intentional`);
  }

  const previous = state.worker.name;
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
  const clone = redactHomeInValue(JSON.parse(JSON.stringify(state)), os.homedir());
  redactDeviceIdentityState(clone.worker);
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

function redactDeviceIdentityState(worker) {
  if (!worker || typeof worker !== "object") return;
  for (const identity of [
    worker.deviceIdentity,
    worker.pendingDeviceIdentity,
    ...(Array.isArray(worker.previousDeviceIdentities) ? worker.previousDeviceIdentities : []),
  ]) {
    if (!identity || typeof identity !== "object") continue;
    delete identity.privateJwk;
    delete identity.publicJwk;
    if (identity.brokerPath) identity.brokerPath = "<local-broker-path>";
    if (identity.keyTag) identity.keyTag = "<local-key-tag>";
  }
}

function redactHomeInValue(value, home = os.homedir()) {
  if (typeof value === "string") {
    if (!home) return value;
    const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
    const comparableValue = caseInsensitive ? value.toLowerCase() : value;
    const comparableHome = caseInsensitive ? home.toLowerCase() : home;
    const insideHome = comparableValue === comparableHome
      || comparableValue.startsWith(`${comparableHome}${path.sep}`);
    return insideHome ? `~${value.slice(home.length)}` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactHomeInValue(item, home));
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = redactHomeInValue(value[key], home);
  }
  return value;
}
