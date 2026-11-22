import { EXPECTED_EXTENSION_ID, normalizeExtensionId } from "./browser-commands.mjs";
import { EXPECTED_EXTENSION_VERSION } from "./browser-extension-protocol.mjs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createMonotonicDeadline } from "../core/timing.mjs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export function pairingHtml(port) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="machine-bridge-browser-pair" content="1"><meta name="machine-bridge-browser-port" content="${port}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Machine Bridge browser pairing</title></head><body><h1>Machine Bridge browser pairing</h1><p>Expected extension build: <strong>${EXPECTED_EXTENSION_VERSION}</strong>.</p><p>Expected extension ID: <code>${EXPECTED_EXTENSION_ID}</code>.</p><p>Reload the unpacked extension after every Machine Bridge upgrade.</p><p>Pairing credentials are never embedded in this HTTP page. Run pair_browser_extension with opening enabled to create a short-lived extension bootstrap.</p><p><button id="pair" type="button" disabled>Pair this browser extension</button></p><p id="status">Pairing requires an explicit confirmation on this page or the Machine Bridge extension icon.</p></body></html>`;
}

export function isAllowedExtensionOrigin(origin, expectedExtensionId = EXPECTED_EXTENSION_ID) {
  const expected = normalizeExtensionId(expectedExtensionId);
  if (!expected || typeof origin !== "string") return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  return parsed.protocol === "chrome-extension:" && parsed.hostname === expected
    && !parsed.username && !parsed.password && !parsed.port
    && (parsed.pathname === "" || parsed.pathname === "/") && !parsed.search && !parsed.hash;
}

export function isAllowedLoopbackHost(host, port) {
  const normalized = String(host || "").toLowerCase();
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}` || normalized === `[::1]:${port}`;
}

export function securityHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

export function sendJson(response, value) {
  response.writeHead(200, securityHeaders("application/json; charset=utf-8"));
  response.end(`${JSON.stringify(value)}\n`);
}
export function handleBrowserBridgeHttp(request, response, {
  port,
  extensionConnected,
  extensionStatusInfo,
  extensionReloadRequired,
}) {
  const host = String(request.headers.host || "");
  if (!isAllowedLoopbackHost(host, port)) {
    response.writeHead(403, securityHeaders("text/plain; charset=utf-8"));
    response.end("Forbidden\n");
    return;
  }
  const url = new URL(request.url || "/", `http://${host}`);
  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET", "cache-control": "no-store" }).end();
    return;
  }
  if (url.pathname === "/healthz") {
    const extension = extensionStatusInfo();
    sendJson(response, {
      ok: true,
      connected: extensionConnected(),
      broker: "machine-bridge-browser",
      expected_extension_version: EXPECTED_EXTENSION_VERSION,
      expected_extension_id: EXPECTED_EXTENSION_ID,
      extension_id: extension?.extension_id || "",
      extension_protocol: extension?.protocol || null,
      extension_version: extension?.version || "",
      extension_capabilities: extension?.capabilities || [],
      extension_reload_required: extensionReloadRequired(),
      controls_existing_profile: true,
      controls_extension_profile: true,
      machine_bridge_launches_browser: false,
      profile_identity_verifiable: false,
    });
    return;
  }
  if (url.pathname === "/pair") {
    const html = pairingHtml(port);
    response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
    response.end(html);
    return;
  }
  response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
  response.end("Not found\n");
}
const CHALLENGE = /^[A-Za-z0-9_-]{32}$/;

const PROOF = /^[A-Za-z0-9_-]{43}$/;

const TOKEN = /^[A-Za-z0-9_-]{32,100}$/;

const AUTH_TTL_MS = 5_000;

const MAX_PENDING_AUTH = 64;

const ROLES = new Set(["extension", "runtime"]);

export const BROKER_AUTH_REQUEST_HEADER = "x-machine-bridge-broker-auth";

export const BROKER_AUTH_REQUEST_VALUE = "machine-bridge-browser-v2";

