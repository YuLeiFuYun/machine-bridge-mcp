import { BridgeError, errorCode } from "../core/errors.mjs";
import { requiredBoolean, requiredString, clampInt, computerScreenshotFormat, optionalBoolean, optionalPositiveInt, requiredStringAllowEmpty } from "./computer-use-contracts.mjs";

function computerUseRemainingTimeoutSeconds(deadline, maximumSeconds) {
  if (!deadline || typeof deadline.remainingMs !== "function") return maximumSeconds;
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) return 0;
  return Math.max(0, Math.min(maximumSeconds, Math.floor(remainingMs / 1000)));
}

export function computerActRemainingTimeoutSeconds(deadline, maximumSeconds) {
  return computerUseRemainingTimeoutSeconds(deadline, maximumSeconds);
}

export function requiredComputerActRemainingTimeoutSeconds(deadline, maximumSeconds) {
  const remainingSeconds = computerUseRemainingTimeoutSeconds(deadline, maximumSeconds);
  if (remainingSeconds > 0) return remainingSeconds;
  throw new BridgeError("timeout", "computer action timed out before mutation dispatch", {
    details: { reason: "computer_action_deadline_exhausted", side_effects_started: false },
  });
}

export function requiredComputerObserveRemainingTimeoutSeconds(deadline, maximumSeconds) {
  const remainingSeconds = computerUseRemainingTimeoutSeconds(deadline, maximumSeconds);
  if (remainingSeconds > 0) return remainingSeconds;
  throw new BridgeError("timeout", "computer observation timed out before semantic capture completed", {
    details: { reason: "computer_observe_deadline_exhausted", side_effects_started: false },
  });
}

export function computerActVerificationTimeoutProbe() {
  return {
    requested: true,
    matched: false,
    inconclusive: true,
    reason: "post_conditions_inconclusive",
    post_checks: [],
  };
}

export function publicPostObservationError(surface, error) {
  const normalizedSurface = surface === "application" ? "application" : "browser";
  return `${normalizedSurface} post observation unavailable (error_class=${errorCode(error)})`;
}

export function computerActPostObservationTimeoutError(surface) {
  return publicPostObservationError(
    surface,
    new BridgeError("timeout", "computer action end-to-end timeout elapsed before post observation"),
  );
}
const BROWSER_STATES = new Set(["attached", "detached", "visible", "hidden", "enabled", "editable", "checked", "unchecked"]);

const BROWSER_LOAD_STATES = new Set(["domcontentloaded", "complete"]);

export function validateExpectationPrerequisites(expectation, observation, postScreenshotPolicy) {
  if (!expectation || expectation.visual_change === undefined) return;
  if (!observation.capture?.screenshot_sha256) {
    throw new BridgeError("invalid_request", "expect.visual_change requires the referenced computer snapshot to include a screenshot");
  }
  if (postScreenshotPolicy === "never") {
    throw new BridgeError("invalid_request", "expect.visual_change requires post_screenshot=auto or always");
  }
}

export function normalizeExpectation(surface, action, target, raw) {
  let value = raw === undefined || raw === null ? defaultExpectation(surface, action, target) : raw;
  if (!value) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new BridgeError("invalid_request", "expect must be an object");
  value = enforceRequiredActionExpectation(surface, action, target, value);
  const output = surface === "browser" ? normalizeBrowserExpectation(value, target) : normalizeApplicationExpectation(value, target);
  if (!Object.keys(output).length) throw new BridgeError("invalid_request", "expect must contain at least one condition");
  return output;
}

function defaultExpectation(surface, action, target) {
  if (surface === "browser" && action === "check") return { target_state: "checked" };
  if (surface === "browser" && action === "uncheck") return { target_state: "unchecked" };
  if (surface === "application" && action === "activate") return { frontmost: true };
  if (surface === "application" && (action === "focus" || action === "keystroke") && target?.kind === "ref") return { target_focused: true };
  if (surface === "application" && action === "check" && target?.kind === "ref") return { target_checked: true };
  if (surface === "application" && action === "uncheck" && target?.kind === "ref") return { target_checked: false };
  if (surface === "application" && action === "set_value" && target?.kind === "ref" && target.element?.sensitive !== true) return { target_value_matches: true };
  if (surface === "application" && action === "click") return applicationIntrinsicClickExpectation(target);
  return null;
}

