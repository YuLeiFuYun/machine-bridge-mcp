export const DEVICE_SESSION_CERTIFICATE_SCHEME = "device-session-certificate-v1";
export const DEVICE_SESSION_MAX_LIFETIME_SECONDS = 24 * 60 * 60;

export function deviceSessionCertificateTranscript(input = {}) {
  const publicJwk = canonicalPublicJwk(input.publicJwk);
  return [
    DEVICE_SESSION_CERTIFICATE_SCHEME,
    requiredOrigin(input.workerOrigin),
    requiredText(input.server, "server", 1, 128),
    requiredText(input.version, "version", 1, 64),
    requiredText(input.rootKeyId, "root key id", 16, 128),
    JSON.stringify(publicJwk),
    requiredInteger(input.issuedAt, "issued at"),
    requiredInteger(input.expiresAt, "expires at"),
    requiredText(input.nonce, "nonce", 24, 128),
  ].join("\0");
}

export function canonicalPublicJwk(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("device session public key is invalid");
  if (value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string" || value.d !== undefined) {
    throw new Error("device session public key is invalid");
  }
  if (!/^[A-Za-z0-9_-]{42,44}$/.test(value.x) || !/^[A-Za-z0-9_-]{42,44}$/.test(value.y)) {
    throw new Error("device session public key is invalid");
  }
  return { crv: "P-256", kty: "EC", x: value.x, y: value.y };
}

function requiredOrigin(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("device session Worker origin is invalid"); }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!secure && !loopback) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("device session Worker origin is invalid");
  }
  return url.origin;
}

function requiredText(value, label, minimum, maximum) {
  const text = String(value || "");
  if (text.length < minimum || text.length > maximum || /[\0\r\n]/.test(text)) throw new Error(`device session ${label} is invalid`);
  return text;
}

function requiredInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`device session ${label} is invalid`);
  return String(number);
}
