// @ts-check
import { BridgeError } from "./errors.mjs";

const BROWSER_ACTIONS = new Set([
  "navigate", "reload", "back", "forward", "click", "double_click", "hover", "drag", "scroll", "fill", "type_text",
  "select", "check", "uncheck", "focus", "press", "submit", "scroll_into_view",
]);
const APPLICATION_ACTIONS = new Set(["activate", "click", "double_click", "drag", "scroll", "check", "uncheck", "set_value", "focus", "press", "keystroke", "key_press"]);
const INPUT_MODES = new Set(["auto", "trusted", "dom"]);
const NAVIGATION_WAITS = new Set(["none", "domcontentloaded", "complete"]);

export function requiredSurface(value) {
  if (typeof value !== "string" || !["browser", "application"].includes(value)) throw new BridgeError("invalid_request", "surface must be browser or application");
  return value;
}

export function requiredSnapshotId(value) {
  if (typeof value !== "string" || !/^cu_[A-Za-z0-9_-]{8,80}$/.test(value)) throw new BridgeError("invalid_request", "snapshot_id is invalid");
  return value;
}

export function requiredTargetRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("invalid_request", "target must be an object containing a snapshot ref or supported snapshot-bound point");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "ref") throw new BridgeError("invalid_request", "semantic target accepts only ref");
  return requiredString(value.ref, "target.ref", 100);
}

export function normalizeBrowserAction(value) {
  if (typeof value !== "string" || !BROWSER_ACTIONS.has(value)) throw new BridgeError("invalid_request", "unsupported browser computer action");
  return value;
}

export function normalizeApplicationAction(value) {
  if (typeof value !== "string" || !APPLICATION_ACTIONS.has(value)) throw new BridgeError("invalid_request", "unsupported application computer action");
  return value;
}

export function normalizeInputMode(value) {
  if (value === undefined) return "auto";
  if (typeof value !== "string" || !INPUT_MODES.has(value)) throw new BridgeError("invalid_request", "input_mode must be auto, trusted, or dom");
  return value;
}

export function normalizePostScreenshotPolicy(args, surface) {
  if (!["browser", "application"].includes(surface)) return "never";
  if (args.post_screenshot !== undefined && args.include_post_screenshot !== undefined) {
    throw new BridgeError("invalid_request", "post_screenshot and include_post_screenshot are mutually exclusive");
  }
  if (args.include_post_screenshot !== undefined) {
    if (typeof args.include_post_screenshot !== "boolean") throw new BridgeError("invalid_request", "include_post_screenshot must be boolean");
    return args.include_post_screenshot ? "always" : "never";
  }
  if (args.post_screenshot === undefined) return "auto";
  if (typeof args.post_screenshot !== "string" || !["auto", "always", "never"].includes(args.post_screenshot)) {
    throw new BridgeError("invalid_request", "post_screenshot must be auto, always, or never");
  }
  return args.post_screenshot;
}

export function shouldIncludePostScreenshot(policy, { surface, target, expectation, dispatchStatus }) {
  if (!["browser", "application"].includes(surface) || policy === "never") return false;
  if (policy === "always") return true;
  return target?.kind === "point" || expectation?.visual_change !== undefined || dispatchStatus === "unknown";
}

export function normalizePostObservationDetail(value, surface) {
  if (value === undefined) return ["browser", "application"].includes(surface) ? "summary" : "full";
  if (typeof value !== "string" || !["summary", "full"].includes(value)) throw new BridgeError("invalid_request", "post_observation_detail must be summary or full");
  return value;
}

export function normalizeNavigationWait(value) {
  if (value === undefined) return "none";
  if (typeof value !== "string" || !NAVIGATION_WAITS.has(value)) throw new BridgeError("invalid_request", "wait_for must be none, domcontentloaded, or complete");
  return value;
}