function enforceRequiredActionExpectation(surface, action, target, value) {
  if (surface === "browser" && (action === "check" || action === "uncheck")) {
    const required = action === "check" ? "checked" : "unchecked";
    if (value.target_state !== undefined && (typeof value.target_state !== "string" || value.target_state !== required)) {
      throw new BridgeError("invalid_request", `browser ${action} requires expect.target_state=${required}`);
    }
    return { ...value, target_state: required };
  }
  if (surface === "application" && (action === "focus" || action === "keystroke") && target?.kind === "ref") {
    if (value.target_focused !== undefined && value.target_focused !== true) {
      throw new BridgeError("invalid_request", `application ${action} requires expect.target_focused=true`);
    }
    return { ...value, target_focused: true };
  }
  if (surface === "application" && (action === "check" || action === "uncheck") && target?.kind === "ref") {
    const required = action === "check";
    if (value.target_checked !== undefined && value.target_checked !== required) {
      throw new BridgeError("invalid_request", `application ${action} requires expect.target_checked=${required}`);
    }
    return { ...value, target_checked: required };
  }
  if (surface === "application" && value.target_value_matches !== undefined && action !== "set_value") {
    throw new BridgeError("invalid_request", "expect.target_value_matches is only valid for application set_value");
  }
  if (surface === "application" && action === "set_value" && target?.kind === "ref") {
    if (target.element?.sensitive === true) {
      if (value.target_value_matches !== undefined) {
        throw new BridgeError("invalid_request", "expect.target_value_matches is unavailable for sensitive application targets");
      }
      return value;
    }
    if (value.target_value_matches !== undefined && value.target_value_matches !== true) {
      throw new BridgeError("invalid_request", "application set_value requires expect.target_value_matches=true");
    }
    return { ...value, target_value_matches: true };
  }
  return value;
}

function normalizeBrowserExpectation(value, target) {
  assertExpectationKeys(value, new Set(["url_contains", "url_changed", "text", "load_state", "target_state", "semantic_change", "visual_change"]), "browser");
  const output = {};
  if (value.url_contains !== undefined) output.url_contains = requiredString(value.url_contains, "expect.url_contains", 32768);
  if (value.url_changed !== undefined) output.url_changed = requiredBoolean(value.url_changed, "expect.url_changed");
  if (value.semantic_change !== undefined) output.semantic_change = requiredBoolean(value.semantic_change, "expect.semantic_change");
  if (value.visual_change !== undefined) output.visual_change = requiredBoolean(value.visual_change, "expect.visual_change");
  if (value.text !== undefined) output.text = requiredString(value.text, "expect.text", 4000);
  if (value.load_state !== undefined) {
    if (typeof value.load_state !== "string" || !BROWSER_LOAD_STATES.has(value.load_state)) {
      throw new BridgeError("invalid_request", "expect.load_state must be domcontentloaded or complete");
    }
    output.load_state = value.load_state;
  }
  if (value.target_state !== undefined) {
    if (typeof value.target_state !== "string" || !BROWSER_STATES.has(value.target_state)) {
      throw new BridgeError("invalid_request", "expect.target_state is not supported");
    }
    if (!target || target.kind !== "ref") throw new BridgeError("invalid_request", "expect.target_state requires a semantic ref target");
    output.target_state = value.target_state;
  }
  return output;
}

function normalizeApplicationExpectation(value, target) {
  assertExpectationKeys(value, new Set(["frontmost", "target_exists", "target_enabled", "target_focused", "target_checked", "target_selected", "target_expanded", "target_value_matches", "semantic_change", "visual_change"]), "application");
  const output = {};
  if (value.frontmost !== undefined) output.frontmost = requiredBoolean(value.frontmost, "expect.frontmost");
  if (value.semantic_change !== undefined) output.semantic_change = requiredBoolean(value.semantic_change, "expect.semantic_change");
  if (value.visual_change !== undefined) output.visual_change = requiredBoolean(value.visual_change, "expect.visual_change");
  if (value.target_exists !== undefined) output.target_exists = requiredBoolean(value.target_exists, "expect.target_exists");
  if (value.target_enabled !== undefined) output.target_enabled = requiredBoolean(value.target_enabled, "expect.target_enabled");
  if (value.target_focused !== undefined) output.target_focused = requiredBoolean(value.target_focused, "expect.target_focused");
  if (value.target_checked !== undefined) output.target_checked = requiredBoolean(value.target_checked, "expect.target_checked");
  if (value.target_selected !== undefined) output.target_selected = requiredBoolean(value.target_selected, "expect.target_selected");
  if (value.target_expanded !== undefined) output.target_expanded = requiredBoolean(value.target_expanded, "expect.target_expanded");
  if (value.target_value_matches !== undefined) output.target_value_matches = requiredBoolean(value.target_value_matches, "expect.target_value_matches");
  if (hasApplicationTargetExpectation(output) && !applicationVerificationTarget(target)) {
    throw new BridgeError("invalid_request", "target expectations require a semantic application target");
  }
  return output;
}