export function createBrokerAuthChallenge() {
  return randomBytes(24).toString("base64url");
}

export function createBrokerInitProof(token, role, clientChallenge) {
  assertToken(token); assertRole(role);
  if (typeof clientChallenge !== "string" || !CHALLENGE.test(clientChallenge)) throw new Error("browser broker authentication challenge is invalid");
  return hmac(token, `machine-bridge-browser-${role}-init-v2\0${clientChallenge}`);
}

export function createBrokerServerProof(token, role, clientChallenge, serverNonce) {
  return authProof(token, role, "server", clientChallenge, serverNonce);
}

export function verifyBrokerServerProof(token, role, clientChallenge, serverNonce, proof) {
  if (typeof proof !== "string" || !PROOF.test(proof)) return false;
  return safeEqual(createBrokerServerProof(token, role, clientChallenge, serverNonce), proof);
}

export function createBrokerClientProtocol(token, role, clientChallenge, serverNonce) {
  assertRole(role);
  const proof = authProof(token, role, "client", clientChallenge, serverNonce);
  return `mbm-${role}-v2.${clientChallenge}.${serverNonce}.${proof}`;
}

export function createBrokerAuthRegistry(token, role, options = {}) {
  assertToken(token);
  assertRole(role);
  const now = typeof options.now === "function" ? options.now : undefined;
  const pending = new Map();
  return {
    issue(clientChallenge, initProof) {
      if (typeof clientChallenge !== "string" || typeof initProof !== "string" || !CHALLENGE.test(clientChallenge) || !PROOF.test(initProof)) return null;
      if (!safeEqual(createBrokerInitProof(token, role, clientChallenge), initProof)) return null;
      prunePending(pending);
      const existing = pending.get(clientChallenge);
      if (existing && !existing.deadline.expired()) {
        return { serverNonce: existing.serverNonce, serverProof: createBrokerServerProof(token, role, clientChallenge, existing.serverNonce) };
      }
      while (pending.size >= MAX_PENDING_AUTH) pending.delete(pending.keys().next().value);
      const serverNonce = createBrokerAuthChallenge();
      pending.set(clientChallenge, { serverNonce, deadline: createMonotonicDeadline(AUTH_TTL_MS, now) });
      return { serverNonce, serverProof: createBrokerServerProof(token, role, clientChallenge, serverNonce) };
    },
    consume(protocol) {
      const parsed = parseBrokerProtocol(protocol, role);
      if (!parsed) return false;
      const issued = pending.get(parsed.clientChallenge);
      pending.delete(parsed.clientChallenge);
      if (!issued || issued.deadline.expired() || issued.serverNonce !== parsed.serverNonce) return false;
      return safeEqual(createBrokerClientProtocol(token, role, parsed.clientChallenge, parsed.serverNonce), protocol);
    },
  };
}

export function parseBrokerAuthResponse(headers) {
  const serverNonce = String(headers?.get?.("x-machine-bridge-broker-nonce") || "");
  const serverProof = String(headers?.get?.("x-machine-bridge-broker-proof") || "");
  return CHALLENGE.test(serverNonce) && PROOF.test(serverProof) ? { serverNonce, serverProof } : null;
}

function parseBrokerProtocol(value, role) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== `mbm-${role}-v2`) return null;
  const [, clientChallenge, serverNonce, proof] = parts;
  if (!CHALLENGE.test(clientChallenge) || !CHALLENGE.test(serverNonce) || !PROOF.test(proof)) return null;
  return { clientChallenge, serverNonce };
}

function authProof(token, role, direction, clientChallenge, serverNonce) {
  assertToken(token); assertRole(role);
  if (typeof clientChallenge !== "string" || typeof serverNonce !== "string" || !CHALLENGE.test(clientChallenge) || !CHALLENGE.test(serverNonce)) {
    throw new Error("browser broker authentication challenge is invalid");
  }
  return hmac(token, `machine-bridge-browser-${role}-${direction}-v2\0${clientChallenge}\0${serverNonce}`);
}

