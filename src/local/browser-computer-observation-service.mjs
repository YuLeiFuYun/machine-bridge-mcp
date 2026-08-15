import { createHash } from "node:crypto";
import { clampInt, normalizeBrowserSnapshotIdentity, normalizeImageFormat, optionalBoolean, optionalInteger, optionalString } from "./browser-command.mjs";

const MAX_BROWSER_SCREENSHOT_BYTES = 32 * 1024 * 1024;

export function normalizeBackendNodeActionMetadata(args = {}) {
  const action = args.action;
  if (typeof action !== "string" || !["click", "double_click", "hover", "drag", "scroll", "press", "type_text", "fill", "check", "uncheck", "submit"].includes(action)) {
    throw new Error("snapshot backend action must be click, double_click, hover, drag, scroll, press, type_text, fill, check, uncheck, or submit");
  }
  const backendNodeId = requiredPositiveInteger(args.backend_node_id, "backend_node_id");
  const destinationBackendNodeId = action === "drag"
    ? requiredPositiveInteger(args.destination_backend_node_id, "destination_backend_node_id")
    : null;
  const scrollDeltas = action === "scroll" ? normalizeScrollDeltas(args) : null;
  const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
  const payload = {
    tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
    action,
    backendNodeId,
    extensionFrameId: optionalAuthorityInteger(args.extension_frame_id, "extension_frame_id"),
    expectedDocumentEpoch: optionalEpoch(args.document_epoch),
    expectedFrameDocumentEpoch: optionalEpoch(args.frame_document_epoch),
    expectedFrameUrl: optionalFrameUrl(args.frame_url),
    extensionRef: optionalString(args.extension_ref, "extension_ref", 100),
    expectedIdentity: normalizeBrowserSnapshotIdentity(args.expected_ref_identity),
    ...(action === "drag" ? {
      destinationBackendNodeId,
      destinationExtensionFrameId: optionalAuthorityInteger(args.destination_extension_frame_id, "destination_extension_frame_id"),
      destinationExpectedFrameDocumentEpoch: optionalEpoch(args.destination_frame_document_epoch),
      destinationExpectedFrameUrl: optionalFrameUrl(args.destination_frame_url),
      destinationExtensionRef: optionalString(args.destination_extension_ref, "destination_extension_ref", 100),
      destinationExpectedIdentity: normalizeBrowserSnapshotIdentity(args.destination_expected_ref_identity),
    } : {}),
    ...(scrollDeltas || {}),
    value: args.value === undefined ? undefined : requiredText(args.value, "value", 131072),
    key: args.key === undefined ? undefined : requiredText(args.key, "key", 100),
  };
  return { payload, timeoutSeconds };
}

export class BrowserComputerObservationService {
  constructor({ authorizeTool, request, bridgeStatus, inspectPage, screenshot }) {
    this.authorizeTool = authorizeTool;
    this.request = request;
    this.bridgeStatus = bridgeStatus;
    this.inspectPage = inspectPage;
    this.screenshot = screenshot;
  }

