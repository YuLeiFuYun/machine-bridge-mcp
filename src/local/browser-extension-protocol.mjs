// @ts-check

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageRoot } from "./package-identity.mjs";
import { EXPECTED_EXTENSION_ID, normalizeExtensionId } from "./browser-extension-identity.mjs";

export const BROWSER_EXTENSION_PROTOCOL = 3;
export const EXPECTED_EXTENSION_VERSION = extensionVersion();
const REQUIRED_EXTENSION_CAPABILITIES = Object.freeze([
  "semantic_snapshot_refs", "actionability_waits", "trusted_input", "tab_management", "explicit_waits",
]);
export const MAX_BROWSER_MESSAGE_BYTES = 8 * 1024 * 1024;

/** @typedef {{protocol: number, version: string, extension_id: string, capabilities: string[]}} ExtensionInfo */
/** @typedef {{readyState: number, close: (code?: number, reason?: string) => unknown, send: (value: string) => unknown}} ProtocolSocket */

/** @param {unknown} value @returns {ExtensionInfo | null} */
export function normalizeCompatibleExtensionInfo(value) {
  const info = normalizeExtensionInfo(value);
  if (!info || info.protocol !== BROWSER_EXTENSION_PROTOCOL || info.version !== EXPECTED_EXTENSION_VERSION || info.extension_id !== EXPECTED_EXTENSION_ID) return null;
  if (REQUIRED_EXTENSION_CAPABILITIES.some((capability) => !info.capabilities.includes(capability))) return null;
  return info;
}

/** @param {Record<string, unknown>} message @returns {ExtensionInfo} */
export function parseExtensionHello(message) {
  if (message.role !== "extension" || message.protocol !== BROWSER_EXTENSION_PROTOCOL) {
    throw new Error(`extension protocol mismatch; expected ${BROWSER_EXTENSION_PROTOCOL}; reload the extension`);
  }
  const info = normalizeExtensionInfo(message);
  if (!info) throw new Error("invalid extension hello; reload the extension");
  if (info.version !== EXPECTED_EXTENSION_VERSION) {
    throw new Error(`extension version mismatch; expected ${EXPECTED_EXTENSION_VERSION}; reload the extension`);
  }
  if (info.extension_id !== EXPECTED_EXTENSION_ID) {
    throw new Error(`extension identity mismatch; expected ${EXPECTED_EXTENSION_ID}; reload the packaged extension`);
  }
  const missing = REQUIRED_EXTENSION_CAPABILITIES.filter((capability) => !info.capabilities.includes(capability));
  if (missing.length) throw new Error(`extension capability mismatch; reload the extension (${missing.join(",")})`);
  return info;
}

/**
 * @param {string | Buffer | Uint8Array} data
 * @returns {{ok: true, message: Record<string, unknown>} | {ok: false, code: number, reason: string}}
 */
export function parseBrowserSocketMessage(data) {
  if (Buffer.byteLength(data) > MAX_BROWSER_MESSAGE_BYTES) return { ok: false, code: 1009, reason: "message too large" };
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data)); }
  catch { return { ok: false, code: 1007, reason: "invalid UTF-8" }; }
  let message;
  try { message = JSON.parse(text); }
  catch { return { ok: false, code: 1007, reason: "invalid JSON" }; }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, code: 1002, reason: "invalid protocol message" };
  }
  return { ok: true, message };
}

/** @param {ProtocolSocket} socket @param {number} code @param {string} reason */
export function closeProtocolSocket(socket, code, reason) {
  try { socket.close(code, reason); } catch {}
}

/** @param {ProtocolSocket | null | undefined} socket @param {unknown} value */
export function safeSocketSend(socket, value) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(typeof value === "string" ? value : JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} value @returns {ExtensionInfo | null} */
function normalizeExtensionInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const protocol = Number(record.protocol);
  const version = typeof record.version === "string" && record.version.length <= 100 ? record.version : "";
  const extension_id = normalizeExtensionId(record.extension_id);
  const capabilities = Array.isArray(record.capabilities)
    ? [...new Set(record.capabilities.filter((entry) => typeof entry === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(entry)))].slice(0, 32)
    : [];
  if (!Number.isInteger(protocol) || protocol < 1 || !version || !extension_id) return null;
  return { protocol, version, extension_id, capabilities };
}

function extensionVersion() {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "browser-extension", "manifest.json"), "utf8"));
  return String(manifest.version_name || manifest.version || "");
}
