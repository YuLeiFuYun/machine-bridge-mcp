import { createHash } from "node:crypto";
import { BROWSER_DOCUMENT_BOUND_TARGETLESS_ACTIONS, applicationScreenshotError, applicationTargetGeometryMatches, applicationTargetHasGeometry, applicationTargetInspection, applicationWindowBinding, applyApplicationTargetGeometry, browserObservationSemanticEpoch, currentApplicationSemanticPointCandidates, enforceBrowserHistoryDocumentPreflight, privateBrowserHistoryEntryKey, sameApplicationWindowBinding, sameApplicationWindowIdentity, sameVisualViewport, staleSnapshot } from "./computer-use-geometry.mjs";
import { browserScrollDelta, clampInt, normalizeInputMode, normalizeNavigationWait, requiredResource, requiredString, requiredStringAllowEmpty, APPLICATION_OPERATION_REASON, applicationOperationReason } from "./computer-use-contracts.mjs";
import { requiredComputerActRemainingTimeoutSeconds, validateApplicationInspectionEvidence } from "./computer-use-policies.mjs";
import { applicationProcessIdentityError, applicationProcessIdentityMatches, applicationVisualDispatchError, browserSnapshotDispatchError, browserSnapshotIdentity, findApplicationMatch, requiredPrivateApplicationProcessGeneration, requiredPrivateApplicationProcessId, trySnapshotBoundBackendAction } from "./computer-use-verification.mjs";
import { BridgeError, errorCode } from "../core/errors.mjs";

export const BROWSER_TARGETLESS_ACTIONS = new Set(["navigate", "reload", "back", "forward"]);

export async function preflightBrowserTarget(ctx, observation, privateState, action, target, context, actionDeadline = null) {
  const tabs = await ctx.browser.listTabs({
    include_pinned: true,
    timeout_seconds: requiredComputerActRemainingTimeoutSeconds(actionDeadline, 5),
  }, context);
  const tab = (tabs.tabs || []).find((item) => item.id === observation.target.tab_id || item.tab_id === observation.target.tab_id);
  if (!tab) throw staleSnapshot("browser tab no longer exists");
  const tabUrl = typeof tab.url === "string" ? tab.url : "";
  const snapshotUrl = typeof observation.target.url === "string" ? observation.target.url : "";
  if (!tabUrl || !snapshotUrl || tabUrl !== snapshotUrl) throw staleSnapshot("browser tab navigated after the snapshot");
  const semanticEpoch = typeof observation.capture?.semantic_epoch === "string" ? observation.capture.semantic_epoch : "";
  let currentDocument = null;
  let documentStateError = null;
  if (semanticEpoch && typeof ctx.browser.documentState === "function") {
    const documentStateTimeoutSeconds = requiredComputerActRemainingTimeoutSeconds(actionDeadline, 5);
    try {
      currentDocument = await ctx.browser.documentState({
        tab_id: observation.target.tab_id,
        timeout_seconds: documentStateTimeoutSeconds,
      }, context);
      if (currentDocument?.document_epoch !== undefined && currentDocument?.document_epoch !== null
          && (typeof currentDocument.document_epoch !== "string" || currentDocument.document_epoch !== semanticEpoch)) {
        throw staleSnapshot("browser document was replaced after the snapshot");
      }
    } catch (error) {
      if (error instanceof BridgeError && error.details?.reason === "stale_snapshot") throw error;
      documentStateError = error;
    }
  }
  enforceBrowserHistoryDocumentPreflight(
    action, semanticEpoch, privateBrowserHistoryEntryKey(privateState?.browser_history_entry_key), currentDocument, documentStateError,
  );
  if (target?.kind === "point") {
    if (!currentDocument) {
      throw new BridgeError("unavailable", "cannot validate the visual snapshot before point dispatch; observe again or use a semantic ref", {
        details: { reason: "visual_preflight_unavailable", ...(documentStateError ? { error_class: errorCode(documentStateError) } : {}) },
      });
    }
    if (!sameVisualViewport(target.viewport, currentDocument.viewport)) throw staleSnapshot("browser viewport changed after the screenshot");
  } else if (target) {
    const targetWaitTimeoutSeconds = requiredComputerActRemainingTimeoutSeconds(actionDeadline, 1);
    try {
      await ctx.browser.wait({
        tab_id: observation.target.tab_id,
        frame_id: target.frame_id,
        selector: { ref: target.ref },
        state: "attached",
        timeout_seconds: targetWaitTimeoutSeconds,
      }, context);
    } catch {
      throw staleSnapshot("browser target ref is no longer attached");
    }
  }
}

