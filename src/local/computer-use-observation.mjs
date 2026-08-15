import { createHash } from "node:crypto";

const MAX_DELTA_ENTRIES = 24;
const MAX_APPLICATION_POST_ELEMENTS = 24;
const BROWSER_IDENTITY_FIELDS = Object.freeze([
  "tag", "type", "role", "name", "id", "field_name", "label", "placeholder", "href", "sensitive", "in_shadow_dom",
]);
const BROWSER_COMPARABLE_FIELDS = Object.freeze([
  ...BROWSER_IDENTITY_FIELDS, "visible", "enabled", "editable", "checked", "selected", "focused", "bounding_box",
]);
const APPLICATION_COMPARABLE_FIELDS = Object.freeze([
  "role", "subrole", "name", "title", "description", "identifier", "enabled", "focused", "checked", "selected", "expanded", "visible", "sensitive", "bounding_box", "_machine_owner_window_bounds",
]);

export function extractBrowserPrivateBindings(captured) {
  const frames = Array.isArray(captured?.semantic?.frames) ? captured.semantic.frames : [];
  const semanticUrlCounts = browserSemanticUrlCounts(frames);
  const cdpFrameUrls = browserCdpFrameUrls(captured);
  const trustedBackends = browserTrustedBackends(captured, cdpFrameUrls);
  const bindings = new Map();
  for (const frame of frames) appendBrowserFrameBindings(bindings, frame, semanticUrlCounts, trustedBackends);
  return {
    browser_ref_bindings: bindings,
    browser_history_entry_key: privateBrowserString(captured?._machine_history_entry_key, 512),
  };
}

function browserSemanticUrlCounts(frames) {
  const semanticUrlCounts = new Map();
  for (const frame of frames) {
    const url = privateBrowserString(frame?.document?.url, 8192);
    if (url) semanticUrlCounts.set(url, (semanticUrlCounts.get(url) || 0) + 1);
  }
  return semanticUrlCounts;
}

function browserCdpFrameUrls(captured) {
  const cdpFrameUrls = new Map();
  for (const frame of Array.isArray(captured?.frame_tree) ? captured.frame_tree : []) {
    const frameId = privateBrowserString(frame?.id, 32768);
    const frameUrl = privateBrowserString(frame?.url, 8192);
    if (!frameId || !frameUrl) continue;
    if (cdpFrameUrls.has(frameId) && cdpFrameUrls.get(frameId) !== frameUrl) cdpFrameUrls.set(frameId, "");
    else cdpFrameUrls.set(frameId, frameUrl);
  }
  return cdpFrameUrls;
}

function browserTrustedBackends(captured, cdpFrameUrls) {
  const trustedBackends = new Map();
  for (const node of Array.isArray(captured?.accessibility?.nodes) ? captured.accessibility.nodes : []) {
    const ref = typeof node?.action_ref === "string" && node.action_ref && node.action_ref.length <= 100 && !node.action_ref.includes("\0")
      ? node.action_ref : "";
    const backendNodeId = node?.backend_dom_node_id;
    const frameUrl = cdpFrameUrls.get(privateBrowserString(node?.frame_id, 32768)) || "";
    if (node?.action_ref_confidence !== "high" || !ref || !frameUrl
        || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) continue;
    const prior = trustedBackends.get(ref);
    if (prior && (prior.backendNodeId !== backendNodeId || prior.frameUrl !== frameUrl)) trustedBackends.set(ref, null);
    else if (!trustedBackends.has(ref)) trustedBackends.set(ref, { backendNodeId, frameUrl });
  }
  return trustedBackends;
}