export function validateObserveArgs(surface, args) {
  if (surface === "browser") {
    for (const key of ["application", "max_depth", "include_menus"]) {
      if (args[key] !== undefined) throw new BridgeError("invalid_request", `${key} is only valid for application computer observations`);
    }
    return;
  }
  requiredString(args.application, "application", 300);
  for (const key of ["tab_id", "screenshot_format", "screenshot_quality", "all_frames", "max_ax_nodes", "max_frames", "ax_depth"]) {
    if (args[key] !== undefined) throw new BridgeError("invalid_request", `${key} is only valid for browser computer observations`);
  }
}

export function validateSurfaceActionArgs(surface, action, args) {
  if (args.value !== undefined && args.value_resource !== undefined) {
    throw new BridgeError("invalid_request", "value and value_resource are mutually exclusive");
  }
  if (surface === "browser") {
    validateBrowserActionArgs(action, args);
    return;
  }
  validateApplicationActionArgs(action, args);
}

export function validateBrowserActionArgs(action, args) {
  for (const key of ["include_menus", "post_max_depth"]) {
    if (args[key] !== undefined) throw new BridgeError("invalid_request", `${key} is only valid for application computer actions`);
  }
  if (action === "navigate") {
    if (args.url === undefined) throw new BridgeError("invalid_request", "browser navigate requires url");
  } else if (args.url !== undefined) {
    throw new BridgeError("invalid_request", "url is only valid for browser navigate");
  }
  if (action === "drag") {
    if (args.destination === undefined || args.destination === null) throw new BridgeError("invalid_request", "browser drag requires destination");
  } else if (args.destination !== undefined) {
    throw new BridgeError("invalid_request", "destination is only valid for browser drag");
  }
  if (action === "scroll") {
    const deltaX = browserScrollDelta(args.delta_x, "delta_x");
    const deltaY = browserScrollDelta(args.delta_y, "delta_y");
    if (deltaX === 0 && deltaY === 0) throw new BridgeError("invalid_request", "browser scroll requires a non-zero delta_x or delta_y");
  } else if (args.delta_x !== undefined || args.delta_y !== undefined) {
    throw new BridgeError("invalid_request", "delta_x and delta_y are only valid for browser scroll");
  }
  if (args.key !== undefined && action !== "press") throw new BridgeError("invalid_request", "key is only valid for browser press");
  if ((args.value !== undefined || args.value_resource !== undefined) && !["fill", "select", "press", "type_text"].includes(action)) {
    throw new BridgeError("invalid_request", `value is not valid for browser ${action}`);
  }
}

export function validateApplicationActionArgs(action, args) {
  if (action === "drag") {
    if (args.destination === undefined || args.destination === null) throw new BridgeError("invalid_request", "application drag requires destination");
  } else if (args.destination !== undefined) {
    throw new BridgeError("invalid_request", "destination is only valid for drag");
  }
  if (action === "scroll") {
    const deltaX = browserScrollDelta(args.delta_x, "delta_x");
    const deltaY = browserScrollDelta(args.delta_y, "delta_y");
    if (deltaX === 0 && deltaY === 0) throw new BridgeError("invalid_request", "application scroll requires a non-zero delta_x or delta_y");
  } else if (args.delta_x !== undefined || args.delta_y !== undefined) {
    throw new BridgeError("invalid_request", "delta_x and delta_y are only valid for scroll");
  }
  for (const key of ["url", "wait_for", "input_mode", "element_timeout_seconds", "post_max_ax_nodes"]) {
    if (args[key] !== undefined) throw new BridgeError("invalid_request", `${key} is only valid for browser computer actions`);
  }
  if (action === "key_press" && args.key === undefined) throw new BridgeError("invalid_request", "application key_press requires key");
  if (action !== "key_press" && args.key !== undefined) throw new BridgeError("invalid_request", `key is not valid for application ${action}`);
  const carriesValue = args.value !== undefined || args.value_resource !== undefined;
  if (carriesValue && !["set_value", "keystroke"].includes(action)) {
    throw new BridgeError("invalid_request", `value is not valid for application ${action}`);
  }
  if (["set_value", "keystroke"].includes(action) && !carriesValue) {
    throw new BridgeError("invalid_request", `application ${action} requires value or value_resource`);
  }
}

