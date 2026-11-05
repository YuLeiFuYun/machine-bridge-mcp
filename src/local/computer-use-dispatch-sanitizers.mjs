import { BridgeError, errorCode } from "./errors.mjs";
import { clampInt } from "./computer-use-arguments.mjs";
import { APPLICATION_OPERATION_REASON, applicationOperationReason } from "./computer-use-dispatch-settlement.mjs";
import { applicationMatchesSelector } from "./computer-use-application-observation.mjs";
import {
  normalizedWindowBounds, sanitizeApplicationPointCandidate, sanitizeVisualHit, staleSnapshot, browserObservationSemanticEpoch, normalizedPointCoordinate, validPointScreenshotQuality, positiveNativeViewport,
} from "./computer-use-application-geometry.mjs";

const BROWSER_POINT_ACTIONS = new Set(["click", "double_click", "hover", "drag", "scroll"]);
const BROWSER_BACKEND_TRUSTED_ACTIONS = new Set(["click", "double_click", "hover", "press", "type_text", "fill", "check", "uncheck", "submit"]);
const BROWSER_BACKEND_TEXT_ACTIONS = new Set(["type_text", "fill"]);
const BROWSER_SNAPSHOT_IDENTITY_FIELDS = Object.freeze([
  "tag", "type", "role", "name", "id", "field_name", "label", "placeholder", "href", "sensitive", "in_shadow_dom",
]);
const BROWSER_SNAPSHOT_BOOLEAN_IDENTITY_FIELDS = new Set(["sensitive", "in_shadow_dom"]);

export function browserPostFocusQuery(target) {
  if (!target || target.kind !== "ref") return undefined;
  const element = target.element || {};
  const value = element.name || element.label || element.placeholder || element.text || element.id || "";
  return String(value).trim().slice(0, 1000) || undefined;
}

export function findApplicationMatch(elements, selector, occurrence) {
  const matches = elements.filter((element) => applicationMatchesSelector(element, selector));
  return matches[occurrence] || null;
}

export function findPostApplicationTarget(observation, privateState, target) {
  const record = findPostApplicationTargetBinding(observation, privateState, target);
  if (record) return record.element;
  if (privateState?.application_ref_bindings?.entries) return null;
  return findApplicationMatch(observation.semantic?.elements || [], target.selector, target.occurrence);
}

export function findPostApplicationTargetBinding(observation, privateState, target) {
  const bindings = privateState?.application_ref_bindings;
  if (bindings?.entries) {
    const expectedSelector = JSON.stringify(target.selector || {});
    for (const [ref, binding] of bindings.entries()) {
      if (binding?.occurrence !== target.occurrence || JSON.stringify(binding?.selector || {}) !== expectedSelector) continue;
      if (!applicationPostOwnerWindowContinues(target?.owner_window_bounds, binding?.owner_window_bounds)) return null;
      const element = (observation.semantic?.elements || []).find((candidate) => candidate?.ref === ref) || null;
      if (element) return { ref, element, binding };
    }
  }
  return null;
}

function applicationPostOwnerWindowContinues(beforeBounds, afterBounds) {
  const before = normalizedWindowBounds(beforeBounds);
  const after = normalizedWindowBounds(afterBounds);
  if (!before && !after) return true;
  if (!before || !after) return false;
  return ["x", "y", "width", "height"].every((key) => Math.abs(before[key] - after[key]) <= 1);
}

