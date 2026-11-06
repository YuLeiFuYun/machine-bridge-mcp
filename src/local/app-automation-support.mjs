import { opendir, realpath } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import process from "node:process";
import { classifyOperationalError } from "./log.mjs";
import { applicationInputOutcomeUnknown } from "./computer-use-dispatch-settlement.mjs";

export const MAX_APPLICATIONS = 1000;
export const MAX_APPLICATION_SCAN_ENTRIES = 20_000;
export const MAX_APPLICATION_SCAN_DEPTH = 3;
export const MAX_UI_ELEMENTS = 500;
export const MAX_UI_DEPTH = 12;
export const MAX_TEXT_CHARS = 4000;
export const MAX_APPLICATION_SCREENSHOT_BYTES = 32 * 1024 * 1024;
export const APP_NAME_PATTERN = /^[^\0\r\n]{1,300}$/;
export const DEFAULT_APPLICATION_CACHE_MS = 30_000;
export const VALUE_VERIFICATION_TTL_MS = 60_000;
export const MAX_VALUE_VERIFICATION_HANDLES = 32;
export const APPLICATION_KEY_PRESS_KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Space"]);

export function applicationLaunchOutcomeUnknown(cause = null) {
  return exposedApplicationSettlement("application launch may have been partially dispatched; the outcome is unknown. Inspect application state before retrying.", cause);
}
export function applicationAccessibilityOutcomeUnknown(cause = null) {
  return exposedApplicationSettlement("application Accessibility mutation may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.", cause);
}
export function applicationKeyboardOutcomeUnknown(action, cause = null) {
  const label = action === "key_press" ? "key_press" : "keystroke";
  return exposedApplicationSettlement(`application ${label} may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.`, cause);
}
export function applicationVisualInputOutcomeUnknown(cause = null) {
  return exposedApplicationSettlement("application visual input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.", cause);
}
export function exposedApplicationSettlement(message, cause = null) {
  const terminationRequested = cause?.details?.termination_requested === true;
  const sideEffectsStarted = cause?.details?.side_effects_started ?? "unknown";
  return applicationInputOutcomeUnknown(message, cause, {
    side_effects_started: sideEffectsStarted,
    termination_requested: terminationRequested,
    effect_settlement: terminationRequested ? "pending" : "unknown",
  });
}

