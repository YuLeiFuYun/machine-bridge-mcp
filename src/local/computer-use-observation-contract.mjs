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
  browserAuthorityString(captured.url, 32768, false);
  browserString(captured.title, 32768, true);
  if (captured.document_epoch !== undefined) browserAuthorityString(captured.document_epoch, 9000, true);
  if (captured.capture !== undefined) {
    if (!captured.capture || typeof captured.capture !== "object" || Array.isArray(captured.capture)) throw new Error("browser observation capture is invalid");
    if (captured.capture.semantic_epoch !== undefined) browserAuthorityString(captured.capture.semantic_epoch, 9000, true);
    if (captured.capture.cdp_epoch !== undefined) browserAuthorityString(captured.capture.cdp_epoch, 9000, true);
  }
  if (captured.semantic === undefined) return;
  if (!captured.semantic || typeof captured.semantic !== "object" || Array.isArray(captured.semantic)) {
    throw new Error("browser observation semantic payload is invalid");
  }
  if (captured.semantic.tab_id !== undefined
      && (!Number.isSafeInteger(captured.semantic.tab_id) || captured.semantic.tab_id < 1)) {
    throw new Error("browser observation tab id is invalid");
  }
  if (captured.semantic.url !== undefined) browserAuthorityString(captured.semantic.url, 32768, false);
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
    if (frame.document.epoch !== undefined) browserAuthorityString(frame.document.epoch, 9000, true);
    if (frame.document.url !== undefined) browserAuthorityString(frame.document.url, 32768, false);
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

function browserAuthorityString(value, maxLength, allowEmpty) {
  return observationString(value, maxLength, allowEmpty, "browser observation authority string is invalid");
}

function browserString(value, maxLength, allowEmpty) {
  return observationString(value, maxLength, allowEmpty, "browser observation string is invalid");
}

function observationString(value, maxLength, allowEmpty, message) {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > maxLength || value.includes("\0")) {
    throw new Error(message);
  }
  return value;
}
