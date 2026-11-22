import { BridgeError, errorCode } from "../core/errors.mjs";
import { clampInt } from "./computer-use-contracts.mjs";

const INTERACTIVE_ROLES = new Set([
  "axbutton", "axcheckbox", "axcombobox", "axlink", "axmenuitem", "axpopupbutton", "axradiobutton",
  "axsearchfield", "axslider", "axtextfield", "axtextarea", "axincrementor", "axdisclosuretriangle",
]);

const POINT_CLICK_EQUIVALENT_ROLES = new Set([
  "axbutton", "axcheckbox", "axlink", "axmenuitem", "axpopupbutton", "axradiobutton", "axdisclosuretriangle",
]);

export function prepareApplicationObservationElements(rawElements, { maxElements, focusQuery = "", windowBounds = null, sourceTruncated = false, requireWindowOwnership = false } = {}) {
  const source = Array.isArray(rawElements) ? rawElements : [];
  const limit = boundedLimit(maxElements, source.length || 1);
  const query = (normalizeText(focusQuery) || "").slice(0, 1000);
  const bounds = normalizeBox(windowBounds);
  const occurrences = new Map();
  const candidates = source.map((rawElement, sourceIndex) => {
    const element = plainRecord(rawElement) ? rawElement : {};
    const selector = tryApplicationIdentitySelector(element);
    const selectorKey = selector ? JSON.stringify(selector) : "";
    const occurrence = selectorKey ? occurrences.get(selectorKey) || 0 : null;
    if (selectorKey) occurrences.set(selectorKey, occurrence + 1);
    const screenBox = normalizeBox(element?.screen_box);
    const ownerWindowBox = normalizeBox(element?.window_screen_box);
    const ownerMatchesWindow = bounds
      ? ownerWindowBox ? sameBox(ownerWindowBox, bounds) : !requireWindowOwnership
      : false;
    const localBox = ownerMatchesWindow ? windowLocalBox(screenBox, bounds) : null;
    const visible = bounds && screenBox ? localBox !== null : null;
    const queryScore = applicationQueryScore(element, query);
    return {
      element,
      sourceIndex,
      selector,
      occurrence,
      screenBox,
      ownerWindowBox,
      localBox,
      visible,
      queryScore,
      score: applicationSalience(element, { queryScore, visible, localBox }),
    };
  });
  candidates.sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex);
  const selected = candidates.slice(0, limit);
  const queryMatches = query ? candidates.filter((candidate) => candidate.queryScore > 0) : [];
  const bindings = new Map();
  const elements = selected.map((candidate, index) => {
    const ref = `a${index}`;
    if (candidate.selector && Number.isInteger(candidate.occurrence)) {
      bindings.set(ref, {
        selector: candidate.selector,
        occurrence: candidate.occurrence,
        source_index: candidate.sourceIndex,
        screen_box: candidate.screenBox,
        owner_window_bounds: candidate.ownerWindowBox,
      });
    }
    const { screen_box: _screenBox, window_screen_box: _windowScreenBox, index: _sourceIndex, ...publicElement } = candidate.element || {};
    return {
      ...publicElement,
      ref,
      index,
      visible: candidate.visible,
      bounding_box: candidate.localBox,
      salience_score: candidate.score,
    };
  });
  return {
    elements,
    bindings,
    truncated: source.length > selected.length,
    selection: {
      strategy: "application_salience",
      focus_query: query,
      scanned_elements: source.length,
      returned_elements: elements.length,
      max_elements: limit,
      geometry_source: bounds ? "window_local_accessibility" : "unavailable",
      window_ownership_required: requireWindowOwnership === true,
      window_size: bounds ? { width: bounds.width, height: bounds.height } : null,
      query_matched: query ? queryMatches.length > 0 : null,
      query_match_count: query ? queryMatches.length : null,
      query_search_exhaustive: query ? sourceTruncated !== true : null,
      top_query_score: query && queryMatches.length ? Math.max(...queryMatches.map((candidate) => candidate.queryScore)) : null,
    },
  };
}

export function applicationMatchesSelector(element, selector) {
  if (!plainRecord(element) || !plainRecord(selector)) return false;
  return Object.entries(selector).every(([key, value]) => {
    const expected = normalizeText(value);
    const actual = normalizeText(element[key]);
    return expected !== null && actual !== null && actual === expected;
  });
}

export function applicationElementSupportsPointClick(element) {
  const role = normalizeText(element?.role);
  return element?.enabled === true && role !== null && POINT_CLICK_EQUIVALENT_ROLES.has(role);
}