export async function preflightApplicationSemanticPoint(
  ctx, observation, target, expectedProcessId, expectedProcessGeneration, context, actionDeadline = null,
) {
  if (typeof ctx.applications.captureApplication !== "function") {
    throw new BridgeError("unavailable", "cannot revalidate the application screenshot before semantic point delivery", {
      details: { reason: "application_visual_preflight_unavailable" },
    });
  }
  const screenshotTimeoutSeconds = requiredComputerActRemainingTimeoutSeconds(actionDeadline, 10);
  let captured;
  try {
    captured = await ctx.applications.captureApplication({
      application: observation.target.application,
      expected_process_id: expectedProcessId,
      expected_process_generation: expectedProcessGeneration,
      timeout_seconds: screenshotTimeoutSeconds,
    }, context);
  } catch (error) {
    if (applicationProcessIdentityError(error)) {
      throw staleSnapshot("application process instance changed before semantic point screenshot revalidation");
    }
    throw new BridgeError("unavailable", "cannot recapture the application window before semantic point delivery", {
      details: { reason: "application_visual_preflight_unavailable", detail: applicationScreenshotError(error) },
    });
  }
  const screenshot = captured?.screenshot;
  const data = screenshot?.source === "macos_window" && screenshot?.mime_type === "image/png" && typeof screenshot?.data === "string"
    ? screenshot.data : "";
  const digest = data ? createHash("sha256").update(Buffer.from(data, "base64")).digest("hex") : "";
  const currentBinding = applicationWindowBinding(captured, digest);
  if (!sameApplicationWindowBinding(target.window_binding, currentBinding)) {
    throw staleSnapshot("application window identity, bounds, or screenshot changed before semantic point delivery");
  }
  const semantic = target.semantic_delivery;
  const inspection = applicationTargetInspection(target);
  let current;
  try {
    current = await ctx.applications.inspectApplication({
      application: observation.target.application,
      include_process_id: true,
      expected_process_id: expectedProcessId,
      expected_process_generation: expectedProcessGeneration,
      max_depth: inspection.max_depth,
      max_elements: 500,
      include_values: false,
      include_menus: inspection.include_menus,
      include_geometry: applicationTargetHasGeometry(target),
      timeout_seconds: requiredComputerActRemainingTimeoutSeconds(actionDeadline, 10),
    }, context);
  } catch (error) {
    if (applicationProcessIdentityError(error)) {
      throw staleSnapshot("application process instance changed during semantic point preflight");
    }
    throw error;
  }
  try { validateApplicationInspectionEvidence(current); }
  catch { throw staleSnapshot("application Accessibility evidence became invalid during semantic point preflight"); }
  if (!applicationProcessIdentityMatches(current, expectedProcessId, expectedProcessGeneration)) {
    throw staleSnapshot("application process instance changed during semantic point preflight");
  }
  const matched = findApplicationMatch(current.elements, semantic.selector, semantic.occurrence);
  if (!matched) {
    throw staleSnapshot("application semantic point target is no longer present with the observed identity");
  }
  if (!applicationTargetGeometryMatches(matched, target)) {
    throw staleSnapshot("application semantic point target window or geometry changed before dispatch");
  }
  if (current.truncated === true) {
    throw staleSnapshot("application semantic point Accessibility coverage became incomplete before dispatch");
  }
  const livePointCandidates = currentApplicationSemanticPointCandidates(current.elements, target);
  if (livePointCandidates.length !== 1 || livePointCandidates[0] !== matched) {
    throw staleSnapshot("application semantic point no longer resolves uniquely to the same Accessibility target");
  }
  if (typeof ctx.applications.inspectApplicationWindow === "function") {
    const currentWindow = await ctx.applications.inspectApplicationWindow({
      application: observation.target.application,
      expected_process_id: expectedProcessId,
      expected_process_generation: expectedProcessGeneration,
      timeout_seconds: requiredComputerActRemainingTimeoutSeconds(actionDeadline, 10),
    }, context).catch(() => null);
    if (!sameApplicationWindowIdentity(target.window_binding, currentWindow)) {
      throw staleSnapshot("application window changed during semantic point preflight");
    }
  }
}