function appendBrowserFrameBindings(bindings, frame, semanticUrlCounts, trustedBackends) {
  const extensionFrameId = frame?.frame_id;
  const extensionFrameEpoch = privateBrowserString(frame?.document?.epoch, 9000);
  const extensionFrameUrl = privateBrowserString(frame?.document?.url, 8192);
  if (!Number.isSafeInteger(extensionFrameId) || extensionFrameId < 0 || !extensionFrameEpoch || !extensionFrameUrl
      || semanticUrlCounts.get(extensionFrameUrl) !== 1) return;
  for (const element of Array.isArray(frame?.elements) ? frame.elements : []) {
    const ref = typeof element?.ref === "string" ? element.ref : "";
    const backendNodeId = element?._machine_backend_node_id;
    const trusted = trustedBackends.get(ref);
    if (!ref || ref.length > 100 || ref.includes("\0") || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0
        || trusted?.backendNodeId !== backendNodeId || trusted?.frameUrl !== extensionFrameUrl) continue;
    bindings.set(ref, {
      backend_node_id: backendNodeId,
      extension_frame_id: extensionFrameId,
      extension_frame_epoch: extensionFrameEpoch,
      extension_frame_url: extensionFrameUrl,
    });
  }
}

export function buildBrowserObservation(captured, args = {}) {
  const inspected = record(captured?.semantic);
  const accessibility = recordOrNull(captured?.accessibility);
  const capture = browserCaptureMetadata(captured, args);
  return {
    snapshot_id: "",
    surface: "browser",
    captured_at: new Date().toISOString(),
    document_epoch: privateBrowserString(captured?.document_epoch, 9000),
    target: {
      tab_id: browserObservationTabId(captured?.tab_id) ?? browserObservationTabId(inspected.tab_id),
      url: privateBrowserString(captured?.url, 32768) || privateBrowserString(inspected.url, 32768),
      title: privateBrowserText(captured?.title, 32768) || privateBrowserText(inspected.title, 32768),
    },
    capture,
    capabilities: browserCapabilities(captured, accessibility, capture),
    semantic: browserSemanticProjection(captured, inspected, accessibility),
  };
}

export function observationDiff(before, after, beforePrivateState = null, afterPrivateState = null) {
  const semanticDelta = before.surface === "browser"
    ? browserSemanticDelta(before, after)
    : applicationSemanticDelta(before, after, beforePrivateState, afterPrivateState);
  const processChanged = before.surface === "application"
    ? applicationProcessEpochChanged(beforePrivateState, afterPrivateState)
    : null;
  const semanticChanged = before.surface === "browser"
    ? semanticFingerprint(before) !== semanticFingerprint(after)
    : processChanged === true || semanticDelta.added_count > 0 || semanticDelta.removed_count > 0 || semanticDelta.changed_count > 0;
  return {
    target_changed: JSON.stringify(before.target) !== JSON.stringify(after.target) || processChanged === true,
    process_changed: processChanged,
    url_changed: before.surface === "browser" ? boundedStringChanged(before.target?.url, after.target?.url, 32768, false) : null,
    title_changed: before.surface === "browser" ? boundedStringChanged(before.target?.title, after.target?.title, 32768, true) : null,
    document_epoch_changed: before.surface === "browser" ? browserDocumentEpochChanged(before, after) : null,
    frame_epoch_changed: before.surface === "browser" ? browserFrameEpochsChanged(before, after) : null,
    history_entry_changed: before.surface === "browser" ? browserHistoryEntryChanged(beforePrivateState, afterPrivateState) : null,
    screenshot_changed: screenshotChange(before, after),
    semantic_changed: semanticChanged,
    semantic_delta: semanticDelta,
  };
}