export function applicationIdentitySelector(element) {
  if (element?.identifier !== undefined && element.identifier !== null && element.identifier !== "") {
    return compactSelector({ identifier: element.identifier });
  }
  return compactSelector({
    role: element?.role,
    subrole: element?.subrole,
    name: element?.name,
    title: element?.title,
    description: element?.description,
  });
}

function tryApplicationIdentitySelector(element) {
  try { return applicationIdentitySelector(element); }
  catch (error) {
    if (error instanceof BridgeError && error.details?.reason === "unaddressable_accessibility_element") return null;
    throw error;
  }
}

function compactSelector(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === undefined || item === null || item === "") continue;
    if (typeof item !== "string" || item.includes("\0") || item.length > 1000) {
      throw unaddressableApplicationElement();
    }
    out[key] = item;
  }
  if (!Object.keys(out).length) {
    throw unaddressableApplicationElement();
  }
  return out;
}

function unaddressableApplicationElement() {
  return new BridgeError("conflict", "application element has no stable accessibility identity", {
    details: { reason: "unaddressable_accessibility_element" },
  });
}

function applicationSalience(element, { queryScore, visible, localBox }) {
  const role = normalizeText(element?.role) || "";
  let score = queryScore;
  if (element?.focused === true) score += 420;
  if (element?.enabled === true) score += 35;
  if (INTERACTIVE_ROLES.has(role)) score += 110;
  if (visible === true) score += 120;
  if (localBox) {
    const area = Math.max(0, localBox.width) * Math.max(0, localBox.height);
    if (area > 0) score += Math.min(40, Math.log2(area + 1) * 3);
  }
  return Math.round(score * 100) / 100;
}

function applicationQueryScore(element, query) {
  if (!query) return 0;
  const role = normalizeText(element?.role) || "";
  const name = normalizeText(element?.name) || "";
  const title = normalizeText(element?.title) || "";
  const description = normalizeText(element?.description) || "";
  const identifier = normalizeText(element?.identifier) || "";
  const haystack = [role, name, title, description, identifier].filter(Boolean).join(" ");
  let score = 0;
  if ([name, title, description, identifier].includes(query)) score += 1200;
  if (haystack.includes(query)) score += 700;
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (token.length >= 2 && haystack.includes(token)) score += 90;
  }
  return score;
}

function windowLocalBox(screenBox, windowBounds) {
  const box = normalizeBox(screenBox);
  if (!box || !windowBounds || box.width <= 0 || box.height <= 0) return null;
  const left = Math.max(box.x, windowBounds.x);
  const top = Math.max(box.y, windowBounds.y);
  const right = Math.min(box.x + box.width, windowBounds.x + windowBounds.width);
  const bottom = Math.min(box.y + box.height, windowBounds.y + windowBounds.height);
  if (!(right > left && bottom > top)) return null;
  return {
    x: round2(left - windowBounds.x),
    y: round2(top - windowBounds.y),
    width: round2(right - left),
    height: round2(bottom - top),
  };
}

function sameBox(left, right) {
  return ["x", "y", "width", "height"].every((key) => Math.abs(left[key] - right[key]) <= 1);
}

function normalizeBox(value) {
  if (!plainRecord(value)) return null;
  const box = {};
  for (const key of ["x", "y", "width", "height"]) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) return null;
    box[key] = number;
  }
  return box.width > 0 && box.height > 0 ? box : null;
}

