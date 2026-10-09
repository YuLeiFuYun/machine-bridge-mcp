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
  assertToken(extensionToken);
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
  return hmac(token, `machine-bridge-browser-pair-v2\0${port}\0${expiresAt}\0${nonce}`);
}
function bootstrapInitProof(secret, grantId, clientChallenge) { return hmac(secret, `machine-bridge-browser-pair-init-v2\0${grantId}\0${clientChallenge}`); }
function bootstrapProof(secret, direction, grantId, clientChallenge, serverNonce) { return hmac(secret, `machine-bridge-browser-pair-${direction}-v2\0${grantId}\0${clientChallenge}\0${serverNonce}`); }
function hmac(key, message) { return createHmac("sha256", key).update(message).digest("base64url"); }
function exact(pattern, value) { return typeof value === "string" && pattern.test(value); }
function validClock(value) { return Number.isSafeInteger(value) && value > 0; }
function assertToken(value) { if (!exact(TOKEN, value)) throw new Error("browser broker credential is invalid"); }
function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function prune(used, pending, now) {
  for (const [id, expiresAt] of used) if (expiresAt < now) used.delete(id);
  for (const [id, entry] of pending) if (entry.deadline.expired()) pending.delete(id);
}
