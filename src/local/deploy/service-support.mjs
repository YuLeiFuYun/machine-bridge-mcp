import { lstatSync } from "node:fs";
import { readBoundedRegularFileWithInfoSync, unlinkRegularFileIfIdentitySync, inspectPathIfPresentSync, readBoundedRegularFileSync } from "../core/secure-file.mjs";
import path from "node:path";
import { replaceFileAtomicallySync } from "../core/exclusive-file.mjs";

const DEFAULT_ATTEMPTS = 20;

const DEFAULT_DELAY_MS = 100;

export async function waitForStableActiveStatus(
  readStatus,
  { attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, stableSamples = 5, sleep = delay, identity = stableIdentity } = {},
) {
  if (typeof readStatus !== "function") throw new TypeError("readStatus must be a function");
  if (typeof identity !== "function") throw new TypeError("identity must be a function");
  const maximum = Number.isInteger(attempts) && attempts > 0 ? attempts : DEFAULT_ATTEMPTS;
  const required = Number.isInteger(stableSamples) && stableSamples > 0 ? stableSamples : 5;
  let status = null;
  let consecutive = 0;
  let priorIdentity = null;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    status = await readStatus();
    const currentIdentity = status?.active === true ? identity(status) : null;
    const identityChanged = consecutive > 0
      && (priorIdentity !== null || currentIdentity !== null)
      && currentIdentity !== priorIdentity;
    if (status?.active === true && !identityChanged) consecutive += 1;
    else consecutive = status?.active === true ? 1 : 0;
    priorIdentity = currentIdentity;
    if (consecutive >= required) return { stable: true, status, samples: consecutive, attempts: attempt };
    if (attempt < maximum) await sleep(delayMs);
  }
  return { stable: false, status, samples: consecutive, attempts: maximum };
}

function stableIdentity(status) {
  if (Number.isInteger(status?.pid) && status.pid > 0) return `pid:${status.pid}`;
  if (typeof status?.last_run_time === "string" && status.last_run_time) return `run:${status.last_run_time}`;
  return null;
}

export async function waitForInactiveStatus(
  readStatus,
  { attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, sleep = delay } = {},
) {
  return waitForStatus(readStatus, (status) => status?.active === false, { attempts, delayMs, sleep });
}

export async function waitForStatus(
  readStatus,
  predicate,
  { attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, sleep = delay } = {},
) {
  if (typeof readStatus !== "function") throw new TypeError("readStatus must be a function");
  if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
  const maximum = Number.isInteger(attempts) && attempts > 0 ? attempts : DEFAULT_ATTEMPTS;
  let status = await readStatus();
  for (let attempt = 1; !predicate(status) && attempt < maximum; attempt += 1) {
    await sleep(delayMs);
    status = await readStatus();
  }
  return status;
}

function delay(milliseconds) {
  return new Promise(resolve => { setTimeout(resolve, milliseconds); });
}
const MAX_SERVICE_DEFINITION_BYTES = 256 * 1024;

export function snapshotServiceDefinition(file, label = "service definition") {
  try {
    return readBoundedRegularFileWithInfoSync(file, MAX_SERVICE_DEFINITION_BYTES, label, {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    }).identity;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return null;
    throw error;
  }
}

export function removeServiceDefinitionIfCurrent(file, expectedIdentity, label = "service definition") {
  if (!expectedIdentity) {
    try { lstatSync(file, { bigint: true }); return false; }
    catch (error) { if (error?.code === "ENOENT") return true; throw error; }
  }
  return unlinkRegularFileIfIdentitySync(file, expectedIdentity, label);
}
const SERVICE_ENVIRONMENT_SCHEMA = 1;

const MAX_SERVICE_ENVIRONMENT_BYTES = 64 * 1024;

const MAX_ENVIRONMENT_VALUE_BYTES = 16 * 1024;

const SERVICE_ENVIRONMENT_FILE = "service-environment.json";