function normalizeText(value) {
  if (typeof value !== "string" || value.includes("\0") || value.length > 4000) return null;
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function boundedLimit(value, fallback) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  return Number.isSafeInteger(fallback) && fallback > 0 ? fallback : 1;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function plainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export const BROWSER_DOCUMENT_BOUND_TARGETLESS_ACTIONS = new Set(["reload", "back", "forward"]);

const MAX_APPLICATION_SCREENSHOT_BYTES = 32 * 1024 * 1024;

export function staleSnapshot(detail) {
  return new BridgeError("conflict", `computer snapshot is stale: ${detail}; observe again before acting`, {
    details: { reason: "stale_snapshot" },
  });
}

export function applicationPointTarget(observation, privateState, action, value) {
  if (!["click", "double_click", "drag", "scroll"].includes(action)) throw new BridgeError("invalid_request", `visual point target is not valid for application ${action}`);
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
  const binding = privateState?.application_window_binding || null;
  if (observation.capture?.screenshot !== true || observation.capture?.screenshot_source !== "macos_window" || !binding) {
    throw new BridgeError("conflict", "application visual point action requires the exact macOS window screenshot from this snapshot", {
      details: { reason: "application_visual_snapshot_not_actionable" },
    });
  }
  const candidates = applicationPointCandidates(observation, binding, x, y);
  const semanticDelivery = action === "click" && observation.capabilities?.snapshot_bound_semantic_points === true
    ? applicationSemanticPointDelivery(observation, privateState, candidates)
    : null;
  if (!semanticDelivery && observation.capabilities?.snapshot_bound_visual_points !== true) {
    throw new BridgeError("conflict", "application point did not resolve uniquely to an actionable Accessibility element and no snapshot-bound pixel backend is available", {
      details: { reason: "application_visual_snapshot_not_actionable" },
    });
  }
  return {
    kind: "point",
    normalized_x: x,
    normalized_y: y,
    window_binding: binding,
    semantic_delivery: semanticDelivery,
    semantic_point_candidates: candidates,
  };
}

function applicationSemanticPointDelivery(observation, privateState, candidates) {
  const bindings = privateState?.application_ref_bindings;
  if (!bindings?.get) return null;
  const matches = [];
  for (const candidate of candidates) {
    const ref = typeof candidate?.ref === "string" ? candidate.ref : "";
    const element = (observation.semantic?.elements || []).find((item) => item?.ref === ref) || null;
    const binding = ref ? bindings.get(ref) || null : null;
    if (!element || !binding || !applicationElementSupportsPointClick(element)) continue;
    matches.push({
      ref,
      element,
      selector: binding.selector,
      occurrence: binding.occurrence,
      inspection: privateState?.application_inspection || null,
      owner_window_bounds: binding.owner_window_bounds || null,
      screen_box: binding.screen_box || null,
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

function applicationPointCandidates(observation, binding, normalizedX, normalizedY) {
  const windowBounds = normalizedWindowBounds(binding?.bounds);
  if (!windowBounds) return [];
  const x = normalizedX * windowBounds.width;
  const y = normalizedY * windowBounds.height;
  const candidates = [];
  for (const element of observation.semantic?.elements || []) {
    const box = normalizedWindowBounds(element?.bounding_box);
    if (!box || x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height) continue;
    candidates.push({
      ref: typeof element.ref === "string" ? element.ref : "",
      role: typeof element.role === "string" ? element.role : "",
      name: typeof element.name === "string" ? element.name.slice(0, 500)
        : typeof element.title === "string" ? element.title.slice(0, 500)
          : typeof element.description === "string" ? element.description.slice(0, 500) : "",
      sensitive: element.sensitive === true,
      bounding_box: box,
      area: box.width * box.height,
    });
  }
  candidates.sort((left, right) => left.area - right.area || left.ref.localeCompare(right.ref));
  return candidates.slice(0, 4).map(({ area: _area, ...candidate }) => candidate);
}

export function currentApplicationSemanticPointCandidates(elements, target) {
  const windowBounds = normalizedWindowBounds(target?.window_binding?.bounds);
  const normalizedX = target?.normalized_x;
  const normalizedY = target?.normalized_y;
  if (!windowBounds || typeof normalizedX !== "number" || !Number.isFinite(normalizedX)
      || typeof normalizedY !== "number" || !Number.isFinite(normalizedY)) return [];
  const screenX = windowBounds.x + normalizedX * windowBounds.width;
  const screenY = windowBounds.y + normalizedY * windowBounds.height;
  const candidates = [];
  for (const element of elements || []) {
    if (!applicationElementSupportsPointClick(element)) continue;
    const ownerBounds = normalizedWindowBounds(element?.window_screen_box);
    if (!ownerBounds || !sameApplicationBounds(ownerBounds, windowBounds)) continue;
    const box = normalizedWindowBounds(element?.screen_box);
    if (!box || screenX < box.x || screenY < box.y || screenX > box.x + box.width || screenY > box.y + box.height) continue;
    candidates.push(element);
  }
  return candidates;
}

export function applicationScreenshotBytes(value) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_APPLICATION_SCREENSHOT_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 8 || bytes.length > MAX_APPLICATION_SCREENSHOT_BYTES || bytes.toString("base64") !== value) return null;
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a ? bytes : null;
}

export function applicationWindowBinding(captured, screenshotSha256) {
  const screenshot = captured?.screenshot;
  const windowId = captured?.window?.id;
  const bounds = normalizedWindowBounds(captured?.window?.bounds || screenshot?.bounds);
  const digest = typeof screenshotSha256 === "string" ? screenshotSha256.toLowerCase() : "";
  if (screenshot?.source !== "macos_window" || screenshot?.mime_type !== "image/png" || typeof screenshot?.data !== "string"
      || !Number.isSafeInteger(windowId) || windowId < 1 || !bounds || !/^[a-f0-9]{64}$/.test(digest)) return null;
  return { window_id: windowId, bounds, screenshot_sha256: digest };
}

export function sameApplicationWindowBinding(expected, current) {
  if (!expected || !current || expected.window_id !== current.window_id || expected.screenshot_sha256 !== current.screenshot_sha256) return false;
  return sameApplicationBounds(normalizedWindowBounds(expected.bounds), normalizedWindowBounds(current.bounds));
}

export function sameApplicationWindowIdentity(expected, current) {
  const windowId = current?.window?.id ?? current?.id;
  const bounds = normalizedWindowBounds(current?.window?.bounds ?? current?.bounds);
  if (!expected || !Number.isSafeInteger(windowId) || windowId !== expected.window_id || !bounds) return false;
  return sameApplicationBounds(normalizedWindowBounds(expected.bounds), bounds);
}

export function applicationCaptureCoherence({ screenshotRequested, hasImage, windowCoherent }) {
  if (!screenshotRequested) return "single_accessibility_inspection";
  if (!hasImage) return "accessibility_only_after_screenshot_failure";
  if (windowCoherent === true) return "window_screenshot_then_accessibility_window_stable";
  if (windowCoherent === false) return "window_changed_during_capture";
  return "window_screenshot_then_accessibility_unverified";
}

export function applicationTargetInspection(target) {
  const inspection = target?.semantic_delivery?.inspection || target?.inspection || null;
  return {
    max_depth: clampInt(inspection?.max_depth, 6, 1, 12),
    include_menus: inspection?.include_menus === true,
  };
}

function applicationTargetGeometry(target) {
  const source = target?.semantic_delivery || target || {};
  return {
    owner_window_bounds: normalizedWindowBounds(source.owner_window_bounds),
    screen_box: normalizedWindowBounds(source.screen_box),
  };
}

export function applicationTargetHasGeometry(target) {
  const geometry = applicationTargetGeometry(target);
  return Boolean(geometry.owner_window_bounds || geometry.screen_box);
}

export function applicationTargetGeometryMatches(element, target) {
  const expected = applicationTargetGeometry(target);
  if (expected.owner_window_bounds && !sameApplicationBounds(expected.owner_window_bounds, normalizedWindowBounds(element?.window_screen_box))) return false;
  if (expected.screen_box && !sameApplicationBounds(expected.screen_box, normalizedWindowBounds(element?.screen_box))) return false;
  return true;
}

export function applyApplicationTargetGeometry(call, target) {
  const geometry = applicationTargetGeometry(target);
  if (geometry.owner_window_bounds) call.expected_window_bounds = geometry.owner_window_bounds;
  if (geometry.screen_box) call.expected_element_bounds = geometry.screen_box;
  return call;
}

function sameApplicationBounds(left, right) {
  if (!left || !right) return false;
  return ["x", "y", "width", "height"].every((key) => {
    const a = left[key];
    const b = right[key];
    return typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b) && Math.abs(a - b) <= 1;
  });
}

export function normalizedWindowBounds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bounds = {};
  for (const key of ["x", "y", "width", "height"]) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) return null;
    bounds[key] = number;
  }
  return bounds.width > 0 && bounds.height > 0 ? bounds : null;
}

