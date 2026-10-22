import { canonicalTrustedOrigin } from "./trusted-origin.mjs";

export const ADMIN_AUTH_SCHEME = "device-admin-signature-v1";
export const ADMIN_AUTH_TTL_SECONDS = 5 * 60;

export function adminAuthTranscript(input = {}) {
  const origin = requiredOrigin(input.origin);
  const method = requiredToken(input.method, "method", /^[A-Z]{3,10}$/);
  const pathname = requiredToken(input.pathname, "pathname", /^\/[A-Za-z0-9/_-]{1,255}$/);
  const bodyHash = requiredToken(input.bodyHash, "body hash", /^[a-f0-9]{64}$/);
  const keyId = requiredToken(input.keyId, "session key id", /^device_[A-Za-z0-9_-]{32}$/);
  const issuedAt = requiredInteger(input.issuedAt, "issued at");
  const nonce = requiredToken(input.nonce, "nonce", /^[A-Za-z0-9_-]{32,128}$/);
  return [ADMIN_AUTH_SCHEME, origin, method, pathname, bodyHash, keyId, issuedAt, nonce].join("\0");
}

function requiredOrigin(value) {
  return canonicalTrustedOrigin(value, "admin authentication origin is invalid");
}

function requiredToken(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`admin authentication ${label} is invalid`);
  return value;
}

function requiredInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`admin authentication ${label} is invalid`);
  return String(value);
}