export function buildContinuation(before, after, target, diff, beforePrivateState = null, afterPrivateState = null) {
  if (!after) {
    return {
      available: false,
      snapshot_id: null,
      reobserve_recommended: true,
      reason: "post_observation_unavailable",
    };
  }
  if (after.surface === "application") {
    const refs = (after.semantic?.elements || []).slice(0, MAX_APPLICATION_POST_ELEMENTS)
      .map((element) => typeof element?.ref === "string" ? element.ref : "").filter(Boolean);
    const targetMapping = mapApplicationTargetToPostSnapshot(before, after, target, beforePrivateState, afterPrivateState);
    const salientRefs = targetMapping.mapped_post_target_ref && refs.includes(targetMapping.mapped_post_target_ref)
      ? [targetMapping.mapped_post_target_ref, ...refs.filter((ref) => ref !== targetMapping.mapped_post_target_ref)]
      : refs;
    return {
      available: true,
      snapshot_id: after.snapshot_id,
      surface: "application",
      previous_refs_reusable: false,
      previous_target_ref: targetMapping.previous_target_ref,
      target_identity_continues: targetMapping.target_identity_continues,
      mapped_post_target_ref: targetMapping.mapped_post_target_ref,
      use_post_snapshot_ref: Boolean(targetMapping.mapped_post_target_ref),
      target_identity_reason: targetMapping.reason,
      post_snapshot_refs_available: refs.length > 0,
      salient_post_refs: salientRefs.slice(0, 12),
      reobserve_recommended: false,
      reason: targetMapping.mapped_post_target_ref
        ? "application_target_identity_mapped_to_post_snapshot"
        : "application_refs_are_snapshot_scoped_use_post_observation_refs",
    };
  }
  const delta = diff?.semantic_delta || emptyDelta();
  const sameEpoch = diff?.document_epoch_changed === false;
  const targetRef = target?.kind === "ref" && typeof target.ref === "string" ? target.ref : "";
  const removedRefs = semanticRefs(delta.removed);
  const addedRefs = semanticRefs(delta.added);
  const changedRefs = semanticRefs(delta.changed.map((entry) => entry?.after));
  const frameEpochChanged = diff?.frame_epoch_changed;
  const targetFrameEpochSame = targetRef ? browserTargetFrameEpochSame(before, after, target) : null;
  const postTarget = targetRef ? browserElementAt(after, target.frame_id, targetRef) : null;
  const targetIdentityContinues = targetRef && targetFrameEpochSame === true && postTarget
    ? browserElementIdentityMatches(target.element, postTarget)
    : targetRef ? false : null;
  const targetReusable = Boolean(
    targetRef
    && sameEpoch
    && targetFrameEpochSame === true
    && targetIdentityContinues === true
    && !removedRefs.includes(targetRef),
  );
  const needsObserve = !sameEpoch || delta.truncated === true;
  return {
    available: true,
    snapshot_id: after.snapshot_id,
    surface: "browser",
    document_epoch_same: sameEpoch,
    frame_epoch_changed: typeof frameEpochChanged === "boolean" ? frameEpochChanged : null,
    stable_ref_namespace: sameEpoch && frameEpochChanged === false,
    previous_target_ref: targetRef || null,
    previous_target_ref_reusable: targetReusable,
    target_frame_epoch_same: targetFrameEpochSame,
    target_identity_continues: targetIdentityContinues,
    added_refs: addedRefs,
    changed_refs: changedRefs,
    removed_refs: removedRefs,
    delta_truncated: delta.truncated === true,
    reobserve_recommended: needsObserve,
    reason: !sameEpoch
      ? "document_epoch_changed"
      : delta.truncated === true
        ? "semantic_delta_truncated"
        : targetRef && targetFrameEpochSame !== true
          ? "target_frame_epoch_changed"
          : targetRef && targetIdentityContinues !== true
            ? "target_semantic_identity_changed"
        : "post_snapshot_ready",
  };
}

function mapApplicationTargetToPostSnapshot(before, after, target, beforePrivateState, afterPrivateState) {
  const identity = applicationTargetIdentity(target, beforePrivateState);
  if (!identity) {
    return { previous_target_ref: null, target_identity_continues: null, mapped_post_target_ref: null, reason: "no_semantic_target" };
  }
  const processContinuity = applicationProcessContinuity(before, after, beforePrivateState, afterPrivateState);
  if (processContinuity !== "same") {
    return {
      previous_target_ref: identity.ref,
      target_identity_continues: false,
      mapped_post_target_ref: null,
      reason: processContinuity === "unknown" ? "application_process_identity_unavailable" : "application_process_changed",
    };
  }
  const bindings = afterPrivateState?.application_ref_bindings;
  if (!bindings?.entries) {
    return { previous_target_ref: identity.ref, target_identity_continues: false, mapped_post_target_ref: null, reason: "post_identity_bindings_unavailable" };
  }
  const selectorKey = JSON.stringify(identity.selector || {});
  for (const [ref, binding] of bindings.entries()) {
    if (binding?.occurrence !== identity.occurrence || JSON.stringify(binding?.selector || {}) !== selectorKey) continue;
    if (!applicationOwnerWindowContinues(identity.owner_window_bounds, boundedBox(binding?.owner_window_bounds))) {
      return { previous_target_ref: identity.ref, target_identity_continues: false, mapped_post_target_ref: null, reason: "owner_window_changed" };
    }
    return {
      previous_target_ref: identity.ref,
      target_identity_continues: true,
      mapped_post_target_ref: typeof ref === "string" ? ref : null,
      reason: "selector_occurrence_and_owner_window_match",
    };
  }
  return { previous_target_ref: identity.ref, target_identity_continues: false, mapped_post_target_ref: null, reason: "target_identity_missing_from_post_snapshot" };
}

