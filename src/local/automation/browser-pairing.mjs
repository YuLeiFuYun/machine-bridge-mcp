import { createServer } from "node:http";
import { pairingHtml, securityHeaders, createBrowserPairingGrant } from "./browser-broker.mjs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createExclusiveFileSync, replaceFileAtomicallySync, readExclusivePublicationFileSync } from "../core/exclusive-file.mjs";
import { ensureOwnerOnlyDir, inspectPathIfPresentSync, ownerOnlyFile } from "../core/secure-file.mjs";
import { assertStateMaintenanceAvailable } from "../state/state.mjs";

const LAUNCH_TTL_MS = 30_000;

export async function startBrowserPairingLaunch({ brokerPort, extensionToken, timeoutMs = LAUNCH_TTL_MS, serverFactory = createServer } = {}) {
  const targetPort = brokerPort;
  if (!Number.isSafeInteger(targetPort) || targetPort < 1024 || targetPort > 65535) throw new Error("browser pairing broker port is invalid");
  const grant = createBrowserPairingGrant(extensionToken, targetPort);
  const ttl = timeoutMs;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > LAUNCH_TTL_MS) throw new Error("browser pairing launch timeout is invalid");

  let listenerPort = 0;
  let closed = false;
  let timer;
  let resolveClosed;
  const closedPromise = new Promise((resolvePromise) => { resolveClosed = resolvePromise; });
  const server = serverFactory((request, response) => {
    const host = String(request.headers.host || "");
    if (!listenerPort || host.toLowerCase() !== `127.0.0.1:${listenerPort}`) {
      response.writeHead(403, securityHeaders("text/plain; charset=utf-8")).end("forbidden\n");
      return;
    }
    let url;
    try { url = new URL(request.url || "/", `http://${host}`); }
    catch { response.writeHead(400, securityHeaders("text/plain; charset=utf-8")).end("bad request\n"); return; }
    if (request.method !== "GET" || url.pathname !== "/pair" || url.search) {
      response.writeHead(404, securityHeaders("text/plain; charset=utf-8")).end("not found\n");
      return;
    }
    const html = pairingHtml(targetPort);
    response.writeHead(200, { ...securityHeaders("text/html; charset=utf-8"), "content-length": Buffer.byteLength(html) });
    response.end(html, () => close());
  });

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    try { server.close(() => resolveClosed()); } catch { resolveClosed(); }
  };
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => { server.off("listening", onListening); rejectPromise(error); };
    const onListening = () => { server.off("error", onError); resolvePromise(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  server.on("error", close);
  const address = server.address();
  if (!address || typeof address === "string") { close(); throw new Error("browser pairing launch listener address is unavailable"); }
  listenerPort = address.port;
  timer = setTimeout(close, ttl);
  timer.unref?.();
  const fragment = new URLSearchParams({ broker_port: String(targetPort), grant: String(grant) }).toString();
  return { url: `http://127.0.0.1:${listenerPort}/pair#${fragment}`, close, closed: closedPromise, listenerPort, brokerPort: targetPort };
}
const DEFAULT_BROWSER_PORT = 39393;

const PAIRING_FILE = "browser-bridge.json";

const PAIRING_SCHEMA_VERSION = 3;

const PREVIOUS_PAIRING_SCHEMA_VERSION = 2;

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
    const current = readPairingForUpgrade(file);
    assertStateMaintenanceAvailable(stateRoot); return current.current ? current.value : migratePreviousPairing(file);
  }
  assertStateMaintenanceAvailable(stateRoot);
  const value = newPairing(DEFAULT_BROWSER_PORT);
  try {
    createExclusiveFileSync(file, pairingJson(value), { mode: 0o600 });
    ownerOnlyFile(file);
    return value;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const current = readPairingForUpgrade(file);
    assertStateMaintenanceAvailable(stateRoot); return current.current ? current.value : migratePreviousPairing(file);
  }
}

export async function savePairing(stateRoot, value) {
  assertStateMaintenanceAvailable(stateRoot);
  const normalized = normalizePairing(value);
  const file = join(stateRoot, PAIRING_FILE);
  replaceFileAtomicallySync(file, pairingJson(normalized), { mode: 0o600 }); ownerOnlyFile(file);
}