export async function dispatchBrowserDrag(ctx, observation, target, destination, args, context) {
  const inputMode = normalizeInputMode(args.input_mode);
  if (inputMode === "dom") throw new BridgeError("invalid_request", "snapshot-bound drag requires trusted browser input");
  if (normalizeNavigationWait(args.wait_for) !== "none") {
    throw new BridgeError("invalid_request", "wait_for is not supported for drag; use expect.* post-conditions instead");
  }
  if (target?.kind === "point") {
    try {
      return await ctx.browser.pointAction({
        tab_id: observation.target.tab_id,
        action: "drag",
        normalized_x: target.normalized_x,
        normalized_y: target.normalized_y,
        destination_normalized_x: destination.normalized_x,
        destination_normalized_y: destination.normalized_y,
        document_epoch: browserObservationSemanticEpoch(observation),
        viewport: target.viewport,
        screenshot_sha256: target.screenshot_sha256,
        screenshot_format: target.screenshot_format,
        screenshot_quality: target.screenshot_quality,
        timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
      }, context);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("visual_snapshot_changed_before_dispatch")
          || message.includes("visual snapshot changed before trusted input; observe again")) {
        throw staleSnapshot("browser screenshot changed after the visual snapshot");
      }
      throw error;
    }
  }
  if (!target?.trusted_binding || !destination?.trusted_binding) {
    throw new BridgeError("unavailable", "snapshot-bound ref drag requires trusted backend bindings for both endpoints; observe with a screenshot and use point targets if needed", {
      details: { reason: "snapshot_backend_drag_unavailable" },
    });
  }
  try {
    return await ctx.browser.backendNodeAction({
      tab_id: observation.target.tab_id,
      action: "drag",
      backend_node_id: target.trusted_binding.backend_node_id,
      extension_frame_id: target.trusted_binding.extension_frame_id,
      frame_document_epoch: target.trusted_binding.extension_frame_epoch,
      frame_url: target.trusted_binding.extension_frame_url,
      extension_ref: target.ref,
      expected_ref_identity: browserSnapshotIdentity(target.element),
      destination_backend_node_id: destination.trusted_binding.backend_node_id,
      destination_extension_frame_id: destination.trusted_binding.extension_frame_id,
      destination_frame_document_epoch: destination.trusted_binding.extension_frame_epoch,
      destination_frame_url: destination.trusted_binding.extension_frame_url,
      destination_extension_ref: destination.ref,
      destination_expected_ref_identity: browserSnapshotIdentity(destination.element),
      document_epoch: browserObservationSemanticEpoch(observation),
      timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
    }, context);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("snapshot backend target changed before trusted input; observe again")
        || message.includes("snapshot_backend_target_changed_before_dispatch")) {
      throw staleSnapshot("browser drag endpoint identity changed before trusted input");
    }
    if (message.includes("outcome is unknown") || message.includes("partially dispatched")) throw error;
    throw new BridgeError("unavailable", "snapshot-bound trusted drag is unavailable before dispatch", {
      cause: error instanceof Error ? error : undefined,
      details: { reason: "snapshot_backend_drag_unavailable" },
    });
  }
}