function applicationTargetIdentity(target, privateState) {
  const semantic = target?.kind === "ref" ? target : target?.kind === "point" ? target.semantic_delivery : null;
  if (!semantic) return null;
  const ref = typeof semantic.ref === "string" && semantic.ref ? semantic.ref : null;
  const privateBinding = ref ? privateState?.application_ref_bindings?.get?.(ref) || null : null;
  const selector = semantic.selector || privateBinding?.selector || null;
  const occurrence = Number.isInteger(semantic.occurrence) ? semantic.occurrence : privateBinding?.occurrence;
  if (!selector || !Number.isInteger(occurrence)) return null;
  return {
    ref,
    selector,
    occurrence,
    owner_window_bounds: boundedBox(semantic.owner_window_bounds || privateBinding?.owner_window_bounds),
  };
}

function applicationProcessContinuity(before, after, beforePrivateState, afterPrivateState) {
  const beforeApplication = nativeBoundedString(before?.target?.application, 300, false);
  const afterApplication = nativeBoundedString(after?.target?.application, 300, false);
  if (!beforeApplication || !afterApplication) return "unknown";
  if (beforeApplication !== afterApplication) return "changed";
  const left = nativeBoundedString(before?.target?.process_name, 1000, true);
  const right = nativeBoundedString(after?.target?.process_name, 1000, true);
  if (left === null || right === null) return "unknown";
  if (left && right && left !== right) return "changed";
  const changed = applicationProcessEpochChanged(beforePrivateState, afterPrivateState);
  return changed === null ? "unknown" : changed ? "changed" : "same";
}

function browserHistoryEntryChanged(beforePrivateState, afterPrivateState) {
  const beforeKey = privateBrowserString(beforePrivateState?.browser_history_entry_key, 512);
  const afterKey = privateBrowserString(afterPrivateState?.browser_history_entry_key, 512);
  if (!beforeKey || !afterKey) return null;
  return beforeKey !== afterKey;
}

function applicationProcessEpochChanged(beforePrivateState, afterPrivateState) {
  const beforeId = beforePrivateState?.application_process_id;
  const afterId = afterPrivateState?.application_process_id;
  const beforeGeneration = beforePrivateState?.application_process_generation;
  const afterGeneration = afterPrivateState?.application_process_generation;
  if (!Number.isSafeInteger(beforeId) || beforeId < 1 || !Number.isSafeInteger(afterId) || afterId < 1
      || typeof beforeGeneration !== "string" || !beforeGeneration || beforeGeneration.length > 2048 || /[\r\n\0]/.test(beforeGeneration)
      || typeof afterGeneration !== "string" || !afterGeneration || afterGeneration.length > 2048 || /[\r\n\0]/.test(afterGeneration)) return null;
  return beforeId !== afterId || beforeGeneration !== afterGeneration;
}

function nativeBoundedString(value, maxLength, allowEmpty) {
  if (typeof value !== "string" || value.length > maxLength || value.includes("\0") || (!allowEmpty && !value)) return null;
  return value;
}

function privateBrowserString(value, maxLength) {
  return nativeBoundedString(value, maxLength, false) || "";
}

function privateBrowserText(value, maxLength) {
  return nativeBoundedString(value, maxLength, true) ?? "";
}

function browserObservationTabId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function boundedStringChanged(left, right, maxLength, allowEmpty) {
  const a = nativeBoundedString(left, maxLength, allowEmpty);
  const b = nativeBoundedString(right, maxLength, allowEmpty);
  return a === null || b === null ? null : a !== b;
}

