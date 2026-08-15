import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";

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
  if (!CHALLENGE.test(String(clientChallenge || ""))) throw new Error("browser broker authentication challenge is invalid");
  return hmac(token, `machine-bridge-browser-${role}-init-v2\0${clientChallenge}`);
}

export function createBrokerServerProof(token, role, clientChallenge, serverNonce) {
  return authProof(token, role, "server", clientChallenge, serverNonce);
}

export function verifyBrokerServerProof(token, role, clientChallenge, serverNonce, proof) {
  if (!PROOF.test(String(proof || ""))) return false;
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
      if (!CHALLENGE.test(String(clientChallenge || "")) || !PROOF.test(String(initProof || ""))) return null;
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
  const parts = String(value || "").split(".");
  if (parts.length !== 4 || parts[0] !== `mbm-${role}-v2`) return null;
  const [, clientChallenge, serverNonce, proof] = parts;
  if (!CHALLENGE.test(clientChallenge) || !CHALLENGE.test(serverNonce) || !PROOF.test(proof)) return null;
  return { clientChallenge, serverNonce };
}

function authProof(token, role, direction, clientChallenge, serverNonce) {
  assertToken(token); assertRole(role);
  if (!CHALLENGE.test(String(clientChallenge || "")) || !CHALLENGE.test(String(serverNonce || ""))) {
    throw new Error("browser broker authentication challenge is invalid");
  }
  return hmac(token, `machine-bridge-browser-${role}-${direction}-v2\0${clientChallenge}\0${serverNonce}`);
}

function hmac(token, message) { return createHmac("sha256", token).update(message).digest("base64url"); }
function assertToken(value) { if (!TOKEN.test(String(value || ""))) throw new Error("browser broker credential is invalid"); }
function assertRole(value) { if (!ROLES.has(value)) throw new Error("browser broker authentication role is invalid"); }
function safeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
function prunePending(pending) { for (const [key, issued] of pending) if (issued.deadline.expired()) pending.delete(key); }