export async function dispatchBrowserScroll(ctx, observation, target, args, context) {
  const inputMode = normalizeInputMode(args.input_mode);
  if (inputMode === "dom") throw new BridgeError("invalid_request", "snapshot-bound scroll requires trusted browser input");
  if (normalizeNavigationWait(args.wait_for) !== "none") {
    throw new BridgeError("invalid_request", "wait_for is not supported for scroll; use expect.* post-conditions instead");
  }
  const deltaX = browserScrollDelta(args.delta_x, "delta_x");
  const deltaY = browserScrollDelta(args.delta_y, "delta_y");
  if (deltaX === 0 && deltaY === 0) throw new BridgeError("invalid_request", "browser scroll requires a non-zero delta_x or delta_y");
  if (target?.kind === "point") {
    try {
      return await ctx.browser.pointAction({
        tab_id: observation.target.tab_id,
        action: "scroll",
        normalized_x: target.normalized_x,
        normalized_y: target.normalized_y,
        delta_x: deltaX,
        delta_y: deltaY,
        document_epoch: browserObservationSemanticEpoch(observation),
        viewport: target.viewport,
        screenshot_sha256: target.screenshot_sha256,
        screenshot_format: target.screenshot_format,
        screenshot_quality: target.screenshot_quality,
        timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
      }, context);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("visual_snapshot_changed_before_dispatch")
          || message.includes("visual snapshot changed before trusted input; observe again")) {
        throw staleSnapshot("browser screenshot changed after the visual snapshot");
      }
      throw error;
    }
  }
  if (!target?.trusted_binding) {
    throw new BridgeError("unavailable", "snapshot-bound ref scroll requires a trusted backend binding; observe with a screenshot and use a point target if needed", {
      details: { reason: "snapshot_backend_scroll_unavailable" },
    });
  }
  try {
    return await ctx.browser.backendNodeAction({
      tab_id: observation.target.tab_id,
      action: "scroll",
      backend_node_id: target.trusted_binding.backend_node_id,
      extension_frame_id: target.trusted_binding.extension_frame_id,
      frame_document_epoch: target.trusted_binding.extension_frame_epoch,
      frame_url: target.trusted_binding.extension_frame_url,
      extension_ref: target.ref,
      expected_ref_identity: browserSnapshotIdentity(target.element),
      document_epoch: browserObservationSemanticEpoch(observation),
      delta_x: deltaX,
      delta_y: deltaY,
      timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
    }, context);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("snapshot backend target changed before trusted input; observe again")
        || message.includes("snapshot_backend_target_changed_before_dispatch")) {
      throw staleSnapshot("browser scroll anchor identity changed before trusted input");
    }
    if (message.includes("outcome is unknown") || message.includes("partially dispatched")) throw error;
    throw new BridgeError("unavailable", "snapshot-bound trusted scroll is unavailable before dispatch", {
      cause: error instanceof Error ? error : undefined,
      details: { reason: "snapshot_backend_scroll_unavailable" },
    });
  }
}