function assertExpectationKeys(value, allowed, surface) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new BridgeError("invalid_request", `expect.${key} is not valid for ${surface}`);
}

function hasApplicationTargetExpectation(value) {
  return ["target_exists", "target_enabled", "target_focused", "target_checked", "target_selected", "target_expanded", "target_value_matches"]
    .some((key) => key in value);
}

export function applicationVerificationTarget(target) {
  if (target?.kind === "ref") return target;
  if (target?.kind === "point" && target.semantic_delivery) return target.semantic_delivery;
  return null;
}

function applicationElementRole(element) {
  return typeof element?.role === "string" ? element.role.trim().toLowerCase() : "";
}

function applicationIntrinsicClickExpectation(target) {
  const semantic = applicationVerificationTarget(target);
  const element = semantic?.element || null;
  const role = applicationElementRole(element);
  if (role === "axcheckbox" && typeof element?.checked === "boolean") return { target_checked: !element.checked };
  if (role === "axradiobutton" && typeof element?.checked === "boolean") return { target_checked: true };
  if (role === "axdisclosuretriangle" && typeof element?.expanded === "boolean") return { target_expanded: !element.expanded };
  return null;
}

export function validateApplicationStateActionTarget(action, element) {
  if (action !== "check" && action !== "uncheck") return;
  const role = applicationElementRole(element);
  if (action === "check" && !["axcheckbox", "axradiobutton"].includes(role)) {
    throw new BridgeError("invalid_request", "application check requires an Accessibility checkbox or radio button target");
  }
  if (action === "uncheck" && role !== "axcheckbox") {
    throw new BridgeError("invalid_request", "application uncheck requires an Accessibility checkbox target");
  }
  if (typeof element?.checked !== "boolean") {
    throw new BridgeError("conflict", "application checked state is unavailable in this snapshot; observe again before using check or uncheck", {
      details: { reason: "application_checked_state_unavailable" },
    });
  }
}

export function applicationStateActionTargetSupported(action, element) {
  if (action !== "check" && action !== "uncheck") return true;
  const role = applicationElementRole(element);
  const roleSupported = action === "check" ? ["axcheckbox", "axradiobutton"].includes(role) : role === "axcheckbox";
  return roleSupported && typeof element?.checked === "boolean";
}
const MAX_APPLICATION_OBSERVATION_ELEMENTS = 500;

export function validateApplicationInspectionEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("application observation is invalid");
  observationString(value.process_name, 1000, false, "application observation string is invalid");
  if (!Array.isArray(value.elements) || value.elements.length > MAX_APPLICATION_OBSERVATION_ELEMENTS) {
    throw new Error("application observation elements are invalid");
  }
  for (const element of value.elements) {
    if (!element || typeof element !== "object" || Array.isArray(element)) throw new Error("application observation element is invalid");
  }
  for (const field of ["frontmost", "truncated", "menus_included"]) {
    if (typeof value[field] !== "boolean") throw new Error(`application observation ${field} is invalid`);
  }
}