export function sanitizeDispatchResult(surface, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const point = value.point ? sanitizeDispatchPoint(value.point) : null;
  const destinationPoint = value.destination_point ? sanitizeDispatchPoint(value.destination_point) : null;
  const scrollDelta = sanitizeDispatchScrollDelta(value.scroll_delta);
  if (surface === "browser") {
    return {
      ok: value.ok === true,
      input_mode: typeof value.input_mode === "string" ? value.input_mode : "",
      trusted_input_fallback: value.trusted_input_fallback === true,
      coordinate_source: typeof value.coordinate_source === "string" ? value.coordinate_source : "",
      cross_frame_trusted: value.cross_frame_trusted === true,
      no_input_required: value.no_input_required === true,
      tab_id: Number.isSafeInteger(value.tab_id) && value.tab_id > 0 ? value.tab_id : null,
      url: typeof value.url === "string" ? value.url : "",
      title: typeof value.title === "string" ? value.title : "",
      tab_metadata_verified: value.tab_metadata_verified === true,
      ...(point ? { point } : {}),
      ...(destinationPoint ? { destination_point: destinationPoint } : {}),
      ...(scrollDelta ? { scroll_delta: scrollDelta } : {}),
      ...(value.hit ? { hit: sanitizeVisualHit(value.hit) } : {}),
      ...(value.destination_hit ? { destination_hit: sanitizeVisualHit(value.destination_hit) } : {}),
    };
  }
  const normalizedPoint = sanitizeNormalizedResultPoint(value.normalized_point);
  const destinationNormalizedPoint = sanitizeNormalizedResultPoint(value.destination_normalized_point);
  return {
    ok: value.ok === true,
    matched: Number.isSafeInteger(value.matched) && value.matched >= 0 ? value.matched : 0,
    selected_index: Number.isSafeInteger(value.selected_index) && value.selected_index >= 0 ? value.selected_index : null,
    no_input_required: value.no_input_required === true,
    checked_before: typeof value.checked_before === "boolean" ? value.checked_before : null,
    checked_after: typeof value.checked_after === "boolean" ? value.checked_after : null,
    coordinate_source: typeof value.coordinate_source === "string" ? value.coordinate_source : "",
    input_transport: typeof value.input_transport === "string" ? value.input_transport : "",
    focus_prepared: value.focus_prepared === true,
    window_bound: value.window_bound === true,
    screenshot_revalidated: value.screenshot_revalidated === true,
    experimental_backend: value.experimental_backend === true,
    focus_without_raise: value.focus_without_raise === true,
    front_window_validated: value.front_window_validated === true,
    cursor_preserved: typeof value.cursor_preserved === "boolean" ? value.cursor_preserved : null,
    frontmost_restored: value.frontmost_restored === true,
    ...(normalizedPoint ? { normalized_point: normalizedPoint } : {}),
    ...(destinationNormalizedPoint ? { destination_normalized_point: destinationNormalizedPoint } : {}),
    ...(scrollDelta ? { scroll_delta: scrollDelta } : {}),
    ...(Array.isArray(value.semantic_point_candidates) ? { semantic_point_candidates: value.semantic_point_candidates.slice(0, 4).map(sanitizeApplicationPointCandidate) } : {}),
  };
}

function sanitizeDispatchScrollDelta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deltaX = value.delta_x;
  const deltaY = value.delta_y;
  if (typeof deltaX !== "number" || !Number.isFinite(deltaX) || typeof deltaY !== "number" || !Number.isFinite(deltaY)) return null;
  return { delta_x: Object.is(deltaX, -0) ? 0 : deltaX, delta_y: Object.is(deltaY, -0) ? 0 : deltaY };
}

function sanitizeNormalizedResultPoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = value.x;
  const y = value.y;
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x >= 1
      || typeof y !== "number" || !Number.isFinite(y) || y < 0 || y >= 1) return null;
  return { x: Object.is(x, -0) ? 0 : x, y: Object.is(y, -0) ? 0 : y };
}

export async function trySnapshotBoundBackendAction({ browser, observation, action, target, args, context, inputMode, navigationWait }) {
  const backendTextEligible = !BROWSER_BACKEND_TEXT_ACTIONS.has(action) || target?.element?.editable !== false;
  if (target?.kind !== "ref" || !target.trusted_binding || !BROWSER_BACKEND_TRUSTED_ACTIONS.has(action) || !backendTextEligible || inputMode === "dom") return null;
  try {
    const result = await browser.backendNodeAction({
      tab_id: observation.target.tab_id,
      action,
      backend_node_id: target.trusted_binding.backend_node_id,
      extension_frame_id: target.trusted_binding.extension_frame_id,
      frame_document_epoch: target.trusted_binding.extension_frame_epoch,
      frame_url: target.trusted_binding.extension_frame_url,
      extension_ref: target.ref,
      expected_ref_identity: browserSnapshotIdentity(target.element),
      document_epoch: browserObservationSemanticEpoch(observation),
      value: args.value,
      value_resource: args.value_resource,
      key: args.key,
      timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
    }, context);
    if (navigationWait !== "none") {
      try {
        await browser.wait({
          tab_id: observation.target.tab_id,
          load_state: navigationWait,
          timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
        }, context);
      } catch (error) {
        throw browserPostDispatchWaitUnknown(error);
      }
    }
    return result;
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("snapshot backend target changed before trusted input; observe again")
        || message.includes("snapshot_backend_target_changed_before_dispatch")) {
      throw staleSnapshot("browser semantic target changed before trusted input");
    }
    if (message.includes("outcome is unknown")) throw error;
    if (message.includes("trusted browser input may have been partially dispatched")) throw error;
    if (inputMode === "trusted") throw backendTrustedUnavailable();
    return null;
  }
}