export async function dispatchBrowserAction(ctx, observation, privateState, action, target, args, context, destination = null) {
  if (action === "drag") return dispatchBrowserDrag(ctx, observation, target, destination, args, context);
  if (action === "scroll") return dispatchBrowserScroll(ctx, observation, target, args, context);
  if (target?.kind === "point") {
    const inputMode = normalizeInputMode(args.input_mode);
    if (inputMode === "dom") throw new BridgeError("invalid_request", "snapshot-bound visual point actions require trusted input");
    if (normalizeNavigationWait(args.wait_for) !== "none") {
      throw new BridgeError("invalid_request", "wait_for is not supported for visual point dispatch; use expect.load_state or another post-condition");
    }
    try {
      return await ctx.browser.pointAction({
        tab_id: observation.target.tab_id,
        action,
        normalized_x: target.normalized_x,
        normalized_y: target.normalized_y,
        document_epoch: browserObservationSemanticEpoch(observation),
        viewport: target.viewport,
        screenshot_sha256: target.screenshot_sha256,
        screenshot_format: target.screenshot_format,
        screenshot_quality: target.screenshot_quality,
        timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
      }, context);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("visual_snapshot_changed_before_dispatch")
          || message.includes("visual snapshot changed before trusted input; observe again")) {
        throw staleSnapshot("browser screenshot changed after the visual snapshot");
      }
      throw error;
    }
  }
  const inputMode = normalizeInputMode(args.input_mode);
  const navigationWait = normalizeNavigationWait(args.wait_for);
  const boundResult = await trySnapshotBoundBackendAction({
    browser: ctx.browser,
    observation,
    action,
    target,
    args,
    context,
    inputMode,
    navigationWait,
  });
  if (boundResult) return boundResult;
  const call = {
    tab_id: observation.target.tab_id,
    action,
    timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
    wait_for: navigationWait,
    input_mode: inputMode,
    element_timeout_seconds: clampInt(args.element_timeout_seconds, 10, 1, 60),
  };
  if (target) {
    call.frame_id = target.frame_id;
    call.selector = { ref: target.ref };
    call.expected_ref_identity = browserSnapshotIdentity(target.element);
  }
  if (BROWSER_TARGETLESS_ACTIONS.has(action)) {
    const expectedTabUrl = typeof observation.target?.url === "string" ? observation.target.url : "";
    if (expectedTabUrl) call.expected_tab_url = expectedTabUrl;
  }
  if (BROWSER_DOCUMENT_BOUND_TARGETLESS_ACTIONS.has(action)) {
    const semanticEpoch = browserObservationSemanticEpoch(observation);
    const historyEntryKey = privateBrowserHistoryEntryKey(privateState?.browser_history_entry_key);
    if (semanticEpoch) call.expected_document_epoch = semanticEpoch;
    if (historyEntryKey) call.expected_history_entry_key = historyEntryKey;
  }
  if (action === "navigate") call.url = requiredString(args.url, "url", 32768);
  if (args.value !== undefined) call.value = requiredStringAllowEmpty(args.value, "value", 131072);
  if (args.value_resource !== undefined) call.value_resource = requiredResource(args.value_resource);
  if (args.key !== undefined) call.key = requiredString(args.key, "key", 100);
  try {
    return await ctx.browser.act(call, context);
  } catch (error) {
    throw browserSnapshotDispatchError(error);
  }
}

