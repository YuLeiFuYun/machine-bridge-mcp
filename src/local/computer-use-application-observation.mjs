import { BridgeError } from "./errors.mjs";

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
  if (!left || !right) return false;
  return ["x", "y", "width", "height"].every((key) => (
    typeof left[key] === "number" && Number.isFinite(left[key])
    && typeof right[key] === "number" && Number.isFinite(right[key])
    && Math.abs(left[key] - right[key]) <= 1
  ));
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