export async function listMacApplications(roots, context, throwIfCancelled) {
  return scanApplicationRoots(roots, {
    context, throwIfCancelled,
    match(entry) { return entry.isDirectory() && extname(entry.name).toLowerCase() === ".app"; },
    descend(entry) { return entry.isDirectory() && extname(entry.name).toLowerCase() !== ".app"; },
    makeItem(path, entry) { return { id: path, name: basename(entry.name, ".app"), path, kind: "application-bundle" }; },
  });
}
export async function listWindowsApplications(configuredRoots, home, context, throwIfCancelled) {
  const roots = configuredRoots || [
    join(process.env.APPDATA || home, "Microsoft", "Windows", "Start Menu", "Programs"),
    process.env.ProgramData ? join(process.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs") : "",
  ].filter(Boolean);
  return listExecutableRoots(roots, new Set([".exe", ".lnk"]), context, throwIfCancelled);
}
export async function listLinuxApplications(configuredRoots, home, context, throwIfCancelled) {
  const roots = configuredRoots || ["/usr/share/applications", "/usr/local/share/applications", join(home, ".local", "share", "applications")];
  return listExecutableRoots(roots, new Set([".desktop"]), context, throwIfCancelled);
}
export async function listExecutableRoots(roots, extensions, context, throwIfCancelled) {
  return scanApplicationRoots(roots, {
    context, throwIfCancelled,
    match(entry) { return entry.isFile() && extensions.has(extname(entry.name).toLowerCase()); },
    descend(entry) { return entry.isDirectory(); },
    makeItem(path, entry) { return { id: path, name: basename(entry.name, extname(entry.name)), path, kind: "launcher" }; },
  });
}

export async function scanApplicationRoots(roots, { context, throwIfCancelled, match, descend, makeItem }) {
  const results = [];
  const warnings = [];
  const seenRoots = new Set();
  let visited = 0;
  for (const inputRoot of roots) {
    let root;
    try { root = await realpath(inputRoot); } catch (error) {
      if (error?.code !== "ENOENT" && warnings.length < 50) {
        warnings.push({ path: inputRoot, error_class: classifyOperationalError(error) });
      }
      continue;
    }
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const stack = [{ directory: root, depth: 0 }];
    while (stack.length) {
      const current = stack.pop();
      let handle;
      try { handle = await opendir(current.directory); } catch (error) {
        if (error?.code !== "ENOENT" && warnings.length < 50) {
          warnings.push({ path: current.directory, error_class: classifyOperationalError(error) });
        }
        continue;
      }
      for await (const entry of handle) {
        throwIfCancelled(context);
        visited += 1;
        if (visited > MAX_APPLICATION_SCAN_ENTRIES) return { applications: results, warnings, truncated: true, visitedEntries: visited };
        const path = join(current.directory, entry.name);
        if (match(entry)) {
          results.push(makeItem(path, entry));
          if (results.length >= MAX_APPLICATIONS) return { applications: results, warnings, truncated: true, visitedEntries: visited };
        } else if (current.depth < MAX_APPLICATION_SCAN_DEPTH && descend(entry)) {
          stack.push({ directory: path, depth: current.depth + 1 });
        }
      }
    }
  }
  return { applications: results, warnings, truncated: false, visitedEntries: visited };
}

export function requiredApplication(value) {
  if (typeof value !== "string" || !APP_NAME_PATTERN.test(value)) {
    throw new Error("application must be a non-empty name or path without control characters");
  }
  return value;
}
export function applicationProcessName(application) {
  const normalized = String(application).replace(/\\/g, "/");
  const leaf = normalized.split("/").pop() || normalized;
  return leaf.toLowerCase().endsWith(".app") ? leaf.slice(0, -4) : application;
}
export function normalizeAppAction(value) {
  if (typeof value !== "string" || !["activate", "click", "check", "uncheck", "set_value", "focus", "press", "keystroke", "key_press"].includes(value)) {
    throw new Error("action must be one of activate, click, check, uncheck, set_value, focus, press, keystroke, or key_press");
  }
  return value;
}
export function normalizeApplicationKeyPress(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > 100) {
    throw new Error("application key_press requires a valid key");
  }
  const shifted = value.startsWith("Shift+");
  const key = shifted ? value.slice("Shift+".length) : value;
  if (!APPLICATION_KEY_PRESS_KEYS.has(key)) {
    throw new Error("application key_press supports Enter, Tab, Escape, Backspace, Delete, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Home, End, PageUp, PageDown, Space, with optional Shift+");
  }
  return value;
}
export function normalizeUiSelector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selector must be an object");
  const allowed = new Set(["role", "subrole", "name", "title", "description", "identifier", "index"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown UI selector field: ${key}`);
  const selector = {};
  for (const key of ["role", "subrole", "name", "title", "description", "identifier"]) {
    if (value[key] !== undefined) selector[key] = optionalString(value[key], `selector.${key}`, 500);
  }
  if (value.index !== undefined) selector.index = clampInt(value.index, 0, 0, MAX_UI_ELEMENTS - 1);
  if (!Object.keys(selector).length) throw new Error("selector requires at least one field");
  return selector;
}

export function selectMacWindow(value) {
  const processId = requiredPositiveInteger(value?.process_id, "application process pid");
  const processGeneration = requiredProcessGeneration(value?.process_generation, "application process generation");
  const candidates = Array.isArray(value?.candidates) ? value.candidates.slice(0, 32) : [];
  const normalized = candidates.map((candidate) => {
    const windowId = candidate?.window_id;
    if (!Number.isSafeInteger(windowId) || windowId < 1) return null;
    let bounds;
    try { bounds = requiredWindowBounds(candidate?.bounds); } catch { return null; }
    return { window_id: windowId, bounds, title: typeof candidate?.title === "string" ? candidate.title.slice(0, 1000) : "" };
  }).filter(Boolean);
  if (!normalized.length) throw new Error("application has no capturable on-screen window");
  let frontBounds = null;
  try { frontBounds = requiredWindowBounds(value?.front_bounds); } catch { /* optional front-window bounds */ }
  if (!frontBounds) {
    if (normalized.length === 1) return { ...normalized[0], process_id: processId, process_generation: processGeneration };
    throw new Error("application front window is ambiguous without Accessibility bounds");
  }
  const scored = normalized.map((candidate) => ({ candidate, distance: windowBoundsDistanceNode(candidate.bounds, frontBounds) }));
  const bestDistance = Math.min(...scored.map((item) => item.distance));
  const best = scored.filter((item) => Math.abs(item.distance - bestDistance) <= 0.001).map((item) => item.candidate);
  if (best.length === 1) return { ...best[0], process_id: processId, process_generation: processGeneration };
  const frontTitle = typeof value?.front_title === "string" ? value.front_title.trim().slice(0, 1000) : "";
  if (frontTitle) {
    const titleMatches = best.filter((candidate) => candidate.title.trim() === frontTitle);
    if (titleMatches.length === 1) return { ...titleMatches[0], process_id: processId, process_generation: processGeneration };
  }
  throw new Error("application front window is ambiguous among matching on-screen windows");
}

export function safeSelectedMacWindow(value) {
  try {
    const window = selectMacWindow(value);
    return { id: window.window_id, bounds: { ...window.bounds }, process_id: window.process_id, process_generation: window.process_generation };
  } catch { return null; }
}
export function windowBoundsDistanceNode(left, right) {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y) + Math.abs(left.width - right.width) + Math.abs(left.height - right.height);
}
export function normalizeBackgroundVisualBackend(value) {
  if (value !== undefined && typeof value !== "string") throw new Error("backgroundVisualBackend must be disabled or skylight-experimental");
  const backend = (value || "disabled").trim().toLowerCase();
  if (!["disabled", "skylight-experimental"].includes(backend)) throw new Error("backgroundVisualBackend must be disabled or skylight-experimental");
  return backend;
}
export function normalizedCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) throw new Error(`${label} must be from 0 (inclusive) to 1 (exclusive)`);
  return value;
}
export function applicationWindowPoint(bounds, normalizedX, normalizedY) {
  return {
    screen_x: bounds.x + normalizedX * bounds.width, screen_y: bounds.y + normalizedY * bounds.height,
    local_x: normalizedX * bounds.width, local_y: normalizedY * bounds.height,
  };
}
export function applicationScrollDelta(value, label) {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000) throw new Error(`${label} must be from -10000 to 10000`);
  return Object.is(value, -0) ? 0 : Math.round(value);
}
export function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
export function optionalExpectedProcessId(value) {
  return value === undefined ? null : requiredPositiveInteger(value, "expected_process_id");
}
export function requiredProcessGeneration(value, label) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
export function optionalProcessGeneration(value, label) {
  return value === undefined || value === null ? "" : requiredProcessGeneration(value, label);
}
export function optionalExpectedProcessGeneration(value) {
  return value === undefined ? null : requiredProcessGeneration(value, "expected_process_generation");
}
export function requiredWindowBounds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bounds must be an object");
  const bounds = {};
  for (const key of ["x", "y", "width", "height"]) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`bounds.${key} must be finite`);
    bounds[key] = number;
  }
  if (!(bounds.width > 0) || !(bounds.height > 0)) throw new Error("bounds width and height must be positive");
  return bounds;
}
export function requiredSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return value;
}
export function sameWindowBoundsNode(left, right) {
  if (!left || !right) return false;
  return ["x", "y", "width", "height"].every((key) => {
    const a = left[key]; const b = right[key];
    return typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b) && Math.abs(a - b) <= 1;
  });
}
export function applicationText(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.includes("\0") || value.length > MAX_TEXT_CHARS) throw new Error(`${label} exceeds ${MAX_TEXT_CHARS} characters or contains a NUL byte`);
  return value;
}
export function requiredResourceName(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(value)) throw new Error("value_resource is invalid");
  return value;
}
export function requiredApplicationValueVerificationHandle(value) {
  if (typeof value !== "string" || !/^av_[A-Za-z0-9_-]{24,80}$/.test(value)) throw new Error("application value verification handle is invalid");
  return value;
}
export function optionalString(value, label, maxLength) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) throw new Error(`${label} must be a string of at most ${maxLength} characters without NUL bytes`);
  return value;
}
export function desktopAutomationCapabilities(platform = process.platform) {
  const isDarwin = platform === "darwin";
  return {
    platform, discovery: true, open: true,
    accessibility_inspection: isDarwin, structured_accessibility_actions: isDarwin,
    window_screenshot: isDarwin, arbitrary_script_execution: false,
    permission_note: isDarwin
      ? "UI inspection and actions require macOS Accessibility permission for the Machine Bridge runtime."
      : "Structured UI inspection currently requires macOS; application discovery and opening remain cross-platform.",
  };
}
export function assertMacAccessibility(platform) {
  if (platform !== "darwin") throw new Error("structured application UI automation currently requires macOS");
}
export function optionalBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
export function clampInt(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`expected an integer from ${min} to ${max}`);
  return value;
}
export function isPng(value) {
  return Buffer.isBuffer(value) && value.length >= 8
    && value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47
    && value[4] === 0x0d && value[5] === 0x0a && value[6] === 0x1a && value[7] === 0x0a;
}
export function powershellSingleQuotedLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
