// @ts-check
import { BridgeError, errorCode } from "../core/errors.mjs";
import { performance } from "node:perf_hooks";

const BROWSER_ACTIONS = new Set([
  "navigate", "reload", "back", "forward", "click", "double_click", "hover", "drag", "scroll", "fill", "type_text",
  "select", "check", "uncheck", "focus", "press", "submit", "scroll_into_view",
]);

const APPLICATION_ACTIONS = new Set(["activate", "click", "double_click", "drag", "scroll", "check", "uncheck", "set_value", "focus", "press", "keystroke", "key_press"]);

const INPUT_MODES = new Set(["auto", "trusted", "dom"]);

const NAVIGATION_WAITS = new Set(["none", "domcontentloaded", "complete"]);

/** @typedef {"browser" | "application"} ComputerSurface */
/** @typedef {Record<string, unknown>} ComputerArgs */
/** @typedef {{kind?: string, [key: string]: unknown} | null | undefined} ComputerTarget */

/** @param {unknown} value @returns {ComputerSurface} */
export function requiredSurface(value) {
  if (typeof value !== "string" || !["browser", "application"].includes(value)) throw new BridgeError("invalid_request", "surface must be browser or application");
  return /** @type {ComputerSurface} */ (value);
}

/** @param {unknown} value */
export function requiredSnapshotId(value) {
  if (typeof value !== "string" || !/^cu_[A-Za-z0-9_-]{8,80}$/.test(value)) throw new BridgeError("invalid_request", "snapshot_id is invalid");
  return value;
}

/** @param {unknown} value */
export function requiredTargetRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("invalid_request", "target must be an object containing a snapshot ref or supported snapshot-bound point");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "ref") throw new BridgeError("invalid_request", "semantic target accepts only ref");
  return requiredString(/** @type {Record<string, unknown>} */ (value).ref, "target.ref", 100);
}

/** @param {unknown} value */
export function normalizeBrowserAction(value) {
  if (typeof value !== "string" || !BROWSER_ACTIONS.has(value)) throw new BridgeError("invalid_request", "unsupported browser computer action");
  return value;
}

/** @param {unknown} value */
export function normalizeApplicationAction(value) {
  if (typeof value !== "string" || !APPLICATION_ACTIONS.has(value)) throw new BridgeError("invalid_request", "unsupported application computer action");
  return value;
}

/** @param {unknown} value */
export function normalizeInputMode(value) {
  if (value === undefined) return "auto";
  if (typeof value !== "string" || !INPUT_MODES.has(value)) throw new BridgeError("invalid_request", "input_mode must be auto, trusted, or dom");
  return value;
}

/** @param {ComputerArgs} args @param {string} surface */
export function normalizePostScreenshotPolicy(args, surface) {
  if (!["browser", "application"].includes(surface)) return "never";
  if (Object.hasOwn(args, "include_post_screenshot")) {
    throw new BridgeError("invalid_request", "include_post_screenshot is no longer supported; use post_screenshot");
  }
  if (args.post_screenshot === undefined) return "auto";
  if (typeof args.post_screenshot !== "string" || !["auto", "always", "never"].includes(args.post_screenshot)) {
    throw new BridgeError("invalid_request", "post_screenshot must be auto, always, or never");
  }
  return args.post_screenshot;
}

/** @param {string} policy @param {{surface: string, target?: ComputerTarget, expectation?: {visual_change?: unknown} | null, dispatchStatus?: string}} options */
export function shouldIncludePostScreenshot(policy, { surface, target, expectation, dispatchStatus }) {
  if (!["browser", "application"].includes(surface) || policy === "never") return false;
  if (policy === "always") return true;
  return target?.kind === "point" || expectation?.visual_change !== undefined || dispatchStatus === "unknown";
}

/** @param {unknown} value @param {string} surface */
export function normalizePostObservationDetail(value, surface) {
  if (value === undefined) return ["browser", "application"].includes(surface) ? "summary" : "full";
  if (typeof value !== "string" || !["summary", "full"].includes(value)) throw new BridgeError("invalid_request", "post_observation_detail must be summary or full");
  return value;
}

/** @param {unknown} value */
export function normalizeNavigationWait(value) {
  if (value === undefined) return "none";
  if (typeof value !== "string" || !NAVIGATION_WAITS.has(value)) throw new BridgeError("invalid_request", "wait_for must be none, domcontentloaded, or complete");
  return value;
}

/** @param {string} surface @param {ComputerArgs} args */
export function validateObserveArgs(surface, args) {
  for (const key of ["include_marks", "set_of_marks"]) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") {
      throw new BridgeError("invalid_request", `${key} must be boolean`);
    }
  }
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

/** @param {string} surface @param {string} action @param {ComputerArgs} args */
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

/** @param {string} action @param {ComputerArgs} args */
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

/** @param {string} action @param {ComputerArgs} args */
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

/** @param {string} surface @param {string} action @param {ComputerTarget} target @param {ComputerArgs} args */
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

/** @param {string} surface @param {ComputerTarget} target @param {ComputerTarget} destination */
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

