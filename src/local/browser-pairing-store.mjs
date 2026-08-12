import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { inspectPathIfPresentSync, readBoundedRegularFileSync, retryTransientMultipleLinksSync } from "./secure-file.mjs";
import { acquireMaintenanceLock, assertStateMaintenanceAvailable } from "./state.mjs";
import { ensureOwnerOnlyDir, ownerOnlyFile } from "./secure-file.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";

const DEFAULT_BROWSER_PORT = 39393;
const PAIRING_FILE = "browser-bridge.json";
const PAIRING_SCHEMA_VERSION = 2;
const PAIRING_AUTH_VERSION = 2;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,100}$/;

export async function loadOrCreatePairing(stateRoot, options = {}) {
  if (!stateRoot) return newPairing(DEFAULT_BROWSER_PORT);
  ensureOwnerOnlyDir(stateRoot);
  const file = join(stateRoot, PAIRING_FILE);
  const inspect = options.inspectPathIfPresentSync || inspectPathIfPresentSync;
  const existing = inspect(file, "browser pairing state");
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("browser pairing state must be a regular file and not a symbolic link");
    const current = readPublishedPairing(file);
    if (!current.requiresMigration) { assertStateMaintenanceAvailable(stateRoot); return current.value; }
    return migratePreviousPairing(stateRoot, file);
  }
  assertStateMaintenanceAvailable(stateRoot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const value = newPairing(DEFAULT_BROWSER_PORT);
    try {
      createExclusiveFileSync(file, pairingJson(value), { mode: 0o600 });
      ownerOnlyFile(file);
      return value;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const created = readPublishedPairing(file);
      if (!created.requiresMigration) return created.value;
    }
  }
  return migratePreviousPairing(stateRoot, file);
}

export async function savePairing(stateRoot, value) {
  assertStateMaintenanceAvailable(stateRoot);
  const normalized = normalizePairing(value);
  const file = join(stateRoot, PAIRING_FILE);
  replaceFileAtomicallySync(file, pairingJson(normalized), { mode: 0o600 });
  ownerOnlyFile(file);
}

export function readBrowserPairing(stateRoot, options = {}) {
  const current = readBrowserPairingEntry(stateRoot, options); if (!current) return null;
  if (current.requiresMigration) throw new Error("browser pairing state requires migration before pairing"); return current.value;
}
export function readBrowserPairingPort(stateRoot, options = {}) { return readBrowserPairingEntry(stateRoot, options)?.value.port ?? null; }
function readBrowserPairingEntry(stateRoot, options) {
  const file = join(stateRoot, PAIRING_FILE); const inspect = options.inspectPathIfPresentSync || inspectPathIfPresentSync;
  const existing = inspect(file, "browser pairing state");
  if (!existing) return null; if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("browser pairing state must be a regular file and not a symbolic link");
  return readPublishedPairing(file);
}

async function migratePreviousPairing(stateRoot, file) {
  const lock = await acquirePairingMigrationLock(stateRoot);
  try {
    const current = readPublishedPairing(file);
    if (!current.requiresMigration) return current.value;
    const value = { schemaVersion: PAIRING_SCHEMA_VERSION, pairingAuthVersion: PAIRING_AUTH_VERSION, extensionToken: token(), runtimeToken: current.value.runtimeToken || token(), port: current.value.port, migrationPending: true };
    replaceFileAtomicallySync(file, pairingJson(value), { mode: 0o600 });
    ownerOnlyFile(file);
    return value;
  } finally { lock.release(); }
}

async function acquirePairingMigrationLock(stateRoot) {
  const deadline = createMonotonicDeadline(5_000);
  do {
    const lock = acquireMaintenanceLock(stateRoot, { operation: "browser-pairing-migration" });
    if (lock.acquired) return lock;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, Math.min(50, Math.max(1, deadline.remainingMs()))); });
  } while (!deadline.expired());
  throw new Error("browser pairing migration could not acquire the state maintenance lock");
}

function readPublishedPairing(file) {
  return retryTransientMultipleLinksSync(() => readPairing(file));
}

function readPairing(file) {
  ownerOnlyFile(file);
  let parsed;
  try { parsed = JSON.parse(readBoundedRegularFileSync(file, 64 * 1024, "browser pairing state", { verifyPathIdentity: true, rejectMultipleLinks: true }).toString("utf8")); }
  catch { throw new Error("browser pairing state is not valid bounded JSON"); }
  if (parsed?.schemaVersion === PAIRING_SCHEMA_VERSION && parsed?.pairingAuthVersion === PAIRING_AUTH_VERSION) {
    return { requiresMigration: false, value: normalizePairing(parsed) };
  }
  if (parsed?.schemaVersion === PAIRING_SCHEMA_VERSION && parsed?.pairingAuthVersion === undefined
      && TOKEN_PATTERN.test(String(parsed?.extensionToken || ""))
      && TOKEN_PATTERN.test(String(parsed?.runtimeToken || "")) && parsed.extensionToken !== parsed.runtimeToken && validPort(parsed?.port)) {
    return { requiresMigration: true, value: { extensionToken: parsed.extensionToken, runtimeToken: parsed.runtimeToken, port: Number(parsed.port) } };
  }
  if (TOKEN_PATTERN.test(String(parsed?.token || "")) && validPort(parsed?.port)) {
    return { requiresMigration: true, value: { extensionToken: parsed.token, runtimeToken: "", port: Number(parsed.port) } };
  }
  throw new Error("browser pairing state is invalid");
}

function normalizePairing(value) {
  if (value?.schemaVersion !== PAIRING_SCHEMA_VERSION || value?.pairingAuthVersion !== PAIRING_AUTH_VERSION || !TOKEN_PATTERN.test(String(value.extensionToken || ""))
      || !TOKEN_PATTERN.test(String(value.runtimeToken || "")) || value.extensionToken === value.runtimeToken || !validPort(value.port)
      || typeof value.migrationPending !== "boolean") {
    throw new Error("browser pairing state is invalid");
  }
  return { schemaVersion: PAIRING_SCHEMA_VERSION, pairingAuthVersion: PAIRING_AUTH_VERSION, extensionToken: String(value.extensionToken), runtimeToken: String(value.runtimeToken), port: Number(value.port), migrationPending: value.migrationPending };
}
function newPairing(port) { return { schemaVersion: PAIRING_SCHEMA_VERSION, pairingAuthVersion: PAIRING_AUTH_VERSION, extensionToken: token(), runtimeToken: token(), port, migrationPending: false }; }
function token() { return randomBytes(32).toString("base64url"); }
function validPort(value) { return Number.isInteger(Number(value)) && Number(value) >= 1024 && Number(value) <= 65535; }
function pairingJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
