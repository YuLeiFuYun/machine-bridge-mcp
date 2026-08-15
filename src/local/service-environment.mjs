import path from "node:path";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { inspectPathIfPresentSync, readBoundedRegularFileSync } from "./secure-file.mjs";

const SERVICE_ENVIRONMENT_SCHEMA = 1;
const MAX_SERVICE_ENVIRONMENT_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 16 * 1024;
const SERVICE_ENVIRONMENT_FILE = "service-environment.json";

export const SERVICE_NETWORK_ENVIRONMENT_KEYS = Object.freeze([
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
  const text = String(value);
  if (text.includes("\0") || /[\r\n]/.test(text)) {
    throw new Error(`service environment value ${key} contains a prohibited control character`);
  }
  if (Buffer.byteLength(text) > MAX_ENVIRONMENT_VALUE_BYTES) {
    throw new Error(`service environment value ${key} exceeds the size limit`);
  }
  return text;
}

function hasEnvironmentKey(environment, key, platform) {
  if (Object.prototype.hasOwnProperty.call(environment, key)) return true;
  if (platform !== "win32") return false;
  const wanted = key.toLowerCase();
  return Object.keys(environment).some(existing => existing.toLowerCase() === wanted);
}
