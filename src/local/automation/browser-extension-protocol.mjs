// @ts-check
import { readFileSync } from "node:fs";
import { resolve, isAbsolute, relative, sep } from "node:path";
import { packageRoot } from "../core/timing.mjs";
import { EXPECTED_EXTENSION_ID, normalizeExtensionId } from "./browser-commands.mjs";
import { isCandidateRuntimeDirectoryName } from "../state/state-storage.mjs";
import { BridgeError } from "../core/errors.mjs";

export const BROWSER_EXTENSION_PROTOCOL = 3;

export const EXPECTED_EXTENSION_VERSION = extensionVersion();

const REQUIRED_EXTENSION_CAPABILITIES = Object.freeze([
  "semantic_snapshot_refs", "actionability_waits", "trusted_input", "tab_management", "explicit_waits", "computer_observation_v1",
]);

export const MAX_BROWSER_MESSAGE_BYTES = 8 * 1024 * 1024;

const MUTATING_BROWSER_METHODS = new Set([
  "manage_tabs", "point_action", "backend_node_action", "action", "fill_form", "upload_files", "screenshot",
]);

const BROWSER_MUTATION_TRANSPORT_UNKNOWN = "browser mutation request may have been dispatched; the outcome is unknown because its response was not observed. Inspect browser state before retrying.";

/** @param {unknown} method */
export function browserMethodMayMutate(method) {
  return typeof method === "string" && MUTATING_BROWSER_METHODS.has(method);
}

/** @param {unknown} method @param {unknown} fallback */
export function browserPostDispatchTransportFailure(method, fallback) {
  if (browserMethodMayMutate(method)) return BROWSER_MUTATION_TRANSPORT_UNKNOWN;
  return typeof fallback === "string" && fallback ? fallback.slice(0, 2000) : "browser transport failed";
}

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

/** @param {unknown} value */
export function normalizeRuntimeBrowserRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = /** @type {Record<string, unknown>} */ (value);
  const id = boundedProtocolString(message.id, 200);
  const method = typeof message.method === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(message.method) ? message.method : "";
  const params = message.params === undefined ? {} : message.params;
  const timeoutMs = message.timeout_ms === undefined ? 30_000 : message.timeout_ms;
  const callId = message.call_id === undefined ? "" : boundedProtocolString(message.call_id, 200);
  if (message.type !== "request" || !id || !method || !params || typeof params !== "object" || Array.isArray(params)
      || !Number.isSafeInteger(timeoutMs)
      || (message.call_id !== undefined && !callId)) return null;
  return { type: "request", id, method, params, timeout_ms: timeoutMs, ...(callId ? { call_id: callId } : {}) };
}

/** @param {unknown} value @param {number} maximum */
function boundedProtocolString(value, maximum) {
  return typeof value === "string" && value && value.length <= maximum && !value.includes("\0") ? value : "";
}

/** @param {ProtocolSocket} socket @param {number} code @param {string} reason */
export function closeProtocolSocket(socket, code, reason) {
  try { socket.close(code, reason); }
  catch { /* Protocol rejection is already decided; a concurrently closed socket needs no second failure path. */ }
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
  const protocol = record.protocol;
  const version = typeof record.version === "string" && record.version.length <= 100 ? record.version : "";
  const extension_id = normalizeExtensionId(record.extension_id);
  const capabilities = Array.isArray(record.capabilities)
    ? [...new Set(record.capabilities.filter((entry) => typeof entry === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(entry)))].slice(0, 32)
    : [];
  if (typeof protocol !== "number" || !Number.isInteger(protocol) || protocol < 1 || !version || !extension_id) return null;
  return { protocol, version, extension_id, capabilities };
}

function extensionVersion() {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "browser-extension", "manifest.json"), "utf8"));
  const version = manifest.version_name === undefined ? manifest.version : manifest.version_name;
  if (typeof version !== "string" || !version || version.length > 100 || version.includes("\0")) {
    throw new Error("browser extension manifest version is invalid");
  }
  return version;
}
export const RELEASE_BROWSER_EXTENSION_DIRECTORY = "browser-extension";

/** @param {string} stateRoot */
export function releaseBrowserExtensionPath(stateRoot) {
  return resolve(String(stateRoot || ""), "release-channels", RELEASE_BROWSER_EXTENSION_DIRECTORY);
}

