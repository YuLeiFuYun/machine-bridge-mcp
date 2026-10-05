import {
  clampInt, computerScreenshotFormat, optionalBoolean, optionalPositiveInt, requiredStringAllowEmpty,
} from "./computer-use-arguments.mjs";

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
