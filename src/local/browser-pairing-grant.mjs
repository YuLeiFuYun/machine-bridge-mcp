import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { createBrokerAuthChallenge } from "./browser-broker-auth.mjs";

const GRANT = /^(\d{13})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const GRANT_ID = /^(\d{13})\.([A-Za-z0-9_-]{22})$/;
const CHALLENGE = /^[A-Za-z0-9_-]{32}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,100}$/;
const PAIRING_GRANT_TTL_MS = 30_000;
const EXCHANGE_TTL_MS = 5_000;
const MAX_PENDING = 32;

export function createBrowserPairingGrant(extensionToken, port, now = Date.now()) {
  assertToken(extensionToken);
  const expiresAt = Number(now) + PAIRING_GRANT_TTL_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error("browser pairing grant time is invalid");
  const nonce = randomBytes(16).toString("base64url");
  const proof = grantSecret(extensionToken, port, expiresAt, nonce);
  return `${expiresAt}.${nonce}.${proof}`;
}

export function parseBrowserPairingGrant(grant, now = Date.now()) {
  const match = GRANT.exec(String(grant || ""));
  if (!match) return null;
  const expiresAt = Number(match[1]);
  const current = Number(now);
  if (!Number.isFinite(current) || expiresAt < current || expiresAt - current > PAIRING_GRANT_TTL_MS) return null;
  return { id: `${match[1]}.${match[2]}`, secret: match[3], expiresAt };
}

export function createPairingBootstrapRegistry(extensionToken, port, options = {}) {
  assertToken(extensionToken);
  const wallNow = typeof options.wallNow === "function" ? options.wallNow : Date.now;
  const monotonicNow = typeof options.monotonicNow === "function" ? options.monotonicNow : undefined;
  const pending = new Map();
  const used = new Map();
  return {
    issue(grantId, clientChallenge, initProof) {
      prune(used, pending, wallNow());
      const grant = grantFromId(extensionToken, port, grantId, wallNow());
      if (!grant || used.has(grant.id) || !CHALLENGE.test(String(clientChallenge || "")) || !PROOF.test(String(initProof || ""))) return null;
      if (!safeEqual(bootstrapInitProof(grant.secret, grant.id, clientChallenge), initProof)) return null;
      const existing = pending.get(grant.id);
      if (existing && !existing.deadline.expired()) return existing.clientChallenge === clientChallenge ? { serverNonce: existing.serverNonce, serverProof: bootstrapProof(grant.secret, "server", grant.id, clientChallenge, existing.serverNonce) } : null;
      if (used.size + pending.size >= MAX_PENDING) return null;
      const serverNonce = createBrokerAuthChallenge();
      pending.set(grant.id, { clientChallenge, serverNonce, deadline: createMonotonicDeadline(EXCHANGE_TTL_MS, monotonicNow) });
      return { serverNonce, serverProof: bootstrapProof(grant.secret, "server", grant.id, clientChallenge, serverNonce) };
    },
    consume(grantId, clientChallenge, serverNonce, clientProof) {
      prune(used, pending, wallNow());
      const grant = grantFromId(extensionToken, port, grantId, wallNow());
      if (!grant || used.has(grant.id) || !PROOF.test(String(clientProof || ""))) return false;
      const current = pending.get(grant.id);
      pending.delete(grant.id);
      if (!current || current.deadline.expired()
          || current.clientChallenge !== clientChallenge || current.serverNonce !== serverNonce) return false;
      const expected = bootstrapProof(grant.secret, "client", grant.id, clientChallenge, serverNonce);
      if (!safeEqual(expected, clientProof)) return false;
      used.set(grant.id, grant.expiresAt);
      return true;
    },
  };
}

export function createPairingBootstrapInitProof(grantSecret, grantId, clientChallenge) {
  if (!PROOF.test(String(grantSecret || "")) || !GRANT_ID.test(String(grantId || "")) || !CHALLENGE.test(String(clientChallenge || ""))) throw new Error("browser pairing bootstrap init proof input is invalid");
  return bootstrapInitProof(grantSecret, grantId, clientChallenge);
}

export function createPairingBootstrapProof(grantSecret, direction, grantId, clientChallenge, serverNonce) {
  if (!PROOF.test(String(grantSecret || "")) || (direction !== "server" && direction !== "client")
      || !GRANT_ID.test(String(grantId || "")) || !CHALLENGE.test(String(clientChallenge || ""))
      || !CHALLENGE.test(String(serverNonce || ""))) {
    throw new Error("browser pairing bootstrap proof input is invalid");
  }
  return bootstrapProof(grantSecret, direction, grantId, clientChallenge, serverNonce);
}

function grantFromId(token, port, grantId, now) {
  const match = GRANT_ID.exec(String(grantId || ""));
  if (!match) return null;
  const expiresAt = Number(match[1]);
  if (!Number.isFinite(now) || expiresAt < now || expiresAt - now > PAIRING_GRANT_TTL_MS) return null;
  return { id: grantId, secret: grantSecret(token, port, expiresAt, match[2]), expiresAt };
}

function grantSecret(token, port, expiresAt, nonce) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1024 || normalizedPort > 65535) throw new Error("browser pairing grant port is invalid");
  return hmac(token, `machine-bridge-browser-pair-v2\0${normalizedPort}\0${expiresAt}\0${nonce}`);
}
function bootstrapInitProof(secret, grantId, clientChallenge) {
  return hmac(secret, `machine-bridge-browser-pair-init-v2\0${grantId}\0${clientChallenge}`);
}
function bootstrapProof(secret, direction, grantId, clientChallenge, serverNonce) {
  return hmac(secret, `machine-bridge-browser-pair-${direction}-v2\0${grantId}\0${clientChallenge}\0${serverNonce}`);
}
function hmac(key, message) { return createHmac("sha256", key).update(message).digest("base64url"); }
function assertToken(value) { if (!TOKEN.test(String(value || ""))) throw new Error("browser broker credential is invalid"); }
function safeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
function prune(used, pending, now) {
  for (const [id, expiresAt] of used) if (expiresAt < now) used.delete(id);
  for (const [id, entry] of pending) if (entry.deadline.expired()) pending.delete(id);
}