export const SERVICE_NETWORK_ENVIRONMENT_KEYS = Object.freeze([
  "MBM_RELAY_PROXY",
  "MBM_RELAY_FALLBACK_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

export function serviceEnvironmentPath(stateRoot) {
  return path.join(path.resolve(String(stateRoot)), SERVICE_ENVIRONMENT_FILE);
}

export function captureServiceEnvironment(environment = process.env) {
  const captured = {};
  for (const key of SERVICE_NETWORK_ENVIRONMENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(environment, key)) continue;
    const value = environment[key];
    if (value === undefined || value === null) continue;
    captured[key] = validateEnvironmentValue(key, value);
  }
  return captured;
}

export function writeServiceEnvironment(stateRoot, environment = process.env, options = {}) {
  const file = serviceEnvironmentPath(stateRoot);
  const previousPayload = serviceEnvironmentIfPresent(file, options);
  const previous = previousPayload ? previousPayload.environment : {};
  const captured = captureServiceEnvironment(environment);
  const merged = { ...previous };
  for (const [key, value] of Object.entries(captured)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete merged[existing];
    }
    merged[key] = value;
  }
  const payload = {
    schemaVersion: SERVICE_ENVIRONMENT_SCHEMA,
    environment: merged,
    updatedAt: new Date().toISOString(),
  };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_SERVICE_ENVIRONMENT_BYTES) {
    throw new Error("service network environment exceeds the persistence limit");
  }
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
  return { path: file, keys: Object.keys(payload.environment).sort() };
}

export function loadServiceEnvironment(stateRoot, targetEnvironment = process.env, options = {}) {
  const file = serviceEnvironmentPath(stateRoot);
  const payload = serviceEnvironmentIfPresent(file, options);
  if (!payload) return { path: file, keys: [], loaded: false };
  const platform = String(options.platform || process.platform);
  const loaded = [];
  for (const [key, rawValue] of Object.entries(payload.environment)) {
    if (!SERVICE_NETWORK_ENVIRONMENT_KEYS.includes(key)) continue;
    if (hasEnvironmentKey(targetEnvironment, key, platform)) continue;
    targetEnvironment[key] = validateEnvironmentValue(key, rawValue);
    loaded.push(key);
  }
  return { path: file, keys: loaded.sort(), loaded: true };
}

export function serviceEnvironmentSummary(stateRoot, options = {}) {
  const file = serviceEnvironmentPath(stateRoot);
  const payload = serviceEnvironmentIfPresent(file, options);
  if (!payload) return { configured: false, keys: [] };
  return { configured: true, keys: Object.keys(payload.environment).sort() };
}

function serviceEnvironmentIfPresent(file, options = {}) {
  const inspect = options.inspectPathIfPresentSync || inspectPathIfPresentSync;
  const info = inspect(file, "service environment file");
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("service environment file must be a regular file and not a symbolic link");
  return parseServiceEnvironment(file);
}

function parseServiceEnvironment(file) {
  const content = readBoundedRegularFileSync(file, MAX_SERVICE_ENVIRONMENT_BYTES, "service environment file", { verifyPathIdentity: true, rejectMultipleLinks: true });
  let payload;
  try {
    payload = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new Error("service environment file is not valid JSON", { cause: error });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("service environment file must contain an object");
  }
  if (payload.schemaVersion !== SERVICE_ENVIRONMENT_SCHEMA) {
    throw new Error("service environment schema is obsolete; reinstall autostart");
  }
  if (!payload.environment || typeof payload.environment !== "object" || Array.isArray(payload.environment)) {
    throw new Error("service environment file has an invalid environment map");
  }
  for (const [key, value] of Object.entries(payload.environment)) {
    if (!SERVICE_NETWORK_ENVIRONMENT_KEYS.includes(key)) {
      throw new Error("service environment file contains an unsupported key");
    }
    validateEnvironmentValue(key, value);
  }
  return payload;
}

function validateEnvironmentValue(key, value) {
  if (typeof value !== "string") throw new Error(`service environment value ${key} must be a string`);
  if (value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error(`service environment value ${key} contains a prohibited control character`);
  }
  if (Buffer.byteLength(value) > MAX_ENVIRONMENT_VALUE_BYTES) {
    throw new Error(`service environment value ${key} exceeds the size limit`);
  }
  return value;
}