export function validateActionDispatchArguments(surface, action, target, args) {
  clampInt(args.timeout_seconds, 30, 1, 60);
  clampInt(args.verify_timeout_seconds, 5, 1, 60);
  if (surface === "browser") {
    const inputMode = normalizeInputMode(args.input_mode);
    const waitFor = normalizeNavigationWait(args.wait_for);
    clampInt(args.element_timeout_seconds, 10, 1, 60);
    clampInt(args.post_max_elements, 180, 1, 1000);
    clampInt(args.post_max_ax_nodes, 180, 1, 2000);
    if (args.url !== undefined) requiredString(args.url, "url", 32768);
    if (args.value !== undefined) requiredStringAllowEmpty(args.value, "value", 131072);
    if (args.value_resource !== undefined) requiredResource(args.value_resource);
    if (args.key !== undefined) requiredString(args.key, "key", 100);
    if (inputMode === "dom" && (action === "drag" || action === "scroll")) {
      throw new BridgeError("invalid_request", `snapshot-bound ${action} requires trusted browser input`);
    }
    if (inputMode === "dom" && target?.kind === "point") {
      throw new BridgeError("invalid_request", "snapshot-bound visual point actions require trusted input");
    }
    if (waitFor !== "none" && (action === "drag" || action === "scroll")) {
      throw new BridgeError("invalid_request", `wait_for is not supported for ${action}; use expect.* post-conditions instead`);
    }
    if (waitFor !== "none" && target?.kind === "point") {
      throw new BridgeError("invalid_request", "wait_for is not supported for visual point dispatch; use expect.load_state or another post-condition");
    }
    return;
  }
  clampInt(args.post_max_elements, 200, 1, 500);
  clampInt(args.post_max_depth, 6, 1, 12);
  if (args.include_menus !== undefined && typeof args.include_menus !== "boolean") {
    throw new BridgeError("invalid_request", "include_menus must be boolean");
  }
  if (args.value !== undefined) {
    const value = requiredStringAllowEmpty(args.value, "value", 4000);
    if (action === "keystroke" && value.length === 0) throw new BridgeError("invalid_request", "application keystroke requires non-empty text");
  }
  if (args.value_resource !== undefined) requiredResource(args.value_resource);
  if (args.key !== undefined) requiredString(args.key, "key", 100);
}

export function validateDragTargets(surface, target, destination) {
  if (!target || !destination) throw new BridgeError("invalid_request", `${surface} drag requires both target and destination`);
  if (surface === "application") {
    if (target.kind !== "point" || destination.kind !== "point") {
      throw new BridgeError("invalid_request", "application drag currently requires normalized point source and destination from the same window snapshot");
    }
    return;
  }
  if (target.kind !== destination.kind) {
    throw new BridgeError("invalid_request", "browser drag target and destination must both use refs or both use normalized points");
  }
}

export function browserScrollDelta(value, label) {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000) {
    throw new BridgeError("invalid_request", `${label} must be a finite number from -10000 to 10000`);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function optionalApplicationFocusQuery(value) {
  if (value === undefined) return "";
  return requiredStringAllowEmpty(value, "focus_query", 1000);
}

export function requiredResource(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(value)) {
    throw new BridgeError("invalid_request", "value_resource is invalid");
  }
  return value;
}

export function optionalPositiveInt(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new BridgeError("invalid_request", `${label} must be a positive integer`);
  return value;
}

export function clampInt(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new BridgeError("invalid_request", `expected an integer from ${min} to ${max}`);
  return value;
}

export function requiredString(value, label, maxLength) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > maxLength) {
    throw new BridgeError("invalid_request", `${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

export function requiredStringAllowEmpty(value, label, maxLength) {
  if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) {
    throw new BridgeError("invalid_request", `${label} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

export function optionalBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  return requiredBoolean(value, label);
}

export function computerScreenshotFormat(value) {
  if (value === undefined) return "png";
  if (value !== "png" && value !== "jpeg") throw new BridgeError("invalid_request", "screenshot_format must be png or jpeg");
  return value;
}

export function requiredBoolean(value, label) {
  if (typeof value !== "boolean") throw new BridgeError("invalid_request", `${label} must be boolean`);
  return value;
}