export function validateBrowserObservationForSnapshot(captured) {
  if (!captured || typeof captured !== "object" || Array.isArray(captured)) throw new Error("browser observation is invalid");
  if (!Number.isSafeInteger(captured.tab_id) || captured.tab_id < 1) throw new Error("browser observation tab id is invalid");
  browserString(captured.url, 32768, false, true);
  browserString(captured.title, 32768, true);
  if (captured.document_epoch !== undefined) browserString(captured.document_epoch, 9000, true, true);
  if (captured.capture !== undefined) {
    if (!captured.capture || typeof captured.capture !== "object" || Array.isArray(captured.capture)) throw new Error("browser observation capture is invalid");
    if (captured.capture.semantic_epoch !== undefined) browserString(captured.capture.semantic_epoch, 9000, true, true);
    if (captured.capture.cdp_epoch !== undefined) browserString(captured.capture.cdp_epoch, 9000, true, true);
  }
  if (captured.semantic === undefined) return;
  if (!captured.semantic || typeof captured.semantic !== "object" || Array.isArray(captured.semantic)) {
    throw new Error("browser observation semantic payload is invalid");
  }
  if (captured.semantic.tab_id !== undefined
      && (!Number.isSafeInteger(captured.semantic.tab_id) || captured.semantic.tab_id < 1)) {
    throw new Error("browser observation tab id is invalid");
  }
  if (captured.semantic.url !== undefined) browserString(captured.semantic.url, 32768, false, true);
  if (captured.semantic.title !== undefined) browserString(captured.semantic.title, 32768, true);
  if (typeof captured.semantic.frames_truncated !== "boolean") throw new Error("browser observation truncation evidence is invalid");
  if (captured.semantic.frames === undefined) return;
  if (!Array.isArray(captured.semantic.frames)) throw new Error("browser observation semantic frames are invalid");
  for (const frame of captured.semantic.frames) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || !Number.isSafeInteger(frame.frame_id) || frame.frame_id < 0) {
      throw new Error("browser observation frame authority is invalid");
    }
    if (typeof frame.truncated !== "boolean") throw new Error("browser observation truncation evidence is invalid");
    if (frame.document === undefined) continue;
    if (!frame.document || typeof frame.document !== "object" || Array.isArray(frame.document)) {
      throw new Error("browser observation frame authority is invalid");
    }
    if (frame.document.epoch !== undefined) browserString(frame.document.epoch, 9000, true, true);
    if (frame.document.url !== undefined) browserString(frame.document.url, 32768, false, true);
  }
}

export function browserObservationArgs(args) {
  return {
    tab_id: optionalPositiveInt(args.tab_id, "tab_id"),
    max_elements: clampInt(args.max_elements, 300, 1, 1000),
    max_ax_nodes: clampInt(args.max_ax_nodes, 600, 1, 2000),
    max_frames: clampInt(args.max_frames, 32, 1, 64),
    ax_depth: clampInt(args.ax_depth, 12, 1, 16),
    include_values: optionalBoolean(args.include_values, "include_values", false),
    all_frames: optionalBoolean(args.all_frames, "all_frames", true),
    include_screenshot: optionalBoolean(args.include_screenshot, "include_screenshot", true),
    screenshot_format: computerScreenshotFormat(args.screenshot_format),
    screenshot_quality: clampInt(args.screenshot_quality, 90, 1, 100),
    timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
    focus_query: args.focus_query === undefined ? undefined : requiredStringAllowEmpty(args.focus_query, "focus_query", 1000),
  };
}

function browserString(value, maxLength, allowEmpty, authority = false) {
  return observationString(value, maxLength, allowEmpty, `browser observation${authority ? " authority" : ""} string is invalid`);
}

function observationString(value, maxLength, allowEmpty, message) {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > maxLength || value.includes("\0")) {
    throw new Error(message);
  }
  return value;
}

// Sampling scores, query choices and ref-cache counters describe capture, not page effects.
const DOCUMENT_SEMANTIC_FIELDS = ["epoch", "url", "title", "language", "ready_state", "forms", "open_shadow_roots"];

const CONTROL_SEMANTIC_FIELDS = [
  "ref", "tag", "type", "role", "name", "text", "id", "field_name", "label", "placeholder", "href",
  "sensitive", "in_shadow_dom", "visible", "enabled", "editable", "checked", "selected", "focused", "bounding_box",
];

const ACCESSIBILITY_SEMANTIC_FIELDS = [
  "ax_id", "parent_ax_id", "frame_id", "role", "name", "description", "disabled", "focused", "focusable", "editable",
  "checked", "selected", "expanded", "required", "sensitive", "clickable", "bounding_box", "paint_order",
];