/** @param {unknown} value @param {string} label */
export function browserScrollDelta(value, label) {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000) {
    throw new BridgeError("invalid_request", `${label} must be a finite number from -10000 to 10000`);
  }
  return Object.is(value, -0) ? 0 : value;
}

/** @param {unknown} value */
export function optionalApplicationFocusQuery(value) {
  if (value === undefined) return "";
  return requiredStringAllowEmpty(value, "focus_query", 1000);
}

/** @param {unknown} value */
export function requiredResource(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(value)) {
    throw new BridgeError("invalid_request", "value_resource is invalid");
  }
  return value;
}

/** @param {unknown} value @param {string} label */
export function optionalPositiveInt(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new BridgeError("invalid_request", `${label} must be a positive integer`);
  return value;
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
export function clampInt(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new BridgeError("invalid_request", `expected an integer from ${min} to ${max}`);
  return value;
}

/** @param {unknown} value @param {string} label @param {number} maxLength */
export function requiredString(value, label, maxLength) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > maxLength) {
    throw new BridgeError("invalid_request", `${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {number} maxLength */
export function requiredStringAllowEmpty(value, label, maxLength) {
  if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) {
    throw new BridgeError("invalid_request", `${label} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {boolean} fallback */
export function optionalBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  return requiredBoolean(value, label);
}

/** @param {unknown} value */
export function computerScreenshotFormat(value) {
  if (value === undefined) return "png";
  if (value !== "png" && value !== "jpeg") throw new BridgeError("invalid_request", "screenshot_format must be png or jpeg");
  return value;
}

/** @param {unknown} value @param {string} label */
export function requiredBoolean(value, label) {
  if (typeof value !== "boolean") throw new BridgeError("invalid_request", `${label} must be boolean`);
  return value;
}
export const APPLICATION_OPERATION_REASON = Object.freeze({
  PROCESS_IDENTITY_CHANGED: "application_process_identity_changed",
  VISUAL_SNAPSHOT_CHANGED: "application_visual_snapshot_changed",
  VISUAL_PREFLIGHT_UNAVAILABLE: "application_visual_preflight_unavailable",
  INPUT_PREFLIGHT_UNAVAILABLE: "application_input_preflight_unavailable",
  INPUT_OUTCOME_UNKNOWN: "application_input_outcome_unknown",
  TARGET_GEOMETRY_CHANGED: "application_target_geometry_changed",
  CHECKED_STATE_CHANGED: "application_checked_state_changed",
  CHECKED_STATE_INPUT_UNAVAILABLE: "application_checked_state_input_unavailable",
});

/** @param {unknown} error */
export function applicationOperationReason(error) {
  if (!(error instanceof BridgeError)) return "";
  return typeof error.details?.reason === "string" ? error.details.reason : "";
}

/** @param {string} message @param {unknown} [cause] */
export function applicationProcessIdentityChanged(message, cause = null) {
  return applicationOperationError("conflict", APPLICATION_OPERATION_REASON.PROCESS_IDENTITY_CHANGED, message, cause, false);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationVisualSnapshotChanged(message, cause = null) {
  return applicationOperationError("conflict", APPLICATION_OPERATION_REASON.VISUAL_SNAPSHOT_CHANGED, message, cause, false);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationVisualPreflightUnavailable(message, cause = null) {
  return applicationOperationError("unavailable", APPLICATION_OPERATION_REASON.VISUAL_PREFLIGHT_UNAVAILABLE, message, cause, true);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationInputPreflightUnavailable(message, cause = null) {
  return applicationOperationError("unavailable", APPLICATION_OPERATION_REASON.INPUT_PREFLIGHT_UNAVAILABLE, message, cause, true);
}

/**
 * @param {string} message
 * @param {unknown} [cause]
 * @param {Record<string, unknown>} [details]
 */
export function applicationInputOutcomeUnknown(message, cause = null, details = {}) {
  return applicationOperationError("execution_failed", APPLICATION_OPERATION_REASON.INPUT_OUTCOME_UNKNOWN, message, cause, false, details);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationTargetGeometryChanged(message, cause = null) {
  return applicationOperationError("conflict", APPLICATION_OPERATION_REASON.TARGET_GEOMETRY_CHANGED, message, cause, false);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationCheckedStateChanged(message, cause = null) {
  return applicationOperationError("conflict", APPLICATION_OPERATION_REASON.CHECKED_STATE_CHANGED, message, cause, false);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationCheckedStateInputUnavailable(message, cause = null) {
  return applicationOperationError("unavailable", APPLICATION_OPERATION_REASON.CHECKED_STATE_INPUT_UNAVAILABLE, message, cause, true);
}

/**
 * Convert fixed JXA helper wire messages at the subprocess boundary. Callers above this boundary
 * consume stable reasons and never infer execution semantics from human-readable text.
 * @param {string} message
 * @returns {BridgeError | null}
 */
export function applicationAutomationBoundaryError(message) {
  if (message === "application process changed before operation"
      || message === "application process generation changed before operation") {
    return applicationProcessIdentityChanged(message);
  }
  if (message === "application target window changed before dispatch"
      || message === "application target geometry changed before dispatch") {
    return applicationTargetGeometryChanged(message);
  }
  if (message === "application target checked state is unavailable before dispatch"
      || message === "application check target is not an Accessibility checkbox or radio button"
      || message === "application uncheck target is not an Accessibility checkbox") {
    return applicationCheckedStateChanged(message);
  }
  if (message === "application target does not expose AXPress before checked-state dispatch") {
    return applicationCheckedStateInputUnavailable(message);
  }
  return null;
}

/**
 * @param {string} code
 * @param {string} reason
 * @param {string} message
 * @param {unknown} cause
 * @param {boolean} retryable
 * @param {Record<string, unknown>} [details]
 */
function applicationOperationError(code, reason, message, cause, retryable, details = {}) {
  return new BridgeError(code, message, {
    retryable,
    cause: cause instanceof Error ? cause : undefined,
    details: { reason, ...details },
  });
}

const UNKNOWN_MUTATION_ERROR_PREFIXES = Object.freeze([
  "browser mutation request may have been dispatched",
  "browser mutation may have completed;",
  "browser action may have been dispatched",
  "trusted browser input may have been partially dispatched",
  "form submission failed after partial changes",
  "browser tab mutation may have been dispatched",
  "browser screenshot temporary tab activation may have been dispatched",
  "browser screenshot restoration may have been dispatched",
]);

/**
 * @template T
 * @param {string} surface
 * @param {() => Promise<T>} dispatch
 */
export async function settleComputerUseDispatch(surface, dispatch) {
  try {
    return { dispatchStatus: "completed", dispatchResult: await dispatch(), dispatchError: "" };
  } catch (error) {
    if (!isUnknownOutcomeError(surface, error)) throw error;
    return { dispatchStatus: "unknown", dispatchResult: null, dispatchError: publicUnknownOutcomeError(surface, error) };
  }
}

/** @param {string} surface @param {unknown} error */
function isUnknownOutcomeError(surface, error) {
  if (surface === "application") {
    return applicationOperationReason(error) === APPLICATION_OPERATION_REASON.INPUT_OUTCOME_UNKNOWN;
  }
  const settlement = error instanceof BridgeError ? error.details?.effect_settlement : undefined;
  if (settlement === "unknown" || settlement === "pending") return true;
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return UNKNOWN_MUTATION_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/** @param {string} surface @param {unknown} error */
function publicUnknownOutcomeError(surface, error) {
  const normalizedSurface = surface === "application" ? "application" : "browser";
  const inspection = normalizedSurface === "application" ? "Inspect the application" : "Inspect browser state";
  return `${normalizedSurface} mutation may have been dispatched; the outcome is unknown. ${inspection} before retrying. (error_class=${errorCode(error)})`;
}
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

const MAX_SNAPSHOTS = 64;

/** @typedef {{ createdAt: number, observation: Record<string, any>, privateState: any }} SnapshotItem */
export class ComputerUseSnapshotStore {
  /** @param {{ now?: () => number, createId: () => string }} options */
  constructor({ now = () => performance.now(), createId }) {
    if (typeof createId !== "function") throw new TypeError("computer snapshot store requires an id factory");
    this.now = now;
    this.createId = createId;
    /** @type {Map<string, SnapshotItem>} */
    this.items = new Map();
    /** @type {number | null} */
    this.lastNow = null;
  }
  /** @param {Record<string, any>} observation @param {any} [privateState] */
  add(observation, privateState = null) {
    this.prune();
    while (this.items.size >= MAX_SNAPSHOTS) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    let id = this.createId();
    while (this.items.has(id)) id = this.createId();
    this.items.set(id, { createdAt: this.readNow(), observation, privateState });
    return id;
  }
  /** @param {string} id */
  get(id) {
    this.prune();
    const item = this.items.get(id);
    if (!item) throw missingSnapshot("computer snapshot is missing or expired; observe again before acting");
    this.items.delete(id);
    this.items.set(id, item);
    return item;
  }
  /** @param {string} id @param {SnapshotItem} expected */
  claim(id, expected) {
    this.prune();
    const item = this.items.get(id);
    if (!item || item !== expected) throw missingSnapshot("computer snapshot is missing, expired, or already consumed; observe again before acting");
    this.items.delete(id);
    return item;
  }
  /** @param {string} id */
  discard(id) {
    if (id) this.items.delete(id);
  }
  prune() {
    const cutoff = this.readNow() - SNAPSHOT_TTL_MS;
    for (const [id, item] of this.items) if (item.createdAt < cutoff) this.items.delete(id);
  }
  /** @returns {number} */
  readNow() {
    const value = Number(this.now());
    if (!Number.isFinite(value)) throw new TypeError("computer snapshot monotonic clock returned a non-finite value");
    if (this.lastNow === null || value > this.lastNow) this.lastNow = value;
    return /** @type {number} */ (this.lastNow);
  }
}

/** @param {string} message */
function missingSnapshot(message) {
  return new BridgeError("conflict", message, { details: { reason: "snapshot_missing_or_expired" } });
}