function hasEnvironmentKey(environment, key, platform) {
  if (Object.prototype.hasOwnProperty.call(environment, key)) return true;
  if (platform !== "win32") return false;
  const wanted = key.toLowerCase();
  return Object.keys(environment).some(existing => existing.toLowerCase() === wanted);
}
export async function stopAndRemoveAutostart({
  states = [],
  stateRoot,
  logger = console,
  reason = "service uninstall",
  stopAutostart,
  uninstallAutostart,
  stopWorkspaceServiceDaemon,
} = {}) {
  assertFunction(stopAutostart, "stopAutostart");
  assertFunction(uninstallAutostart, "uninstallAutostart");
  assertFunction(stopWorkspaceServiceDaemon, "stopWorkspaceServiceDaemon");

  const platformStop = await stopAutostart({ logger });
  if (platformStop?.ok !== true) {
    return {
      ok: false,
      removed: false,
      reason: "platform_stop_failed",
      platform_stop: platformStop,
      workspace_daemons: [],
      removal: null,
    };
  }

  const workspaceDaemons = [];
  for (const state of states) {
    const result = await stopWorkspaceServiceDaemon(state, { logger, reason });
    workspaceDaemons.push({ workspace: state?.workspace?.path || null, ...result });
    if (result.found && !result.ok) {
      return {
        ok: false,
        removed: false,
        reason: "workspace_daemon_stop_failed",
        platform_stop: platformStop,
        workspace_daemons: workspaceDaemons,
        removal: null,
      };
    }
  }

  const removal = await uninstallAutostart({ stateRoot, logger });
  const removed = removal?.ok === true;
  return {
    ok: removed,
    removed,
    reason: removed ? "removed" : "platform_remove_failed",
    platform_stop: platformStop,
    workspace_daemons: workspaceDaemons,
    removal,
  };
}

function assertFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
}
const SYSTEMD_STATES = new Set(["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "unknown"]);

export const LAUNCHD_MISSING_SERVICE_CODE = 113;

export function launchdStatusSummary({ installed, definition, result }) {
  const detail = String(result?.stdout || "");
  const queryCode = Number(result?.code);
  const loaded = queryCode === 0;
  const missing = queryCode === LAUNCHD_MISSING_SERVICE_CODE;
  const statusAvailable = loaded || missing;
  const state = loaded ? launchdField(detail, "state") || "loaded" : missing ? "inactive" : "unknown";
  const pid = loaded ? positiveMatch(detail, /\bpid = (\d+)/) : null;
  return {
    ok: Boolean(installed),
    provider: "launchd",
    installed: Boolean(installed),
    definition: String(definition || ""),
    loaded,
    active: statusAvailable ? loaded && (pid !== null || state === "running") : null,
    state,
    status_available: statusAvailable,
    status_query_code: Number.isInteger(queryCode) ? queryCode : null,
    pid,
    runs: loaded ? positiveMatch(detail, /\bruns = (\d+)/) : null,
    last_termination_signal: loaded ? textMatch(detail, /\blast terminating signal = ([^\n]+)/) : null,
  };
}

export function systemdStatusSummary({ installed, definition, result }) {
  const firstLine = String(result?.stdout || "").split(/\r?\n/, 1)[0].trim().toLowerCase();
  const statusAvailable = SYSTEMD_STATES.has(firstLine);
  const state = statusAvailable ? firstLine : "unknown";
  const safelyAbsent = statusAvailable && state === "unknown" && !installed;
  const safelyInactive = statusAvailable && ["inactive", "failed"].includes(state);
  const active = state === "active" ? true : safelyInactive || safelyAbsent ? false : null;
  const queryCode = Number(result?.code);
  return {
    ok: Boolean(installed),
    provider: "systemd",
    installed: Boolean(installed),
    definition: String(definition || ""),
    active,
    state,
    status_available: statusAvailable,
    status_query_code: Number.isInteger(queryCode) ? queryCode : null,
  };
}

function launchdField(value, field) {
  const escaped = String(field || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return textMatch(value, new RegExp(`\\b${escaped} = ([^\\n]+)`));
}

function textMatch(value, pattern) {
  return pattern.exec(String(value || ""))?.[1]?.trim() || null;
}

function positiveMatch(value, pattern) {
  const parsed = Number(textMatch(value, pattern));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
