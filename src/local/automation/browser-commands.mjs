import { BridgeError } from "../core/errors.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageRoot } from "../core/timing.mjs";

const NAVIGATION_ACTIONS = new Set(["navigate", "reload", "back", "forward"]);

const PAGE_ACTIONS = new Set([
  "click", "double_click", "hover", "fill", "type_text", "select", "check", "uncheck",
  "focus", "press", "submit", "scroll_into_view",
]);

const FORM_ACTIONS = new Set(["fill", "select", "check", "uncheck", "click"]);

const WAIT_STATES = new Set(["attached", "detached", "visible", "hidden", "enabled", "editable", "checked", "unchecked"]);

const LOAD_STATES = new Set(["domcontentloaded", "complete"]);

const INPUT_MODES = new Set(["auto", "trusted", "dom"]);

const SNAPSHOT_IDENTITY_STRING_FIELDS = Object.freeze([
  "tag", "type", "role", "name", "id", "field_name", "label", "placeholder", "href",
]);

const SNAPSHOT_IDENTITY_BOOLEAN_FIELDS = Object.freeze(["sensitive", "in_shadow_dom"]);

export function normalizeBrowserAction(value) {
  if (typeof value !== "string" || (!NAVIGATION_ACTIONS.has(value) && !PAGE_ACTIONS.has(value))) throw new Error("unsupported browser action");
  return value;
}

export function browserPairingLaunchCommand(url, platform = process.platform) {
  if (platform === "darwin") return { cmd: "open", argv: [url] };
  if (platform === "win32") return {
    cmd: "powershell.exe", argv: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${url.replaceAll("'", "''")}'`],
  };
  return { cmd: "xdg-open", argv: [url] };
}

export function browserPairingLaunchUnknown() {
  return new BridgeError("execution_failed", "browser pairing page may have been opened; the launch outcome is unknown. Inspect the browser before retrying.", {
    expose: true, retryable: false,
  });
}

export function browserPairingLaunchUnavailable() {
  return new BridgeError("unavailable", "browser pairing launcher unavailable before dispatch", {
    retryable: true, details: { reason: "browser_pairing_launcher_unavailable_before_dispatch" },
  });
}

export function normalizeFormAction(value) {
  if (typeof value !== "string" || !FORM_ACTIONS.has(value)) throw new Error("unsupported form field action");
  return value;
}

export function normalizeBrowserSelector(value, action = "") {
  if (NAVIGATION_ACTIONS.has(action)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selector must be an object");
  const allowed = new Set(["ref", "css", "id", "name", "label", "text", "role", "placeholder", "index"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown selector field: ${key}`);
  const output = {};
  if (value.ref !== undefined) {
    const ref = optionalString(value.ref, "selector.ref", 100);
    if (ref) output.ref = ref;
  }
  for (const key of ["css", "id", "name", "label", "text", "role", "placeholder"]) {
    if (value[key] === undefined) continue;
    const normalized = optionalString(value[key], `selector.${key}`, 2000);
    if (normalized) output[key] = normalized;
  }
  if (value.index !== undefined) output.index = optionalInteger(value.index, "selector.index", 0, 10000);
  if (!Object.keys(output).length) throw new Error("selector requires at least one field");
  if (output.ref && Object.keys(output).length !== 1) throw new Error("selector.ref cannot be combined with other selector fields");
  return output;
}

export function normalizeInputMode(value) {
  if (value === undefined) return "auto";
  if (typeof value !== "string" || !INPUT_MODES.has(value)) throw new Error("input_mode must be auto, trusted, or dom");
  return value;
}

export function normalizeBrowserSnapshotIdentity(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected_ref_identity must be an object");
  const allowed = new Set([...SNAPSHOT_IDENTITY_STRING_FIELDS, ...SNAPSHOT_IDENTITY_BOOLEAN_FIELDS]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown expected_ref_identity field: ${key}`);
  const output = {};
  for (const key of SNAPSHOT_IDENTITY_STRING_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    output[key] = optionalString(value[key], `expected_ref_identity.${key}`, key === "href" ? 8192 : 2000);
  }
  for (const key of SNAPSHOT_IDENTITY_BOOLEAN_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== "boolean") throw new Error(`expected_ref_identity.${key} must be a boolean`);
    output[key] = value[key];
  }
  return Object.keys(output).length ? output : null;
}

export function normalizeNavigationWait(value) {
  if (value === undefined) return "none";
  if (typeof value !== "string" || !["none", ...LOAD_STATES].includes(value)) throw new Error("wait_for must be none, domcontentloaded, or complete");
  return value;
}

export function normalizeBrowserWait(args = {}) {
  const selector = args.selector === undefined ? null : normalizeBrowserSelector(args.selector, "wait");
  const state = args.state === undefined ? (selector ? "visible" : "") : args.state;
  if (typeof state !== "string") throw new Error("state is not a supported browser wait state");
  if (state && !WAIT_STATES.has(state)) throw new Error("state is not a supported browser wait state");
  if (state && !selector) throw new Error("state requires selector");
  const text = optionalString(args.text, "text", 4000);
  const urlContains = optionalString(args.url_contains, "url_contains", 32768);
  const loadState = args.load_state === undefined ? "" : args.load_state;
  if (typeof loadState !== "string") throw new Error("load_state must be domcontentloaded or complete");
  if (loadState && !LOAD_STATES.has(loadState)) throw new Error("load_state must be domcontentloaded or complete");
  if (!selector && !text && !urlContains && !loadState) throw new Error("browser_wait requires selector, text, url_contains, or load_state");
  const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
  return {
    tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
    frameId: optionalInteger(args.frame_id, "frame_id", 0, Number.MAX_SAFE_INTEGER),
    selector,
    state,
    text,
    urlContains,
    loadState,
    timeoutMs: timeoutSeconds * 1000,
  };
}

export function normalizeTabCommand(args = {}) {
  const action = args.action;
  if (typeof action !== "string" || !["new", "activate", "close"].includes(action)) throw new Error("browser tab action must be new, activate, or close");
  const tabId = optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER);
  const rawUrl = optionalString(args.url, "url", 32768);
  if (["activate", "close"].includes(action) && !tabId) throw new Error(`${action} requires tab_id`);
  if (action !== "new" && rawUrl) throw new Error("url is only valid for new tabs");
  if (args.active !== undefined && typeof args.active !== "boolean") throw new Error("active must be boolean");
  return {
    action,
    tabId,
    url: rawUrl ? validateNavigationUrl(rawUrl) : "",
    active: args.active !== false,
  };
}

