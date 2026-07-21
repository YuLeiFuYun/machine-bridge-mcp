export const ADMIN_AUTH_SCHEME = "hmac-sha256-v1";
export const ADMIN_AUTH_TTL_SECONDS = 5 * 60;

export function adminAuthTranscript(input = {}) {
  const origin = requiredOrigin(input.origin);
  const method = requiredToken(input.method, "method", /^[A-Z]{3,10}$/);
  const pathname = requiredToken(input.pathname, "pathname", /^\/[A-Za-z0-9/_-]{1,255}$/);
  const bodyHash = requiredToken(input.bodyHash, "body hash", /^[a-f0-9]{64}$/);
  const issuedAt = requiredInteger(input.issuedAt, "issued at");
  const nonce = requiredToken(input.nonce, "nonce", /^[A-Za-z0-9_-]{32,128}$/);
  return [ADMIN_AUTH_SCHEME, origin, method, pathname, bodyHash, issuedAt, nonce].join("\0");
}


function requiredOrigin(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("admin authentication origin is invalid"); }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!secure && !loopback) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("admin authentication origin is invalid");
  }
  return url.origin;
}

function requiredToken(value, label, pattern) {
  const text = String(value || "");
  if (!pattern.test(text)) throw new Error(`admin authentication ${label} is invalid`);
  return text;
}

function requiredInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`admin authentication ${label} is invalid`);
  return String(number);
}