/** @param {{stateRoot?: string, packageDirectory?: string}} [options] */
export function browserExtensionPathForRuntime({ stateRoot = "", packageDirectory = packageRoot } = {}) {
  const packaged = resolve(packageDirectory, "browser-extension");
  if (!stateRoot) return packaged;
  const runtimes = resolve(stateRoot, "release-channels", "runtimes");
  const runtimeRelative = relative(runtimes, resolve(packageDirectory));
  if (!runtimeRelative || runtimeRelative === ".." || runtimeRelative.startsWith(`..${sep}`) || isAbsolute(runtimeRelative)) {
    return packaged;
  }
  const [runtimeName] = runtimeRelative.split(sep);
  return isCandidateRuntimeDirectoryName(runtimeName) ? releaseBrowserExtensionPath(stateRoot) : packaged;
}
/** @typedef {{method: unknown, dispatchAttempted?: boolean}} BrowserPendingSettlement */
/** @param {{pending?: BrowserPendingSettlement | null, code: string, fallback: unknown, terminationRequested?: boolean}} options */
export function browserRequestTransportError({ pending, code, fallback, terminationRequested = false }) {
  const mutation = pending?.dispatchAttempted === true && browserMethodMayMutate(pending.method);
  const message = mutation
    ? browserPostDispatchTransportFailure(pending.method, boundedMessage(fallback))
    : boundedMessage(fallback);
  return new BridgeError(code, message, {
    expose: true,
    retryable: mutation ? false : code !== "cancelled",
    ...(mutation ? {
      details: {
        request_delivery: "sent",
        side_effects_started: "unknown",
        termination_requested: terminationRequested === true,
        effect_settlement: terminationRequested === true ? "pending" : "unknown",
      },
    } : {}),
  });
}

// Messages the extension uses when a mutation may already have taken effect. Kept as a
// fallback for extensions that predate the structured `settlement` field; new extensions
// send `settlement: "unknown"` and never rely on this table.
const MUTATION_PARTIAL_PREFIXES = Object.freeze([
  "browser mutation may have completed;",
  "trusted browser input may have been partially dispatched",
  "form submission failed after partial changes",
  "browser action may have been dispatched",
  "browser tab mutation may have been dispatched",
  "browser screenshot temporary tab activation may have been dispatched",
  "browser screenshot restoration may have been dispatched",
]);

/** @param {string} message */
function textClaimsPartialMutation(message) {
  return MUTATION_PARTIAL_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/**
 * @param {string} message
 * @param {BrowserPendingSettlement | null | undefined} pending
 * @param {{settlement?: unknown} | null} [envelope] structured response from the extension
 */
export function browserRequestResponseError(message, pending, envelope = null) {
  const mutation = pending?.dispatchAttempted === true && browserMethodMayMutate(pending.method);
  if (message === "browser broker is busy") return new BridgeError("limit_exceeded", message, { retryable: true });
  if (["browser extension is not connected", "browser extension send failed"].includes(message)) return new BridgeError("unavailable", message, { retryable: true });
  if (message.startsWith("browser mutation request may have been dispatched;")) {
    return browserRequestTransportError({ pending, code: "unavailable", fallback: message });
  }
  if (message.startsWith("browser broker request timed out after dispatch")) {
    return browserRequestTransportError({
      pending,
      code: "timeout",
      fallback: message,
      terminationRequested: mutation && message.includes("cancellation requested"),
    });
  }
  if (message.startsWith("browser connection changed after request dispatch")) {
    return browserRequestTransportError({ pending, code: "unavailable", fallback: message });
  }
  const declared = typeof envelope?.settlement === "string" ? envelope.settlement : "";
  if (declared === "applied") {
    // The extension is telling us the mutation landed; say so instead of returning a bare
    // failure that a caller might retry.
    return new BridgeError("execution_failed", message, {
      expose: true,
      retryable: false,
      details: { side_effects_started: true, termination_requested: false, effect_settlement: "applied" },
    });
  }
  const partial = mutation && (
    declared === "unknown"
    || (declared !== "not_started" && textClaimsPartialMutation(message))
  );
  return partial
    ? new BridgeError("execution_failed", message, {
        expose: true,
        retryable: false,
        details: { side_effects_started: true, termination_requested: false, effect_settlement: "unknown" },
      })
    : new BridgeError("execution_failed", message, { expose: true, retryable: false });
}

/** @param {BrowserPendingSettlement | null | undefined} pending */
export function invalidBrowserResponseSettlement(pending) {
  if (pending?.dispatchAttempted === true && browserMethodMayMutate(pending.method)) {
    return browserRequestTransportError({
      pending,
      code: "execution_failed",
      fallback: "browser extension response was malformed",
    });
  }
  return new BridgeError("execution_failed", "browser extension response was malformed", {
    expose: true,
    retryable: false,
  });
}

/** @param {unknown} value */
function boundedMessage(value) {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "browser transport failed";
  return message ? message.slice(0, 2000) : "browser transport failed";
}