export function validateNavigationUrl(value) {
  if (typeof value !== "string" || !value) throw new Error("navigate requires url");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("url must be an absolute URL"); }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) throw new Error("url protocol must be http, https, or file");
  return parsed.href;
}

export function optionalBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

export function normalizeImageFormat(value, label = "format") {
  if (value === undefined) return "png";
  if (typeof value !== "string" || !["png", "jpeg"].includes(value)) throw new Error(`${label} must be png or jpeg`);
  return value;
}

export function optionalString(value, label, maxLength) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) {
    throw new Error(`${label} must be a string of at most ${maxLength} characters without NUL bytes`);
  }
  return value;
}

export function optionalInteger(value, label, min, max) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

export function clampInt(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`expected an integer from ${min} to ${max}`);
  return value;
}
const MAX_FIELD_VALUE_CHARS = 128 * 1024;

const RESOURCE_NAME = /^[a-z][a-z0-9._-]{0,63}$/;

export function prepareBrowserFormField(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`fields[${index}] must be an object`);
  const allowed = new Set(["selector", "value", "value_resource", "action", "sensitive"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown fields[${index}] property: ${key}`);
  if (input.sensitive !== undefined && typeof input.sensitive !== "boolean") throw new Error(`fields[${index}].sensitive must be boolean`);
  const action = input.action === undefined ? "fill" : normalizeFormAction(input.action);
  const selector = normalizeBrowserSelector(input.selector, action);
  const directValue = input.value === undefined ? null : boundedBrowserValue(input.value, `fields[${index}].value`);
  const resourceName = input.value_resource === undefined ? "" : validateBrowserResource(input.value_resource);
  if (directValue !== null && resourceName) throw new Error(`fields[${index}] value and value_resource are mutually exclusive`);
  const hasValue = directValue !== null || Boolean(resourceName);
  if (!hasValue && !["check", "uncheck", "click"].includes(action)) throw new Error(`fields[${index}] requires value or value_resource`);
  if (hasValue && !["fill", "select"].includes(action)) throw new Error(`fields[${index}] value is not valid for action '${action}'`);
  return { index, selector, action, sensitive: input.sensitive === true, value: directValue, resourceName };
}

export function normalizeUploadFilename(value, { derived = false } = {}) {
  if (typeof value !== "string") {
    if (derived) return "upload.bin";
    throw new Error("filenames entries must be safe single-component filenames of at most 255 characters");
  }
  let name = value;
  if (derived) name = name.replace(/[\u0000-\u001f\u007f/\\]+/g, "_").trim();
  if (!name || name === "." || name === ".." || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) {
    if (derived) return "upload.bin";
    throw new Error("filenames entries must be safe single-component filenames of at most 255 characters");
  }
  return name;
}

export function normalizeMimeType(value) {
  if (typeof value !== "string") throw new Error("mime_types entries must be valid media types");
  const mime = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) || mime.length > 200) {
    throw new Error("mime_types entries must be valid media types");
  }
  return mime;
}

export function optionalStringArray(value, label, maxItems, maxLength) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array with at most ${maxItems} entries`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.includes("\0") || !item.length || item.length > maxLength) {
      throw new Error(`${label}[${index}] must be a non-empty string of at most ${maxLength} characters`);
    }
    return item;
  });
}

export async function resolveBrowserActionValue(args, readResourceText) {
  let value = args.value === undefined ? null : boundedBrowserValue(args.value, "value");
  if (args.value_resource !== undefined) {
    if (value !== null) throw new Error("value and value_resource are mutually exclusive");
    value = boundedBrowserValue(await readResourceText(validateBrowserResource(args.value_resource)), "value_resource");
  }
  return { value, source: args.value_resource !== undefined ? "local-resource" : value === null ? "none" : "mcp-argument" };
}