function hmac(token, message) { return createHmac("sha256", token).update(message).digest("base64url"); }

function assertToken(value) { if (typeof value !== "string" || !TOKEN.test(value)) throw new Error("browser broker credential is invalid"); }

function assertRole(value) { if (!ROLES.has(value)) throw new Error("browser broker authentication role is invalid"); }

function safeEqual(left, right) { if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function prunePending(pending) { for (const [key, issued] of pending) if (issued.deadline.expired()) pending.delete(key); }
const GRANT = /^(\d{13})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

const GRANT_ID = /^(\d{13})\.([A-Za-z0-9_-]{22})$/;

const PAIRING_GRANT_TTL_MS = 30_000;

const EXCHANGE_TTL_MS = 5_000;

const MAX_PENDING = 32;

export function createBrowserPairingGrant(extensionToken, port, now = Date.now()) {
  assertGrantToken(extensionToken);
  if (!validClock(now)) throw new Error("browser pairing grant time is invalid");
  const expiresAt = now + PAIRING_GRANT_TTL_MS;
  if (!/^\d{13}$/.test(String(expiresAt))) throw new Error("browser pairing grant time is invalid");
  const nonce = randomBytes(16).toString("base64url");
  const proof = grantSecret(extensionToken, port, expiresAt, nonce);
  return `${expiresAt}.${nonce}.${proof}`;
}

export function parseBrowserPairingGrant(grant, now = Date.now()) {
  const match = exact(GRANT, grant) ? GRANT.exec(grant) : null;
  if (!match || !validClock(now)) return null;
  const expiresAt = Number(match[1]);
  if (expiresAt < now || expiresAt - now > PAIRING_GRANT_TTL_MS) return null;
  return { id: `${match[1]}.${match[2]}`, secret: match[3], expiresAt };
}

export function createPairingBootstrapRegistry(extensionToken, port, options = {}) {
  assertGrantToken(extensionToken);
  const wallNow = typeof options.wallNow === "function" ? options.wallNow : Date.now;
  const monotonicNow = typeof options.monotonicNow === "function" ? options.monotonicNow : undefined;
  const pending = new Map();
  const used = new Map();
  return {
    issue(grantId, clientChallenge, initProof) {
      const now = wallNow();
      if (!validClock(now)) return null;
      prune(used, pending, now);
      const grant = grantFromId(extensionToken, port, grantId, now);
      if (!grant || used.has(grant.id) || !exact(CHALLENGE, clientChallenge) || !exact(PROOF, initProof)) return null;
      if (!safeEqual(bootstrapInitProof(grant.secret, grant.id, clientChallenge), initProof)) return null;
      const existing = pending.get(grant.id);
      if (existing && !existing.deadline.expired()) return existing.clientChallenge === clientChallenge ? { serverNonce: existing.serverNonce, serverProof: bootstrapProof(grant.secret, "server", grant.id, clientChallenge, existing.serverNonce) } : null;
      if (used.size + pending.size >= MAX_PENDING) return null;
      const serverNonce = createBrokerAuthChallenge();
      pending.set(grant.id, { clientChallenge, serverNonce, deadline: createMonotonicDeadline(EXCHANGE_TTL_MS, monotonicNow) });
      return { serverNonce, serverProof: bootstrapProof(grant.secret, "server", grant.id, clientChallenge, serverNonce) };
    },
    consume(grantId, clientChallenge, serverNonce, clientProof) {
      const now = wallNow();
      if (!validClock(now)) return false;
      prune(used, pending, now);
      const grant = grantFromId(extensionToken, port, grantId, now);
      if (!grant || used.has(grant.id) || !exact(CHALLENGE, clientChallenge)
          || !exact(CHALLENGE, serverNonce) || !exact(PROOF, clientProof)) return false;
      const current = pending.get(grant.id);
      if (!current || current.deadline.expired()
          || current.clientChallenge !== clientChallenge || current.serverNonce !== serverNonce) return false;
      const expected = bootstrapProof(grant.secret, "client", grant.id, clientChallenge, serverNonce);
      if (!safeEqual(expected, clientProof)) return false;
      pending.delete(grant.id);
      used.set(grant.id, grant.expiresAt);
      return true;
    },
  };
}

export function createPairingBootstrapInitProof(grantSecret, grantId, clientChallenge) {
  if (!exact(PROOF, grantSecret) || !exact(GRANT_ID, grantId) || !exact(CHALLENGE, clientChallenge)) {
    throw new Error("browser pairing bootstrap init proof input is invalid");
  }
  return bootstrapInitProof(grantSecret, grantId, clientChallenge);
}

export function createPairingBootstrapProof(grantSecret, direction, grantId, clientChallenge, serverNonce) {
  if (!exact(PROOF, grantSecret) || (direction !== "server" && direction !== "client")
      || !exact(GRANT_ID, grantId) || !exact(CHALLENGE, clientChallenge) || !exact(CHALLENGE, serverNonce)) {
    throw new Error("browser pairing bootstrap proof input is invalid");
  }
  return bootstrapProof(grantSecret, direction, grantId, clientChallenge, serverNonce);
}

function grantFromId(token, port, grantId, now) {
  const match = exact(GRANT_ID, grantId) ? GRANT_ID.exec(grantId) : null;
  if (!match || !validClock(now)) return null;
  const expiresAt = Number(match[1]);
  if (expiresAt < now || expiresAt - now > PAIRING_GRANT_TTL_MS) return null;
  return { id: grantId, secret: grantSecret(token, port, expiresAt, match[2]), expiresAt };
}

function grantSecret(token, port, expiresAt, nonce) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("browser pairing grant port is invalid");
  return grantHmac(token, `machine-bridge-browser-pair-v2\0${port}\0${expiresAt}\0${nonce}`);
}