export function normalizedPointCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new BridgeError("invalid_request", `${label} must be from 0 (inclusive) to 1 (exclusive)`);
  }
  return value;
}

export function validPointScreenshotQuality(value) {
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 90;
}

export function positiveNativeViewport(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof value.width === "number" && Number.isFinite(value.width) && value.width > 0
    && typeof value.height === "number" && Number.isFinite(value.height) && value.height > 0
    && typeof value.scale === "number" && Number.isFinite(value.scale) && value.scale > 0);
}

export function sameVisualViewport(expected, current) {
  if (!positiveNativeViewport(expected) || !positiveNativeViewport(current)) return false;
  for (const key of ["width", "height", "scale"]) {
    if (Math.abs(expected[key] - current[key]) > 0.5) return false;
  }
  const offsetLeft = current.offset_left === undefined || current.offset_left === null ? 0 : current.offset_left;
  const offsetTop = current.offset_top === undefined || current.offset_top === null ? 0 : current.offset_top;
  if (typeof offsetLeft !== "number" || !Number.isFinite(offsetLeft) || typeof offsetTop !== "number" || !Number.isFinite(offsetTop)) return false;
  return Math.abs(current.scale - 1) <= 0.001 && Math.abs(offsetLeft) <= 0.5 && Math.abs(offsetTop) <= 0.5;
}