function browserObservationEpoch(observation) {
  return privateBrowserString(observation?.capture?.semantic_epoch, 9000)
    || privateBrowserString(observation?.document_epoch, 9000);
}

function browserDocumentEpochChanged(before, after) {
  const left = browserObservationEpoch(before);
  const right = browserObservationEpoch(after);
  return left && right ? left !== right : null;
}

function applicationOwnerWindowContinues(beforeBounds, afterBounds) {
  if (!beforeBounds && !afterBounds) return true;
  if (!beforeBounds || !afterBounds) return false;
  return ["x", "y", "width", "height"].every((key) => nearNumber(beforeBounds[key], afterBounds[key], 1));
}

export function projectPostObservation(observation, detail) {
  if (detail === "full") return observation;
  const base = compactObservationBase(observation);
  if (observation.surface === "browser") return compactBrowserObservation(observation, base);
  return compactApplicationObservation(observation, base);
}

function browserCaptureMetadata(captured, args) {
  const source = record(captured?.capture);
  return {
    semantic: true,
    screenshot: args.include_screenshot !== false,
    atomic: source.atomic === true,
    navigation_coherent: source.navigation_coherent === true,
    frame_epochs_coherent: source.frame_epochs_coherent === true,
    coherence: privateBrowserString(source.coherence, 128) || "unknown",
    semantic_epoch: privateBrowserString(source.semantic_epoch, 9000),
    cdp_epoch: privateBrowserString(source.cdp_epoch, 9000),
    cdp: source.cdp === true,
    cdp_components: publicRecordOrNull(source.cdp_components),
    screenshot_source: privateBrowserString(source.screenshot_source, 64) || "none",
    screenshot_format: source.screenshot_format === "png" || source.screenshot_format === "jpeg" ? source.screenshot_format : "",
    screenshot_quality: validScreenshotQuality(source.screenshot_quality),
    screenshot_sha256: validSha256(source.screenshot_sha256),
    ...(privateBrowserText(source.fallback_reason, 500) ? { fallback_reason: privateBrowserText(source.fallback_reason, 500) } : {}),
    ...(privateBrowserText(source.screenshot_fallback_reason, 500) ? { screenshot_fallback_reason: privateBrowserText(source.screenshot_fallback_reason, 500) } : {}),
  };
}

function browserCapabilities(captured, accessibility, capture) {
  const fusedActionRefs = Array.isArray(accessibility?.nodes)
    ? accessibility.nodes.filter((node) => node?.action_ref_confidence === "high" && typeof node?.action_ref === "string").length
    : 0;
  return {
    snapshot_bound_refs: true,
    stable_backend_refs: true,
    screenshot: true,
    action_verification: true,
    chromium_accessibility_tree: Boolean(accessibility && accessibility.available !== false),
    fused_accessibility_action_refs: fusedActionRefs,
    cdp_surface_screenshot: capture.screenshot_source === "cdp_surface",
    document_epoch_preflight: Boolean(capture.semantic_epoch),
    snapshot_bound_visual_points: capture.screenshot_source === "cdp_surface"
      && capture.navigation_coherent === true
      && Boolean(capture.screenshot_sha256)
      && isPositiveViewport(captured?.viewport),
    visual_grounding: false,
  };
}

function browserSemanticProjection(captured, inspected, accessibility) {
  return {
    kind: accessibility?.available !== false && accessibility ? "browser-hybrid" : "browser-dom",
    frames: sanitizeBrowserFrames(inspected.frames),
    total_elements: nonNegativeSafeInteger(inspected.total_elements),
    max_elements: nonNegativeSafeInteger(inspected.max_elements),
    frames_truncated: inspected.frames_truncated === true,
    selection: publicRecordOrNull(inspected.selection),
    accessibility: sanitizeAccessibility(accessibility),
    viewport: publicRecordOrNull(captured?.viewport),
    frame_tree: Array.isArray(captured?.frame_tree) ? captured.frame_tree.map((frame) => publicRecord(frame)) : [],
  };
}

function sanitizeAccessibility(accessibility) {
  if (!accessibility) return null;
  const publicAccessibility = publicRecord(accessibility);
  delete publicAccessibility.nodes;
  return {
    ...publicAccessibility,
    nodes: (Array.isArray(accessibility.nodes) ? accessibility.nodes : [])
      .map((node) => publicRecord(node, new Set(["backend_dom_node_id", "backendDOMNodeId"]))),
  };
}

