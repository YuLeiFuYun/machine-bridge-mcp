const NAVIGATION_ACTIONS = new Set(["navigate", "reload", "back", "forward"]);
const PAGE_ACTIONS = new Set([
  "click", "double_click", "hover", "fill", "type_text", "select", "check", "uncheck",
  "focus", "press", "submit", "scroll_into_view",
]);
const FORM_ACTIONS = new Set(["fill", "select", "check", "uncheck", "click"]);
const WAIT_STATES = new Set(["attached", "detached", "visible", "hidden", "enabled", "editable", "checked", "unchecked"]);
const LOAD_STATES = new Set(["domcontentloaded", "complete"]);
const INPUT_MODES = new Set(["auto", "trusted", "dom"]);
const MUTATING_BROWSER_METHODS = new Set(["manage_tabs", "action", "fill_form", "upload_files"]);

export function browserMethodMayMutate(value) {
  return MUTATING_BROWSER_METHODS.has(String(value || ""));
}

export function normalizeBrowserAction(value) {
  const action = String(value || "").trim();
  if (!NAVIGATION_ACTIONS.has(action) && !PAGE_ACTIONS.has(action)) throw new Error("unsupported browser action");
  return action;
}

export function normalizeFormAction(value) {
  const action = String(value || "").trim();
  if (!FORM_ACTIONS.has(action)) throw new Error("unsupported form field action");
  return action;
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
  if (value === undefined || value === null || value === "") return "auto";
  const mode = String(value);
  if (!INPUT_MODES.has(mode)) throw new Error("input_mode must be auto, trusted, or dom");
  return mode;
}

export function normalizeNavigationWait(value) {
  if (value === undefined || value === null || value === "") return "none";
  const wait = String(value);
  if (!["none", ...LOAD_STATES].includes(wait)) throw new Error("wait_for must be none, domcontentloaded, or complete");
  return wait;
}

export function normalizeBrowserWait(args = {}) {
  const selector = args.selector === undefined ? null : normalizeBrowserSelector(args.selector, "wait");
  const state = args.state === undefined || args.state === null || args.state === ""
    ? (selector ? "visible" : "")
    : String(args.state);
  if (state && !WAIT_STATES.has(state)) throw new Error("state is not a supported browser wait state");
  if (state && !selector) throw new Error("state requires selector");
  const text = optionalString(args.text, "text", 4000);
  const urlContains = optionalString(args.url_contains, "url_contains", 32768);
  const loadState = args.load_state === undefined || args.load_state === null || args.load_state === "" ? "" : String(args.load_state);
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
  const action = String(args.action || "").trim();
  if (!["new", "activate", "close"].includes(action)) throw new Error("browser tab action must be new, activate, or close");
  const tabId = optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER);
  const rawUrl = optionalString(args.url, "url", 32768);
  if (["activate", "close"].includes(action) && !tabId) throw new Error(`${action} requires tab_id`);
  if (action !== "new" && rawUrl) throw new Error("url is only valid for new tabs");
  return {
    action,
    tabId,
    url: rawUrl ? validateNavigationUrl(rawUrl) : "",
    active: args.active !== false,
  };
}

export function validateNavigationUrl(value) {
  if (!value) throw new Error("navigate requires url");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("url must be an absolute URL"); }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) throw new Error("url protocol must be http, https, or file");
  return parsed.href;
}

export function optionalString(value, label, maxLength) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) {
    throw new Error(`${label} must be a string of at most ${maxLength} characters without NUL bytes`);
  }
  return value;
}

export function optionalInteger(value, label, min, max) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return number;
}

export function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`expected an integer from ${min} to ${max}`);
  return number;
}