export function sanitizeApplicationPointCandidate(value) {
  return {
    ref: typeof value?.ref === "string" ? value.ref : "",
    role: typeof value?.role === "string" ? value.role : "",
    name: typeof value?.name === "string" ? value.name.slice(0, 500) : "",
    sensitive: value?.sensitive === true,
    bounding_box: normalizedWindowBounds(value?.bounding_box),
  };
}

export function sanitizeVisualHit(value) {
  return {
    ref: typeof value.ref === "string" ? value.ref : "",
    tag: typeof value.tag === "string" ? value.tag : "",
    role: typeof value.role === "string" ? value.role : "",
    name: typeof value.name === "string" ? value.name : "",
    sensitive: value.sensitive === true,
    bounding_box: normalizedWindowBounds(value.bounding_box),
  };
}

export function applicationPostFocusQuery(target) {
  if (!target) return undefined;
  const element = target.kind === "ref" ? target.element || {} : target.semantic_delivery?.element || {};
  const value = element.name || element.title || element.description || element.identifier || element.role || "";
  return String(value).trim().slice(0, 1000) || undefined;
}

export function browserSnapshotIdentityMatches(expected, element) {
  if (!expected || !element) return false;
  return Object.entries(expected).every(([field, value]) => {
    if (!Object.hasOwn(element, field)) return false;
    const actual = element[field];
    return typeof value === "boolean" ? typeof actual === "boolean" && actual === value
      : typeof actual === "string" && actual === value;
  });
}

export function applicationScreenshotError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("screen recording") || message.includes("permission") || message.includes("not authorized")) {
    return "application window screenshot unavailable; Screen Recording permission may be required";
  }
  if (message.includes("no capturable on-screen window")) return "application has no capturable on-screen window";
  return "application window screenshot unavailable";
}

export function applicationWindowRevalidationError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("accessibility") || message.includes("permission") || message.includes("not authorized")) {
    return "application window identity could not be revalidated; Accessibility permission may be required";
  }
  if (message.includes("no capturable on-screen window")) return "application window identity changed or became unavailable during capture";
  return "application window identity could not be revalidated during capture";
}

export function browserObservationSemanticEpoch(observation) {
  const value = observation?.capture?.semantic_epoch;
  return typeof value === "string" && value && value.length <= 9000 && !value.includes("\0") ? value : "";
}

export function privateBrowserHistoryEntryKey(value) {
  return typeof value === "string" && value && value.length <= 512 && !value.includes("\0") ? value : "";
}

export function enforceBrowserHistoryDocumentPreflight(action, semanticEpoch, expectedHistoryEntryKey, currentDocument, documentStateError) {
  if (!BROWSER_DOCUMENT_BOUND_TARGETLESS_ACTIONS.has(action)) return;
  if (!semanticEpoch || !currentDocument?.document_epoch) {
    throw new BridgeError("unavailable", "cannot validate the browser document before this snapshot-bound history action; observe again", {
      details: { reason: "browser_document_preflight_unavailable", ...(documentStateError ? { error_class: errorCode(documentStateError) } : {}) },
    });
  }
  if (!expectedHistoryEntryKey) {
    throw new BridgeError("unavailable", "cannot bind this snapshot to a browser history entry; observe again", {
      details: { reason: "browser_history_preflight_unavailable" },
    });
  }
  const currentHistoryEntryKey = privateBrowserHistoryEntryKey(currentDocument?._machine_history_entry_key);
  if (!currentHistoryEntryKey) {
    throw new BridgeError("unavailable", "cannot validate the browser history entry before this snapshot-bound history action; observe again", {
      details: { reason: "browser_history_preflight_unavailable" },
    });
  }
  if (currentHistoryEntryKey !== expectedHistoryEntryKey) throw staleSnapshot("browser history entry changed after the snapshot");
}

export function defaultSleep(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, Math.max(0, Number(milliseconds) || 0)); });
}
