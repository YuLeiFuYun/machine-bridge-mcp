import { BridgeError } from "./errors.mjs";
import { requiredBoolean, requiredString } from "./computer-use-arguments.mjs";

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
