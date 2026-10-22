import { canonicalTrustedOrigin } from "./trusted-origin.mjs";

export const DAEMON_AUTH_SCHEME = "device-signature-v1";
export const DAEMON_PREFLIGHT_SCHEME = "device-preflight-v1";
export const DAEMON_HTTP_RELAY_SCHEME = "device-http-relay-v1";
export const DAEMON_AUTH_CHALLENGE_TTL_SECONDS = 30;
export const DAEMON_PREFLIGHT_TTL_SECONDS = 5 * 60;
export const DAEMON_HTTP_RELAY_TTL_SECONDS = 30;


export function daemonPreflightTranscript(input = {}) {
  const values = [
    DAEMON_PREFLIGHT_SCHEME,
    requiredOrigin(input.workerOrigin),
    requiredText(input.server, "server", 1, 128),
    requiredText(input.version, "version", 1, 64),
    requiredText(input.nonce, "preflight nonce", 24, 128),
    requiredInteger(input.issuedAt, "preflight issued at"),
  ];
  return values.join("\0");
}

export function daemonAuthTranscript(input = {}) {
  const values = [
    DAEMON_AUTH_SCHEME,
    requiredText(input.challenge, "challenge", 16, 256),
    requiredOrigin(input.workerOrigin),
    requiredText(input.server, "server", 1, 128),
    requiredText(input.version, "version", 1, 64),
    requiredText(input.instanceId, "instance id", 16, 128),
    requiredInteger(input.issuedAt, "issued at"),
  ];
  return values.join("\0");
}

export function daemonHttpRelayTranscript(input = {}) {
  const values = [
    DAEMON_HTTP_RELAY_SCHEME,
    "POST",
    "/daemon/http",
    requiredOrigin(input.workerOrigin),
    requiredText(input.server, "server", 1, 128),
    requiredText(input.version, "version", 1, 64),
    requiredText(input.nonce, "HTTP relay nonce", 24, 128),
    requiredInteger(input.issuedAt, "HTTP relay issued at"),
    requiredText(input.bodySha256, "HTTP relay body SHA-256", 43, 43),
  ];
  return values.join("\0");
}

function requiredText(value, label, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new Error(`daemon authentication ${label} is invalid`);
  }
  return value;
}

function requiredOrigin(value) {
  return canonicalTrustedOrigin(value, "daemon authentication Worker origin is invalid");
}

function requiredInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`daemon authentication ${label} is invalid`);
  return String(value);
}