function sanitizeBrowserFrames(frames) {
  return (Array.isArray(frames) ? frames : []).map((frame) => {
    const publicFrame = publicRecord(frame);
    delete publicFrame.document;
    delete publicFrame.elements;
    return {
      ...publicFrame,
      document: publicRecord(frame?.document),
      elements: (Array.isArray(frame?.elements) ? frame.elements : [])
        .map((element) => publicRecord(element, new Set(["backend_dom_node_id", "backendDOMNodeId"]))),
    };
  });
}

function browserSemanticDelta(before, after) {
  return mapSemanticDelta(
    browserElementMap(before),
    browserElementMap(after),
    browserElementSummary,
    BROWSER_COMPARABLE_FIELDS,
  );
}

function browserElementMap(observation) {
  const map = new Map();
  const topEpoch = browserObservationEpoch(observation);
  if (!topEpoch) return map;
  for (const frame of observation.semantic?.frames || []) {
    if (!Number.isSafeInteger(frame?.frame_id) || frame.frame_id < 0) continue;
    const frameEpoch = privateBrowserString(frame?.document?.epoch, 9000) || topEpoch;
    const frameUrl = privateBrowserString(frame?.document?.url, 32768);
    if (!frameEpoch || !frameUrl) continue;
    for (const element of frame?.elements || []) {
      if (typeof element?.ref !== "string" || !element.ref) continue;
      map.set(`${topEpoch}|${frame.frame_id}|${frameEpoch}|${frameUrl}|${element.ref}`, { ...element, frame_id: frame.frame_id });
    }
  }
  return map;
}

function browserFrameEpochsChanged(before, after) {
  if (before.semantic?.frames_truncated === true || after.semantic?.frames_truncated === true) return null;
  const left = browserFrameEpochMap(before);
  const right = browserFrameEpochMap(after);
  if (!left || !right) return null;
  if (left.size !== right.size) return true;
  for (const [frameId, identity] of left) if (right.get(frameId) !== identity) return true;
  return false;
}

function browserFrameEpochMap(observation) {
  const map = new Map();
  for (const frame of observation.semantic?.frames || []) {
    if (!Number.isSafeInteger(frame?.frame_id) || frame.frame_id < 0) return null;
    const epoch = privateBrowserString(frame?.document?.epoch, 9000);
    const url = privateBrowserString(frame?.document?.url, 32768);
    if (!epoch || !url) return null;
    map.set(frame.frame_id, `${epoch}\u0000${url}`);
  }
  return map;
}

function browserTargetFrameEpochSame(before, after, target) {
  if (!Number.isSafeInteger(target?.frame_id) || target.frame_id < 0) return false;
  const beforeFrame = (before.semantic?.frames || []).find((frame) => frame?.frame_id === target.frame_id);
  const afterFrame = (after.semantic?.frames || []).find((frame) => frame?.frame_id === target.frame_id);
  if (!beforeFrame || !afterFrame) return false;
  const beforeEpoch = privateBrowserString(beforeFrame.document?.epoch, 9000);
  const afterEpoch = privateBrowserString(afterFrame.document?.epoch, 9000);
  const beforeUrl = privateBrowserString(beforeFrame.document?.url, 32768);
  const afterUrl = privateBrowserString(afterFrame.document?.url, 32768);
  return Boolean(beforeEpoch && afterEpoch && beforeUrl && afterUrl)
    && beforeEpoch === afterEpoch
    && beforeUrl === afterUrl;
}

function browserElementAt(observation, frameId, ref) {
  const frame = (observation.semantic?.frames || []).find((candidate) => candidate?.frame_id === frameId);
  return (frame?.elements || []).find((element) => element?.ref === ref) || null;
}

function browserElementIdentityMatches(before, after) {
  if (!before || !after) return false;
  return BROWSER_IDENTITY_FIELDS.every((field) => !Object.hasOwn(before, field) || equivalentField(before[field], after[field], field));
}

