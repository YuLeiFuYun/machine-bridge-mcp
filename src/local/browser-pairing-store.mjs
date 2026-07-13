import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { assertStateMaintenanceAvailable, ownerOnlyFile } from "./state.mjs";
import { EXPECTED_EXTENSION_VERSION } from "./browser-extension-protocol.mjs";

export const DEFAULT_BROWSER_PORT = 39393;
const PAIRING_FILE = "browser-bridge.json";

export async function loadOrCreatePairing(stateRoot) {
  if (!stateRoot) return { token: randomBytes(32).toString("base64url"), port: DEFAULT_BROWSER_PORT };
  assertStateMaintenanceAvailable(stateRoot);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const file = join(stateRoot, PAIRING_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (existsSync(file)) {
      ownerOnlyFile(file);
      let parsed;
      try { parsed = JSON.parse(readBoundedRegularFileSync(file, 64 * 1024).toString("utf8")); }
      catch { throw new Error("browser pairing state is not valid bounded JSON"); }
      if (!/^[A-Za-z0-9_-]{32,100}$/.test(parsed.token) || !Number.isInteger(parsed.port) || parsed.port < 1024 || parsed.port > 65535) {
        throw new Error("browser pairing state is invalid");
      }
      return parsed;
    }
    const value = { token: randomBytes(32).toString("base64url"), port: DEFAULT_BROWSER_PORT };
    try {
      createExclusiveFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      ownerOnlyFile(file);
      return value;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("browser pairing state could not be initialized");
}

export async function savePairing(stateRoot, value) {
  assertStateMaintenanceAvailable(stateRoot);
  const file = join(stateRoot, PAIRING_FILE);
  replaceFileAtomicallySync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  ownerOnlyFile(file);
}

export function pairingHtml(port, token) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="machine-bridge-browser-pair" content="1"><meta name="machine-bridge-browser-port" content="${port}"><meta name="machine-bridge-browser-token" content="${token}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Machine Bridge browser pairing</title></head><body><h1>Machine Bridge browser pairing</h1><p>Expected extension build: <strong>${EXPECTED_EXTENSION_VERSION}</strong>. Reload the unpacked extension after every Machine Bridge upgrade.</p><p>The installed extension reads pairing material from this loopback-only page and stores it in browser-local extension storage. It is not sent to any website.</p><p id="status">Waiting for the Machine Bridge extension.</p></body></html>`;
}

export function isAllowedExtensionOrigin(origin) {
  let parsed;
  try { parsed = new URL(String(origin || "")); } catch { return false; }
  return parsed.protocol === "chrome-extension:"
    && /^[a-p]{32}$/.test(parsed.hostname)
    && !parsed.username
    && !parsed.password
    && !parsed.port
    && (parsed.pathname === "" || parsed.pathname === "/")
    && !parsed.search
    && !parsed.hash;
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