function bootstrapInitProof(secret, grantId, clientChallenge) { return grantHmac(secret, `machine-bridge-browser-pair-init-v2\0${grantId}\0${clientChallenge}`); }

function bootstrapProof(secret, direction, grantId, clientChallenge, serverNonce) { return grantHmac(secret, `machine-bridge-browser-pair-${direction}-v2\0${grantId}\0${clientChallenge}\0${serverNonce}`); }

function grantHmac(key, message) { return createHmac("sha256", key).update(message).digest("base64url"); }

function exact(pattern, value) { return typeof value === "string" && pattern.test(value); }

function validClock(value) { return Number.isSafeInteger(value) && value > 0; }

function assertGrantToken(value) { if (!exact(TOKEN, value)) throw new Error("browser broker credential is invalid"); }

function prune(used, pending, now) {
  for (const [id, expiresAt] of used) if (expiresAt < now) used.delete(id);
  for (const [id, entry] of pending) if (entry.deadline.expired()) pending.delete(id);
}
export function createBrowserBrokerAuthHttpHandler({ port, extensionToken, runtimeAuth, extensionAuth }) {
  const pairingAuth = createPairingBootstrapRegistry(extensionToken, port);
  return (request, response) => {
    const host = String(request.headers.host || "");
    if (!isAllowedLoopbackHost(host, port)) return false;
    const url = new URL(request.url || "/", `http://${host}`);
    if (url.pathname === "/pair-auth") {
      handlePairingAuth(request, response, url, pairingAuth, extensionToken);
      return true;
    }
    const auth = url.pathname === "/runtime-auth" ? runtimeAuth : url.pathname === "/extension-auth" ? extensionAuth : null;
    if (!auth) return false;
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET", "cache-control": "no-store" }).end();
      return true;
    }
    if (!hasAuthMarker(request)) {
      response.writeHead(403, { "cache-control": "no-store" }).end();
      return true;
    }
    const issued = auth.issue(url.searchParams.get("challenge"), url.searchParams.get("init"));
    if (!issued) {
      response.writeHead(400, { "cache-control": "no-store" }).end();
      return true;
    }
    response.writeHead(204, proofHeaders(issued)).end();
    return true;
  };
}