function applicationSemanticDelta(before, after, beforePrivateState, afterPrivateState) {
  return mapSemanticDelta(
    applicationElementMap(before, beforePrivateState),
    applicationElementMap(after, afterPrivateState),
    applicationElementSummary,
    APPLICATION_COMPARABLE_FIELDS,
  );
}

function applicationElementMap(observation, privateState = null) {
  const map = new Map();
  const bindings = privateState?.application_ref_bindings;
  const fallbackOccurrences = new Map();
  for (const element of observation.semantic?.elements || []) {
    const binding = bindings?.get?.(element?.ref);
    let key = "";
    if (binding?.selector && Number.isInteger(binding.occurrence)) {
      key = `${JSON.stringify(binding.selector)}#${binding.occurrence}`;
    } else {
      const identity = JSON.stringify([
        element.identifier || "", element.role || "", element.subrole || "", element.name || "",
        element.title || "", element.description || "",
      ]);
      const occurrence = fallbackOccurrences.get(identity) || 0;
      fallbackOccurrences.set(identity, occurrence + 1);
      key = `${identity}#${occurrence}`;
    }
    map.set(key, {
      ...element,
      _machine_owner_window_bounds: binding?.owner_window_bounds || null,
    });
  }
  return map;
}

function mapSemanticDelta(beforeMap, afterMap, summarize, comparableFields) {
  const added = [];
  const removed = [];
  const changed = [];
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  for (const [key, value] of afterMap) {
    if (!beforeMap.has(key)) {
      addedCount += 1;
      pushBounded(added, summarize(value));
      continue;
    }
    const previous = beforeMap.get(key);
    const fields = comparableFields
      .filter((field) => !equivalentField(previous?.[field], value?.[field], field))
      .map(publicChangedField);
    if (!fields.length) continue;
    changedCount += 1;
    pushBounded(changed, {
      before: summarize(previous),
      after: summarize(value),
      changed_fields: fields,
    });
  }
  for (const [key, value] of beforeMap) {
    if (afterMap.has(key)) continue;
    removedCount += 1;
    pushBounded(removed, summarize(value));
  }
  return {
    before_count: beforeMap.size,
    after_count: afterMap.size,
    added_count: addedCount,
    removed_count: removedCount,
    changed_count: changedCount,
    added,
    removed,
    changed,
    truncated: addedCount > added.length || removedCount > removed.length || changedCount > changed.length,
  };
}

function browserElementSummary(element) {
  return {
    ref: typeof element?.ref === "string" ? element.ref : "",
    frame_id: Number.isInteger(element?.frame_id) ? element.frame_id : null,
    role: boundedText(element?.role, 200),
    name: boundedText(element?.name || element?.label || element?.placeholder, 500),
    visible: element?.visible === true,
    enabled: element?.enabled === true,
    editable: element?.editable === true,
    checked: element?.checked === true,
    focused: element?.focused === true,
    sensitive: element?.sensitive === true,
    bounding_box: boundedBox(element?.bounding_box),
  };
}

function applicationElementSummary(element) {
  return {
    ref: typeof element?.ref === "string" ? element.ref : "",
    role: boundedText(element?.role, 200),
    subrole: boundedText(element?.subrole, 200),
    name: boundedText(element?.name || element?.title || element?.description, 500),
    identifier: boundedText(element?.identifier, 500),
    enabled: element?.enabled === true,
    focused: element?.focused === true,
    checked: typeof element?.checked === "boolean" ? element.checked : null,
    selected: typeof element?.selected === "boolean" ? element.selected : null,
    expanded: typeof element?.expanded === "boolean" ? element.expanded : null,
    visible: element?.visible === true,
    sensitive: element?.sensitive === true,
    bounding_box: boundedBox(element?.bounding_box),
  };
}

function equivalentField(left, right, field) {
  if (field !== "bounding_box" && field !== "_machine_owner_window_bounds") return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  if (!left && !right) return true;
  if (!left || !right) return false;
  const tolerance = field === "_machine_owner_window_bounds" ? 1 : 2;
  return ["x", "y", "width", "height"].every((key) => nearNumber(left[key], right[key], tolerance));
}

function publicChangedField(field) {
  return field === "_machine_owner_window_bounds" ? "owner_window" : field;
}