export function browserSemanticContent(observation, includeAccessibility) {
  return {
    target: observation.target,
    frames: (observation.semantic?.frames || []).map((frame) => ({
      frame_id: frame.frame_id,
      document: semanticFields(frame.document, DOCUMENT_SEMANTIC_FIELDS),
      elements: (frame.elements || []).map((element) => semanticFields(element, CONTROL_SEMANTIC_FIELDS))
        .sort((left, right) => String(left.ref).localeCompare(String(right.ref))),
    })).sort((left, right) => left.frame_id - right.frame_id),
    nodes: includeAccessibility ? (observation.semantic.accessibility.nodes || [])
      .map((node) => semanticFields(node, ACCESSIBILITY_SEMANTIC_FIELDS))
      .sort((left, right) => `${left.frame_id}|${left.ax_id}`.localeCompare(`${right.frame_id}|${right.ax_id}`)) : [],
  };
}

export function comparableSemanticCoverage(before, after, beforePrivateState, afterPrivateState) {
  if (before.surface === "browser") {
    return [before, after].every((observation) => observation.semantic?.frames_truncated === false
      && Array.isArray(observation.semantic.frames)
      && observation.semantic.frames.every((frame) => frame.truncated === false && frame.document?.scan_truncated !== true))
      && [before, after].every((observation) => !observation.semantic?.accessibility
        || observation.semantic.accessibility.available === false || observation.semantic.accessibility.truncated !== true);
  }
  return before.semantic?.truncated === false && after.semantic?.truncated === false
    && before.capture?.window_coherent === after.capture?.window_coherent
    && before.semantic.menus_included === after.semantic.menus_included
    && beforePrivateState?.application_inspection?.max_depth === afterPrivateState?.application_inspection?.max_depth;
}

function semanticFields(value, fields) {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(value || {}, field)).map((field) => [field, value[field]]));
}
export function buildRetryGuidance({
  dispatchStatus,
  effectStatus,
  expectationRequested,
  postObservation,
  continuation,
}) {
  const postSnapshotId = postObservation?.snapshot_id || null;
  const mappedPostTargetRef = continuation?.surface === "application"
    && continuation?.target_identity_continues === true
    && typeof continuation?.mapped_post_target_ref === "string"
    && continuation.mapped_post_target_ref
    ? continuation.mapped_post_target_ref
    : "";
  const base = {
    same_action_retry_allowed: false,
    post_snapshot_id: postSnapshotId,
    ...(mappedPostTargetRef ? {
      mapped_post_target_ref: mappedPostTargetRef,
      mapped_ref_for_replanning_only: true,
    } : {}),
  };

  if (effectStatus === "confirmed") {
    return {
      ...base,
      disposition: "do_not_retry",
      reason: "effect_confirmed",
      next_step: nextObservationStep(postObservation, continuation),
      message: "The requested effect was confirmed. Do not replay the same action.",
    };
  }

  if (dispatchStatus === "completed" && expectationRequested !== true) {
    return {
      ...base,
      disposition: "do_not_retry",
      reason: "dispatch_completed_without_effect_contract",
      next_step: nextObservationStep(postObservation, continuation),
      message: "Dispatch completed without an explicit effect contract. Do not replay the same action automatically; continue from observed state.",
    };
  }

  if (!postObservation) {
    return {
      ...base,
      disposition: "reobserve_before_retry",
      reason: dispatchStatus === "unknown" ? "dispatch_unknown_and_post_state_unavailable" : "post_state_unavailable",
      next_step: "computer_observe",
      message: "Post-state is unavailable. Re-observe before deciding whether any retry is appropriate.",
    };
  }

  if (continuation?.reobserve_recommended === true) {
    return {
      ...base,
      disposition: "reobserve_before_retry",
      reason: continuation.reason || "post_state_requires_fresh_observation",
      next_step: "computer_observe",
      message: "The post-state cannot be safely continued from the previous ref namespace. Re-observe before deciding whether any retry is appropriate.",
    };
  }

  return {
    ...base,
    disposition: "use_post_snapshot",
    reason: dispatchStatus === "unknown"
      ? "dispatch_unknown_inspect_post_state_before_any_retry"
      : effectStatus === "not_observed"
        ? "requested_effect_not_observed_use_post_state_to_replan"
        : "effect_unconfirmed_use_post_state_before_any_retry",
    next_step: "continue_from_post_snapshot",
    message: dispatchStatus === "unknown"
      ? "Dispatch outcome is ambiguous. Inspect and continue from the post snapshot; do not replay the same action automatically."
      : "The requested effect was not confirmed. Use the post snapshot to replan before considering any retry.",
  };
}

function nextObservationStep(postObservation, continuation) {
  if (!postObservation || continuation?.reobserve_recommended === true) return "computer_observe";
  return "continue_from_post_snapshot";
}