function handlePairingAuth(request, response, url, pairingAuth, extensionToken) {
  if (!hasAuthMarker(request)) {
    response.writeHead(403, { "cache-control": "no-store" }).end();
    return;
  }
  const grantId = url.searchParams.get("grant");
  const clientChallenge = url.searchParams.get("challenge");
  if (request.method === "GET") {
    const issued = pairingAuth.issue(grantId, clientChallenge, url.searchParams.get("init"));
    if (!issued) { response.writeHead(401, { "cache-control": "no-store" }).end(); return; }
    response.writeHead(204, proofHeaders(issued)).end();
    return;
  }
  if (request.method === "POST") {
    const ok = pairingAuth.consume(grantId, clientChallenge, url.searchParams.get("nonce"), url.searchParams.get("proof"));
    if (!ok) { response.writeHead(401, { "cache-control": "no-store" }).end(); return; }
    response.writeHead(204, { "cache-control": "no-store", "x-machine-bridge-extension-token": extensionToken }).end();
    return;
  }
  response.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" }).end();
}

function hasAuthMarker(request) {
  return request.headers[BROKER_AUTH_REQUEST_HEADER] === BROKER_AUTH_REQUEST_VALUE;
}

function proofHeaders(issued) {
  return {
    "cache-control": "no-store",
    "x-machine-bridge-broker-nonce": issued.serverNonce,
    "x-machine-bridge-broker-proof": issued.serverProof,
  };
}
export async function startBrowserBrokerServer({
  port, extensionToken, runtimeToken, maxPayload, onHttp, onSocket,
  serverFactory = createServer,
  WebSocketServerClass = WebSocketServer,
}) {
  const runtimeAuth = createBrokerAuthRegistry(runtimeToken, "runtime");
  const extensionAuth = createBrokerAuthRegistry(extensionToken, "extension");
  const handleAuthHttp = createBrowserBrokerAuthHttpHandler({ port, extensionToken, runtimeAuth, extensionAuth });
  const server = serverFactory((request, response) => {
    try {
      if (!handleAuthHttp(request, response)) onHttp(request, response);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(error?.code === "ERR_INVALID_URL" ? 400 : 500,
        securityHeaders("text/plain; charset=utf-8")).end();
    }
  });
  const wss = new WebSocketServerClass({ noServer: true, maxPayload });
  server.on("upgrade", (request, socket, head) => {
    try {
      const host = String(request.headers.host || "");
      if (!isAllowedLoopbackHost(host, port)) {
        rejectUpgrade(socket, "403 Forbidden");
        return;
      }
      const url = new URL(request.url || "/", `http://${host}`);
      const protocol = String(request.headers["sec-websocket-protocol"] || "");
      const origin = String(request.headers.origin || "");
      let role = "";
      if (url.pathname === "/extension" && isAllowedExtensionOrigin(origin, EXPECTED_EXTENSION_ID) && extensionAuth.consume(protocol)) role = "extension";
      if (url.pathname === "/runtime" && !origin && runtimeAuth.consume(protocol)) role = "runtime";
      if (!role) {
        rejectUpgrade(socket, "401 Unauthorized");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.bridgeRole = role;
        wss.emit("connection", ws, request);
      });
    } catch {
      socket.destroy();
    }
  });
  wss.on("connection", (ws) => onSocket(ws, ws.bridgeRole));
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      try { wss.close(); }
      catch { /* Startup failure already owns the result; closing an unopened/half-open WebSocket server is best-effort. */ }
      try { server.close(); }
      catch { /* Startup failure already owns the result; closing an unopened/half-open HTTP server is best-effort. */ }
      rejectPromise(error);
    };
    const onListening = () => {
      cleanup();
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  return { server, wss };
}

function rejectUpgrade(socket, status) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