function compactObservationBase(observation) {
  return {
    snapshot_id: observation.snapshot_id,
    surface: observation.surface,
    captured_at: observation.captured_at,
    target: observation.target,
    capture: observation.capture,
    capabilities: observation.capabilities,
  };
}

function compactBrowserObservation(observation, base) {
  const accessibility = observation.semantic?.accessibility;
  return {
    ...base,
    document_epoch: observation.document_epoch || "",
    semantic: {
      kind: observation.semantic?.kind || "",
      total_elements: nonNegativeSafeInteger(observation.semantic?.total_elements),
      max_elements: nonNegativeSafeInteger(observation.semantic?.max_elements),
      frames_truncated: observation.semantic?.frames_truncated === true,
      selection: observation.semantic?.selection || null,
      viewport: observation.semantic?.viewport || null,
      accessibility: accessibility ? {
        available: accessibility.available !== false,
        returned_nodes: nonNegativeSafeInteger(accessibility.returned_nodes),
        observed_nodes: nonNegativeSafeInteger(accessibility.observed_nodes),
        ignored_nodes: nonNegativeSafeInteger(accessibility.ignored_nodes),
        truncated: accessibility.truncated === true,
        query_matched: typeof accessibility.query_matched === "boolean" ? accessibility.query_matched : null,
        query_match_count: optionalFiniteNumber(accessibility.query_match_count),
        query_search_exhaustive: typeof accessibility.query_search_exhaustive === "boolean" ? accessibility.query_search_exhaustive : null,
        top_query_score: optionalFiniteNumber(accessibility.top_query_score),
        failed_frame_count: nonNegativeSafeInteger(accessibility.failed_frame_count),
      } : null,
    },
  };
}

function compactApplicationObservation(observation, base) {
  const elements = Array.isArray(observation.semantic?.elements) ? observation.semantic.elements : [];
  const returned = elements.slice(0, MAX_APPLICATION_POST_ELEMENTS).map(applicationElementSummary);
  return {
    ...base,
    semantic: {
      kind: observation.semantic?.kind || "",
      element_count: elements.length,
      truncated: observation.semantic?.truncated === true,
      menus_included: observation.semantic?.menus_included === true,
      selection: observation.semantic?.selection || null,
      elements: returned,
      elements_truncated: elements.length > returned.length,
    },
  };
}

function semanticRefs(values) {
  const refs = [];
  for (const value of values || []) {
    const ref = typeof value?.ref === "string" ? value.ref : "";
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function emptyDelta() {
  return { added: [], removed: [], changed: [], truncated: false };
}

function screenshotChange(before, after) {
  const left = validSha256(before.capture?.screenshot_sha256);
  const right = validSha256(after.capture?.screenshot_sha256);
  return left && right ? left !== right : null;
}

function validScreenshotQuality(value) {
  if (value === undefined || value === null) return null;
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
}

function validSha256(value) {
  if (typeof value !== "string") return "";
  const digest = value.toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : "";
}

function semanticFingerprint(observation) {
  return createHash("sha256").update(JSON.stringify({ target: observation.target, semantic: observation.semantic })).digest("hex");
}

function isPositiveViewport(value) {
  return Boolean(value
    && typeof value.width === "number" && Number.isFinite(value.width) && value.width > 0
    && typeof value.height === "number" && Number.isFinite(value.height) && value.height > 0
    && typeof value.scale === "number" && Number.isFinite(value.scale) && value.scale > 0);
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function publicRecord(value, excluded = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("_machine_") || excluded?.has(key)) continue;
    output[key] = item;
  }
  return output;
}

function publicRecordOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? publicRecord(value) : null;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function optionalFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}


function recordOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function pushBounded(list, value) {
  if (list.length < MAX_DELTA_ENTRIES) list.push(value);
}

function boundedBox(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const key of ["x", "y", "width", "height"]) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) return null;
    out[key] = Math.round(number * 100) / 100;
  }
  return out;
}

function boundedText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function nearNumber(left, right, tolerance) {
  return typeof left === "number" && Number.isFinite(left)
    && typeof right === "number" && Number.isFinite(right)
    && Math.abs(left - right) <= tolerance;
}