  async documentState(args = {}, context = {}) {
    this.authorizeTool("computer_act");
    return this.request("document_state", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
    }, clampInt(args.timeout_seconds, 5, 1, 30), context);
  }

  preflightBackendNodeAction(args = {}) {
    this.authorizeTool("computer_act");
    return normalizeBackendNodeActionMetadata(args);
  }

  async backendNodeAction(args = {}, context = {}) {
    this.authorizeTool("computer_act");
    const prepared = normalizeBackendNodeActionMetadata(args);
    return this.request("backend_node_action", prepared.payload, prepared.timeoutSeconds, context);
  }

  async pointAction(args = {}, context = {}) {
    this.authorizeTool("computer_act");
    const action = args.action;
    if (typeof action !== "string" || !["click", "double_click", "hover", "drag", "scroll"].includes(action)) throw new Error("visual point action must be click, double_click, hover, drag, or scroll");
    const scrollDeltas = action === "scroll" ? normalizeScrollDeltas(args) : null;
    return this.request("point_action", {
      tabId: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      action,
      normalizedX: normalizedCoordinate(args.normalized_x, "normalized_x"),
      normalizedY: normalizedCoordinate(args.normalized_y, "normalized_y"),
      ...(action === "drag" ? {
        destinationNormalizedX: normalizedCoordinate(args.destination_normalized_x, "destination_normalized_x"),
        destinationNormalizedY: normalizedCoordinate(args.destination_normalized_y, "destination_normalized_y"),
      } : {}),
      ...(scrollDeltas || {}),
      expectedDocumentEpoch: optionalEpoch(args.document_epoch),
      expectedViewport: normalizeExpectedViewport(args.viewport),
      expectedScreenshotSha256: optionalSha256(args.screenshot_sha256),
      screenshotFormat: normalizeImageFormat(args.screenshot_format, "screenshot_format"),
      screenshotQuality: clampInt(args.screenshot_quality, 90, 1, 100),
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
  }

  async observe(args = {}, context = {}) {
    this.authorizeTool("computer_observe");
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    const normalized = {
      tab_id: optionalInteger(args.tab_id, "tab_id", 1, Number.MAX_SAFE_INTEGER),
      all_frames: optionalBoolean(args.all_frames, "all_frames", true),
      max_elements: clampInt(args.max_elements, 300, 1, 1000),
      max_ax_nodes: clampInt(args.max_ax_nodes, 600, 1, 2000),
      max_frames: clampInt(args.max_frames, 32, 1, 64),
      ax_depth: clampInt(args.ax_depth, 12, 1, 16),
      include_values: optionalBoolean(args.include_values, "include_values", false),
      include_screenshot: optionalBoolean(args.include_screenshot, "include_screenshot", true),
      screenshot_format: normalizeImageFormat(args.screenshot_format, "screenshot_format"),
      screenshot_quality: clampInt(args.screenshot_quality, 90, 1, 100),
      focus_query: optionalFocusQuery(args.focus_query),
    };
    const capabilities = new Set(this.bridgeStatus().extensionInfo?.capabilities || []);
    if (!capabilities.has("computer_observation_v1")) return this.observeLegacy(normalized, timeoutSeconds, context);

    const result = await this.request("observe_computer", {
      tabId: normalized.tab_id, allFrames: normalized.all_frames, maxElements: normalized.max_elements, maxAxNodes: normalized.max_ax_nodes,
      maxFrames: normalized.max_frames, axDepth: normalized.ax_depth, includeValues: normalized.include_values, includeScreenshot: normalized.include_screenshot,
      format: normalized.screenshot_format, quality: normalized.screenshot_quality, focusQuery: normalized.focus_query,
    }, timeoutSeconds, context);
    const imageContent = computerObservationImage(result);
    return {
      ...result,
      capture: { ...(result.capture || {}), screenshot_sha256: screenshotSha256(imageContent) },
      imageContent,
    };
  }

  async observeLegacy(args, timeoutSeconds, context) {
    const inspected = await this.inspectPage({
      tab_id: args.tab_id,
      max_elements: args.max_elements,
      include_values: args.include_values,
      all_frames: args.all_frames,
      timeout_seconds: timeoutSeconds,
      focus_query: args.focus_query,
    }, context);
    let imageContent = [];
    if (args.include_screenshot) {
      const screenshot = await this.screenshot({
        tab_id: inspected.tab_id,
        format: args.screenshot_format,
        quality: args.screenshot_quality,
        timeout_seconds: timeoutSeconds,
      }, context);
      imageContent = Array.isArray(screenshot?.$mcp?.content) ? screenshot.$mcp.content : [];
    }
    const rawSemanticEpoch = inspected.frames?.find?.((frame) => frame.frame_id === 0)?.document?.epoch;
    const semanticEpoch = typeof rawSemanticEpoch === "string" ? rawSemanticEpoch : "";
    return {
      tab_id: inspected.tab_id,
      title: inspected.title || "",
      url: inspected.url || "",
      semantic: inspected,
      accessibility: null,
      viewport: null,
      frame_tree: [],
      document_epoch: semanticEpoch,
      capture: {
        atomic: false,
        navigation_coherent: false,
        semantic_epoch: semanticEpoch,
        cdp_epoch: "",
        cdp: false,
        screenshot_source: imageContent.length ? "capture_visible_tab_legacy" : "none",
        coherence: "legacy_extension_without_computer_observation_v1",
        fallback_reason: "extension_reload_required_for_cdp_observation",
        screenshot_sha256: screenshotSha256(imageContent),
      },
      imageContent,
    };
  }
}

function computerObservationImage(result) {
  if (!result?.screenshot?.data) return [];
  if (typeof result.screenshot.data !== "string") throw new Error("browser extension returned an invalid computer observation screenshot");
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(result.screenshot.data);
  if (!match || !browserScreenshotBytes(match[2], match[1])) throw new Error("browser extension returned an invalid computer observation screenshot");
  return [{ type: "image", data: match[2], mimeType: match[1] }];
}

function screenshotSha256(imageContent) {
  const image = (imageContent || []).find((item) => item?.type === "image" && typeof item.data === "string");
  const bytes = image ? browserScreenshotBytes(image.data, image.mimeType) : null;
  return bytes ? createHash("sha256").update(bytes).digest("hex") : "";
}

function browserScreenshotBytes(value, mimeType) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_BROWSER_SCREENSHOT_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 3 || bytes.length > MAX_BROWSER_SCREENSHOT_BYTES || bytes.toString("base64") !== value) return null;
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a ? bytes : null;
  }
  return mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
}

function optionalFocusQuery(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > 1000) throw new Error("focus_query must be a string of at most 1000 characters without NUL bytes");
  return value.trim();
}

function normalizedCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) throw new Error(`${label} must be a number from 0 (inclusive) to 1 (exclusive)`);
  return Object.is(value, -0) ? 0 : value;
}

function normalizeScrollDeltas(args) {
  const deltaX = scrollDelta(args.delta_x, "delta_x");
  const deltaY = scrollDelta(args.delta_y, "delta_y");
  if (deltaX === 0 && deltaY === 0) throw new Error("scroll requires a non-zero delta_x or delta_y");
  return { deltaX, deltaY };
}

function scrollDelta(value, label) {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000) {
    throw new Error(`${label} must be a finite number from -10000 to 10000`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) {
    throw new Error(`${label} must be a string of at most ${maxLength} characters without NUL bytes`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function optionalAuthorityInteger(value, label) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function optionalEpoch(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > 9000) throw new Error("document_epoch is invalid");
  return value;
}

function optionalFrameUrl(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > 8192) throw new Error("frame_url is invalid");
  return value;
}

function optionalSha256(value) {
  if (typeof value !== "string" || !/^[A-Fa-f0-9]{64}$/.test(value)) throw new Error("screenshot_sha256 must be a SHA-256 hex digest");
  return value.toLowerCase();
}

function normalizeExpectedViewport(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("viewport must be an object");
  const output = {};
  for (const key of ["width", "height", "scale"]) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) throw new Error(`viewport.${key} must be a positive number`);
    output[key] = number;
  }
  return output;
}