export function browserSnapshotDispatchError(error) {
  const message = String(error?.message || error);
  if (message.includes("snapshot ref identity changed before dispatch; observe again")
      || message.includes("snapshot_ref_identity_changed_before_dispatch")) {
    return staleSnapshot("browser semantic target identity changed before input");
  }
  if (message.includes("snapshot browser tab changed before navigation dispatch; observe again")) {
    return staleSnapshot("browser tab URL changed immediately before the navigation action");
  }
  if (message.includes("snapshot browser tab could not be verified before navigation dispatch; observe again")) {
    return new BridgeError("unavailable", "cannot validate the browser tab immediately before this navigation action; observe again", {
      details: { reason: "browser_navigation_last_hop_unavailable" },
    });
  }
  if (message.includes("snapshot history document changed before dispatch; observe again")) {
    return staleSnapshot("browser document changed immediately before the history action");
  }
  if (message.includes("snapshot history document could not be verified before dispatch; observe again")) {
    return new BridgeError("unavailable", "cannot validate the browser document immediately before this history action; observe again", {
      details: { reason: "browser_document_last_hop_unavailable" },
    });
  }
  if (message.includes("snapshot history entry changed before dispatch; observe again")) {
    return staleSnapshot("browser history entry changed immediately before the history action");
  }
  if (message.includes("snapshot history entry could not be verified before dispatch; observe again")) {
    return new BridgeError("unavailable", "cannot validate the browser history entry immediately before this history action; observe again", {
      details: { reason: "browser_history_last_hop_unavailable" },
    });
  }
  if (message.includes("snapshot browser history has no back entry before dispatch; observe again")
      || message.includes("snapshot browser history has no forward entry before dispatch; observe again")) {
    return new BridgeError("unavailable", "the requested browser history direction is unavailable in this snapshot; observe again", {
      details: { reason: "browser_history_direction_unavailable" },
    });
  }
  if (message.includes("snapshot history mutation API is unavailable before dispatch; observe again")) {
    return new BridgeError("unavailable", "the snapshot-bound browser history mutation API is unavailable; observe again", {
      details: { reason: "browser_history_mutation_api_unavailable" },
    });
  }
  return error instanceof Error ? error : new Error(message);
}

function backendTrustedUnavailable() {
  return new BridgeError("unavailable", "snapshot-bound trusted input is unavailable for this semantic target", {
    details: { reason: "snapshot_backend_trusted_input_unavailable" },
  });
}

function browserPostDispatchWaitUnknown(error) {
  return new BridgeError(errorCode(error), "browser action may have been dispatched; the action outcome is unknown because post-dispatch wait failed. Inspect the page before retrying.", {
    cause: error instanceof Error ? error : undefined,
  });
}

function sanitizeDispatchPoint(point) {
  if (!point || typeof point !== "object" || Array.isArray(point)) return null;
  if (typeof point.normalized_x === "number" && Number.isFinite(point.normalized_x) && point.normalized_x >= 0 && point.normalized_x < 1
      && typeof point.normalized_y === "number" && Number.isFinite(point.normalized_y) && point.normalized_y >= 0 && point.normalized_y < 1
      && typeof point.css_x === "number" && Number.isFinite(point.css_x)
      && typeof point.css_y === "number" && Number.isFinite(point.css_y)) {
    return { normalized_x: point.normalized_x, normalized_y: point.normalized_y, css_x: point.css_x, css_y: point.css_y };
  }
  if (typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)) {
    return { css_x: point.x, css_y: point.y };
  }
  return null;
}

export function optionalPrivateApplicationProcessId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function requiredPrivateApplicationProcessId(value) {
  const processId = optionalPrivateApplicationProcessId(value);
  if (!processId) {
    throw new BridgeError("unavailable", "application process identity is unavailable for snapshot-bound Computer Use", {
      details: { reason: "application_process_identity_unavailable" },
    });
  }
  return processId;
}

export function optionalPrivateApplicationProcessGeneration(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\r\n\0]/.test(value)) return null;
  return value;
}

export function requiredPrivateApplicationProcessGeneration(value) {
  const generation = optionalPrivateApplicationProcessGeneration(value);
  if (!generation) {
    throw new BridgeError("unavailable", "application process generation is unavailable for snapshot-bound Computer Use", {
      details: { reason: "application_process_identity_unavailable" },
    });
  }
  return generation;
}

export function applicationProcessChanged(beforePrivateState, afterPrivateState) {
  const beforeId = optionalPrivateApplicationProcessId(beforePrivateState?.application_process_id);
  const afterId = optionalPrivateApplicationProcessId(afterPrivateState?.application_process_id);
  const beforeGeneration = optionalPrivateApplicationProcessGeneration(beforePrivateState?.application_process_generation);
  const afterGeneration = optionalPrivateApplicationProcessGeneration(afterPrivateState?.application_process_generation);
  if (!beforeId || !afterId || !beforeGeneration || !afterGeneration) return null;
  return beforeId !== afterId || beforeGeneration !== afterGeneration;
}