export function boundedBrowserValue(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.includes("\0") || value.length > MAX_FIELD_VALUE_CHARS) throw new Error(`${label} exceeds the maximum length or contains a NUL byte`);
  return value;
}

export function validateBrowserResource(value) {
  if (typeof value !== "string" || !RESOURCE_NAME.test(value)) throw new Error("value_resource is invalid");
  return value;
}
const TRUSTED_PAGE_ACTIONS = new Set(["click", "double_click", "hover", "press", "type_text"]);

const AMBIGUOUS_TRUSTED_INPUT = "trusted browser input may have been partially dispatched";

export const TRUSTED_INPUT_QUARANTINE_REASON = "browser_trusted_input_quarantined";

export const TRUSTED_INPUT_QUARANTINE_FALLBACK = "trusted_input_quarantined_after_ambiguous_failure";

export class BrowserTrustedInputHealth {
  constructor({ logger = null } = {}) {
    this.logger = logger || { event() {} };
    this.quarantinedGeneration = 0;
  }

  status(bridge = {}) {
    const connected = bridge.extensionConnected === true;
    const generation = extensionGeneration(bridge);
    const supported = bridge.extensionInfo?.capabilities?.includes("trusted_input") === true;
    const quarantined = connected && generation > 0 && this.quarantinedGeneration === generation;
    return Object.freeze({ connected, generation, supported, quarantined, available: connected && supported && !quarantined });
  }

  pageInputMode({ inputMode, action, bridge }) {
    const health = this.status(bridge);
    if (!health.quarantined || inputMode === "dom" || !TRUSTED_PAGE_ACTIONS.has(action)) {
      return Object.freeze({ inputMode, fallback: false });
    }
    if (inputMode === "trusted") throw quarantinedError();
    return Object.freeze({ inputMode: "dom", fallback: true });
  }

  assertTrustedAvailable(bridge) {
    if (this.status(bridge).quarantined) throw quarantinedError();
  }

  noteAmbiguousFailure(error, bridge = {}) {
    const message = String(error?.message || error || "");
    if (!message.startsWith(AMBIGUOUS_TRUSTED_INPUT)) return false;
    const health = this.status(bridge);
    if (!health.connected || health.generation < 1) return false;
    if (this.quarantinedGeneration !== health.generation) {
      this.quarantinedGeneration = health.generation;
      this.logger.event?.("warn", "browser.trusted_input.quarantined", {
        reason: "ambiguous_input_settlement",
      }, "trusted browser input quarantined for the current extension connection");
    }
    return true;
  }
}

function extensionGeneration(bridge) {
  const value = bridge.extensionGeneration;
  if (Number.isSafeInteger(value) && value > 0) return value;
  return bridge.extensionConnected === true ? 1 : 0;
}

function quarantinedError() {
  return new BridgeError("unavailable",
    "trusted browser input is quarantined for the current extension connection after an ambiguous dispatch",
    {
      retryable: false,
      details: { reason: TRUSTED_INPUT_QUARANTINE_REASON, side_effects_started: false },
    });
}
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const manifest = readExtensionManifest();

export const EXPECTED_EXTENSION_PUBLIC_KEY = normalizeManifestPublicKey(manifest.key);

export const EXPECTED_EXTENSION_ID = extensionIdFromPublicKey(EXPECTED_EXTENSION_PUBLIC_KEY);

export function extensionIdFromPublicKey(value) {
  const publicKey = normalizeManifestPublicKey(value);
  const bytes = Buffer.from(publicKey, "base64");
  const hexadecimal = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const extensionId = [...hexadecimal]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
    .join("");
  if (!EXTENSION_ID_PATTERN.test(extensionId)) throw new Error("browser extension public key produced an invalid extension id");
  return extensionId;
}

export function normalizeExtensionId(value) {
  if (typeof value !== "string") return "";
  const extensionId = value.trim().toLowerCase();
  return EXTENSION_ID_PATTERN.test(extensionId) ? extensionId : "";
}

function normalizeManifestPublicKey(value) {
  if (typeof value !== "string") throw new Error("browser extension manifest public key must be a string");
  const publicKey = value.trim();
  if (!PUBLIC_KEY_PATTERN.test(publicKey) || publicKey.length < 128 || publicKey.length > 8192) {
    throw new Error("browser extension manifest must contain a bounded base64 public key");
  }
  let bytes;
  try { bytes = Buffer.from(publicKey, "base64"); }
  catch { throw new Error("browser extension manifest public key is invalid base64"); }
  if (bytes.length < 96 || bytes.length > 6144 || bytes.toString("base64") !== publicKey) {
    throw new Error("browser extension manifest public key is not canonical DER base64");
  }
  return publicKey;
}

function readExtensionManifest() {
  const path = resolve(packageRoot, "browser-extension", "manifest.json");
  const manifestValue = JSON.parse(readFileSync(path, "utf8"));
  if (!manifestValue || typeof manifestValue !== "object" || Array.isArray(manifestValue)) {
    throw new Error("browser extension manifest is invalid");
  }
  return manifestValue;
}
