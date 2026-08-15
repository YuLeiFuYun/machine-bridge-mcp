import { BridgeError } from "./errors.mjs";

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
  if (platform === "win32") return { cmd: "cmd.exe", argv: ["/d", "/s", "/c", "start", "", url] };
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