export async function dispatchApplicationAction(ctx, observation, privateState, action, target, args, context, destination = null) {
  const expectedProcessId = requiredPrivateApplicationProcessId(privateState?.application_process_id);
  const expectedProcessGeneration = requiredPrivateApplicationProcessGeneration(privateState?.application_process_generation);
  if (target?.kind === "point") {
    if (action === "drag") {
      try {
        return await ctx.applications.dragApplication({
          application: observation.target.application,
          expected_process_id: expectedProcessId,
          expected_process_generation: expectedProcessGeneration,
          normalized_x: target.normalized_x,
          normalized_y: target.normalized_y,
          destination_normalized_x: destination.normalized_x,
          destination_normalized_y: destination.normalized_y,
          window_id: target.window_binding.window_id,
          bounds: target.window_binding.bounds,
          screenshot_sha256: target.window_binding.screenshot_sha256,
          timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
        }, context);
      } catch (error) {
        throw applicationVisualDispatchError(error, {
          staleDetail: "application window identity, bounds, or screenshot changed immediately before visual drag",
          processDetail: "application process changed immediately before visual drag",
          unavailableMessage: "application visual drag could not be validated before dispatch",
        });
      }
    }
    if (action === "scroll") {
      try {
        return await ctx.applications.scrollApplication({
          application: observation.target.application,
          expected_process_id: expectedProcessId,
          expected_process_generation: expectedProcessGeneration,
          normalized_x: target.normalized_x,
          normalized_y: target.normalized_y,
          delta_x: args.delta_x,
          delta_y: args.delta_y,
          window_id: target.window_binding.window_id,
          bounds: target.window_binding.bounds,
          screenshot_sha256: target.window_binding.screenshot_sha256,
          timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
        }, context);
      } catch (error) {
        throw applicationVisualDispatchError(error, {
          staleDetail: "application window identity, bounds, or screenshot changed immediately before visual scroll",
          processDetail: "application process changed immediately before visual scroll",
          unavailableMessage: "application visual scroll could not be validated before dispatch",
        });
      }
    }
    if (target.semantic_delivery) {
      const semantic = target.semantic_delivery;
      const selector = semantic.occurrence > 0 ? { ...semantic.selector, index: semantic.occurrence } : semantic.selector;
      const inspection = applicationTargetInspection(target);
      const call = applyApplicationTargetGeometry({
        application: observation.target.application,
        expected_process_id: expectedProcessId,
        expected_process_generation: expectedProcessGeneration,
        action: "click",
        selector,
        timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
        include_menus: inspection.include_menus,
        max_depth: inspection.max_depth,
      }, target);
      const result = await operateApplicationBound(ctx, call, context);
      return {
        ...result,
        coordinate_source: "accessibility_point_resolution",
        window_bound: true,
        screenshot_revalidated: true,
        normalized_point: { x: target.normalized_x, y: target.normalized_y },
        semantic_point_candidates: target.semantic_point_candidates,
      };
    }
    try {
      const result = await ctx.applications.pointApplication({
        application: observation.target.application,
        expected_process_id: expectedProcessId,
        expected_process_generation: expectedProcessGeneration,
        normalized_x: target.normalized_x,
        normalized_y: target.normalized_y,
        ...(action === "double_click" ? { click_count: 2 } : {}),
        window_id: target.window_binding.window_id,
        bounds: target.window_binding.bounds,
        screenshot_sha256: target.window_binding.screenshot_sha256,
        timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
      }, context);
      return { ...result, semantic_point_candidates: target.semantic_point_candidates };
    } catch (error) {
      throw applicationVisualDispatchError(error, {
        staleDetail: "application window identity, bounds, or screenshot changed immediately before visual dispatch",
        processDetail: "application process changed immediately before visual dispatch",
        unavailableMessage: "application visual input could not be validated before dispatch",
      });
    }
  }
  const inspection = applicationTargetInspection(target);
  const call = {
    application: observation.target.application,
    expected_process_id: expectedProcessId,
    expected_process_generation: expectedProcessGeneration,
    action,
    timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
    include_menus: inspection.include_menus,
    max_depth: inspection.max_depth,
  };
  if (target) call.selector = target.occurrence > 0 ? { ...target.selector, index: target.occurrence } : target.selector;
  if (args.value !== undefined) call.value = requiredStringAllowEmpty(args.value, "value", 4000);
  if (args.value_resource !== undefined) call.value_resource = requiredResource(args.value_resource);
  if (args.key !== undefined) call.key = requiredString(args.key, "key", 100);
  if (action === "set_value" && args.value_resource !== undefined && target?.element?.sensitive !== true) {
    call.retain_value_verification = true;
  }
  return operateApplicationBound(ctx, applyApplicationTargetGeometry(call, target), context);
}

export async function operateApplicationBound(ctx, call, context) {
  try {
    return await ctx.applications.operateApplication(call, context);
  } catch (error) {
    const reason = applicationOperationReason(error);
    if (reason === APPLICATION_OPERATION_REASON.TARGET_GEOMETRY_CHANGED
        || reason === APPLICATION_OPERATION_REASON.PROCESS_IDENTITY_CHANGED) {
      throw staleSnapshot("application target window or geometry changed immediately before Accessibility dispatch");
    }
    if (reason === APPLICATION_OPERATION_REASON.CHECKED_STATE_CHANGED) {
      throw staleSnapshot("application checked-state target changed immediately before Accessibility dispatch");
    }
    if (reason === APPLICATION_OPERATION_REASON.CHECKED_STATE_INPUT_UNAVAILABLE) {
      throw new BridgeError("unavailable", "application checked-state input is unavailable before dispatch", {
        details: { reason: "application_checked_state_input_unavailable" },
      });
    }
    throw error;
  }
}