export function rotateBrowserPairing(stateRoot) {
  ensureOwnerOnlyDir(stateRoot);
  const file = join(stateRoot, PAIRING_FILE);
  const existing = inspectPathIfPresentSync(file, "browser pairing state");
  if (!existing || existing.isSymbolicLink() || !existing.isFile()) throw new Error("browser pairing state is unavailable for credential rotation");
  const current = readPairing(file);
  assertStateMaintenanceAvailable(stateRoot);
  const rotated = newPairing(current.port);
  replaceFileAtomicallySync(file, pairingJson(rotated), { mode: 0o600 }); ownerOnlyFile(file);
  return { port: rotated.port };
}

export function readBrowserPairing(stateRoot, options = {}) { return readBrowserPairingEntry(stateRoot, options); }

export function readBrowserPairingPort(stateRoot, options = {}) { return readBrowserPairingEntry(stateRoot, options)?.port ?? null; }

function readBrowserPairingEntry(stateRoot, options) {
  const file = join(stateRoot, PAIRING_FILE); const inspect = options.inspectPathIfPresentSync || inspectPathIfPresentSync;
  const existing = inspect(file, "browser pairing state");
  if (!existing) return null; if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("browser pairing state must be a regular file and not a symbolic link");
  return readPairing(file);
}

function readPairing(file) { return normalizePairing(readPairingJson(file)); }

function readPairingForUpgrade(file) {
  const parsed = readPairingJson(file);
  if (isPreviousStablePairing(parsed)) {
    return { current: false, value: {
      schemaVersion: PAIRING_SCHEMA_VERSION, pairingAuthVersion: PAIRING_AUTH_VERSION, extensionToken: parsed.extensionToken,
      runtimeToken: parsed.runtimeToken, port: parsed.port,
    } };
  }
  if (isPreviousPendingPairing(parsed)) throw new Error("browser pairing state upgrade is incomplete; complete beta.198 browser pairing migration before upgrading");
  return { current: true, value: normalizePairing(parsed) };
}

function migratePreviousPairing(file) {
  const latest = readPairingForUpgrade(file);
  if (latest.current) return latest.value;
  replaceFileAtomicallySync(file, pairingJson(latest.value), { mode: 0o600 });
  ownerOnlyFile(file); return readPairing(file);
}

function readPairingJson(file) {
  let parsed;
  try { parsed = JSON.parse(readExclusivePublicationFileSync(file, 64 * 1024, "browser pairing state", { ownerPrivate: true }).toString("utf8")); }
  catch { throw new Error("browser pairing state is not valid bounded JSON"); } return parsed;
}

function normalizePairing(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !sameKeys(value, ["schemaVersion", "pairingAuthVersion", "extensionToken", "runtimeToken", "port"])
      || value.schemaVersion !== PAIRING_SCHEMA_VERSION || value.pairingAuthVersion !== PAIRING_AUTH_VERSION || !validToken(value.extensionToken)
      || !validToken(value.runtimeToken) || value.extensionToken === value.runtimeToken || !validPort(value.port)) {
    throw new Error("browser pairing state is invalid");
  }
  return { schemaVersion: PAIRING_SCHEMA_VERSION, pairingAuthVersion: PAIRING_AUTH_VERSION, extensionToken: value.extensionToken, runtimeToken: value.runtimeToken, port: value.port };
}

function isPreviousStablePairing(value) { return isPreviousPairing(value) && value.migrationPending === false; }

function isPreviousPendingPairing(value) { return isPreviousPairing(value) && value.migrationPending === true; }

function isPreviousPairing(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && sameKeys(value, ["schemaVersion", "pairingAuthVersion", "extensionToken", "runtimeToken", "port", "migrationPending"])
    && value.schemaVersion === PREVIOUS_PAIRING_SCHEMA_VERSION && value.pairingAuthVersion === PAIRING_AUTH_VERSION
    && typeof value.migrationPending === "boolean" && validToken(value.extensionToken) && validToken(value.runtimeToken)
    && value.extensionToken !== value.runtimeToken && validPort(value.port));
}

function newPairing(port) { return { schemaVersion: PAIRING_SCHEMA_VERSION, pairingAuthVersion: PAIRING_AUTH_VERSION, extensionToken: token(), runtimeToken: token(), port }; }

function token() { return randomBytes(32).toString("base64url"); }

function validToken(value) { return typeof value === "string" && TOKEN_PATTERN.test(value); }

function validPort(value) { return Number.isInteger(value) && value >= 1024 && value <= 65535; }

function sameKeys(value, expected) { return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"); }

function pairingJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
