import { EXPECTED_EXTENSION_ID, normalizeExtensionId } from "./browser-extension-identity.mjs";
import { EXPECTED_EXTENSION_VERSION } from "./browser-extension-protocol.mjs";

export function pairingHtml(port, extensionToken) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="machine-bridge-browser-pair" content="1"><meta name="machine-bridge-browser-port" content="${port}"><meta name="machine-bridge-browser-token" content="${extensionToken}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Machine Bridge browser pairing</title></head><body><h1>Machine Bridge browser pairing</h1><p>Expected extension build: <strong>${EXPECTED_EXTENSION_VERSION}</strong>.</p><p>Expected extension ID: <code>${EXPECTED_EXTENSION_ID}</code>.</p><p>Reload the unpacked extension after every Machine Bridge upgrade.</p><p>The installed extension reads pairing material from this loopback-only page and stores it in browser-local extension storage. It is not sent to any website.</p><p id="status">Waiting for the Machine Bridge extension.</p></body></html>`;
}

export function isAllowedExtensionOrigin(origin, expectedExtensionId = EXPECTED_EXTENSION_ID) {
  const expected = normalizeExtensionId(expectedExtensionId);
  if (!expected) return false;
  let parsed;
  try { parsed = new URL(String(origin || "")); } catch { return false; }
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
