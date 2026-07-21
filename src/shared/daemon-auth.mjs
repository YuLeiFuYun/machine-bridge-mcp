export const DAEMON_AUTH_SCHEME = "device-signature-v1";
export const DAEMON_PREFLIGHT_SCHEME = "device-preflight-v1";
export const DAEMON_AUTH_CHALLENGE_TTL_SECONDS = 30;
export const DAEMON_PREFLIGHT_TTL_SECONDS = 5 * 60;


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

function requiredText(value, label, minimum, maximum) {
  const text = String(value || "");
  if (text.length < minimum || text.length > maximum || /[\0\r\n]/.test(text)) {
    throw new Error(`daemon authentication ${label} is invalid`);
  }
  return text;
}

function requiredOrigin(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("daemon authentication Worker origin is invalid"); }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!secure && !loopback) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("daemon authentication Worker origin is invalid");
  }
  return url.origin;
}

function requiredInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`daemon authentication ${label} is invalid`);
  return String(number);
}