export function applicationProcessIdentityError(error) {
  return applicationOperationReason(error) === APPLICATION_OPERATION_REASON.PROCESS_IDENTITY_CHANGED;
}

export function applicationVisualDispatchError(error, { staleDetail, processDetail, unavailableMessage }) {
  const reason = applicationOperationReason(error);
  if (reason === APPLICATION_OPERATION_REASON.VISUAL_SNAPSHOT_CHANGED) throw staleSnapshot(staleDetail);
  if (reason === APPLICATION_OPERATION_REASON.PROCESS_IDENTITY_CHANGED) throw staleSnapshot(processDetail);
  if (reason === APPLICATION_OPERATION_REASON.VISUAL_PREFLIGHT_UNAVAILABLE
      || reason === APPLICATION_OPERATION_REASON.INPUT_PREFLIGHT_UNAVAILABLE) {
    throw new BridgeError("unavailable", unavailableMessage, {
      cause: error instanceof Error ? error : undefined,
      details: { reason: "application_visual_preflight_unavailable" },
    });
  }
  return error;
}

export function applicationProcessIdentityMatches(value, expectedProcessId, expectedProcessGeneration) {
  return requiredPrivateApplicationProcessId(value?._machine_process_id) === expectedProcessId
    && requiredPrivateApplicationProcessGeneration(value?._machine_process_generation) === expectedProcessGeneration;
}

export function isVisualPointTarget(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "point"));
}

export function browserPointTarget(observation, action, value) {
  if (!BROWSER_POINT_ACTIONS.has(action)) throw new BridgeError("invalid_request", `visual point target is not valid for browser ${action}`);
  const keys = Object.keys(value || {});
  if (keys.length !== 1 || keys[0] !== "point") throw new BridgeError("invalid_request", "visual target accepts only point");
  const point = value.point;
  if (!point || typeof point !== "object" || Array.isArray(point)) throw new BridgeError("invalid_request", "target.point must be an object");
  const pointKeys = Object.keys(point);
  if (pointKeys.some((key) => !["x", "y", "space"].includes(key)) || !pointKeys.includes("x") || !pointKeys.includes("y")) {
    throw new BridgeError("invalid_request", "target.point requires only x, y, and optional space");
  }
  const space = point.space === undefined ? "normalized_viewport" : point.space;
  if (typeof space !== "string" || space !== "normalized_viewport") throw new BridgeError("invalid_request", "target.point.space must be normalized_viewport");
  const x = normalizedPointCoordinate(point.x, "target.point.x");
  const y = normalizedPointCoordinate(point.y, "target.point.y");
  if (observation.capture?.screenshot !== true || observation.capture?.screenshot_source !== "cdp_surface" || observation.capture?.navigation_coherent !== true) {
    throw new BridgeError("conflict", "visual point action requires a navigation-coherent CDP screenshot from this snapshot", {
      details: { reason: "visual_snapshot_not_actionable" },
    });
  }
  const screenshotDigest = observation.capture?.screenshot_sha256;
  const screenshotSha256 = typeof screenshotDigest === "string" ? screenshotDigest.toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(screenshotSha256)) {
    throw new BridgeError("conflict", "visual point action requires the screenshot fingerprint from this snapshot", {
      details: { reason: "visual_snapshot_fingerprint_missing" },
    });
  }
  const viewport = observation.semantic?.viewport;
  if (!positiveNativeViewport(viewport)) {
    throw new BridgeError("conflict", "visual point action requires viewport metadata from the screenshot snapshot", {
      details: { reason: "visual_viewport_missing" },
    });
  }
  return {
    kind: "point",
    normalized_x: x,
    normalized_y: y,
    viewport: { width: viewport.width, height: viewport.height, scale: viewport.scale },
    screenshot_sha256: screenshotSha256,
    screenshot_format: observation.capture?.screenshot_format === "jpeg" ? "jpeg" : "png",
    screenshot_quality: validPointScreenshotQuality(observation.capture?.screenshot_quality),
  };
}

export function browserSnapshotIdentity(element) {
  const output = {};
  for (const field of BROWSER_SNAPSHOT_IDENTITY_FIELDS) {
    if (!Object.hasOwn(element || {}, field)) continue;
    const value = element[field];
    const valid = BROWSER_SNAPSHOT_BOOLEAN_IDENTITY_FIELDS.has(field) ? typeof value === "boolean" : typeof value === "string";
    if (!valid) throw staleSnapshot("browser snapshot target identity is malformed");
    output[field] = value;
  }
  return Object.keys(output).length ? output : null;
}
