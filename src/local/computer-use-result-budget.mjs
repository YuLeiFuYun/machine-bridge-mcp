import { buildContinuation, observationDiff, projectPostObservation } from "./computer-use-observation.mjs";
import { buildRetryGuidance } from "./computer-use-recovery.mjs";
import { normalizeToolResult } from "./tool-result-boundary.mjs";

const WORST_CASE_SNAPSHOT_ID = `cu_${"A".repeat(80)}`;
export const RESULT_BUDGET_OMISSION_REASON = "tool_result_budget";

export function observationResult(observation, imageContent) {
  if (!imageContent.length) return observation;
  return {
    $mcp: {
      content: [{ type: "text", text: JSON.stringify(observation) }, ...imageContent],
      structuredContent: observation,
    },
  };
}

export function assertObservationResultFits(observation, imageContent) {
  const projected = { ...observation, snapshot_id: WORST_CASE_SNAPSHOT_ID };
  normalizeToolResult(observationResult(projected, imageContent));
}

export function isResultLimitExceeded(error) {
  return error?.code === "limit_exceeded";
}

export function omitBrowserScreenshotForResultBudget(observation) {
  if (!observation?.capture || !observation?.capabilities) return;
  observation.capture.screenshot = false;
  observation.capture.screenshot_source = "none";
  observation.capture.screenshot_sha256 = "";
  observation.capture.screenshot_fallback_reason = "browser screenshot omitted because the MCP result budget would be exceeded";
  observation.capture.screenshot_omitted_reason = RESULT_BUDGET_OMISSION_REASON;
  observation.capabilities.cdp_surface_screenshot = false;
  observation.capabilities.snapshot_bound_visual_points = false;
}

export function omitApplicationScreenshotForResultBudget(observation) {
  if (!observation?.capture || !observation?.capabilities) return;
  observation.capture.screenshot = false;
  observation.capture.screenshot_source = "none";
  observation.capture.screenshot_sha256 = "";
  observation.capture.screenshot_error = "application screenshot omitted because the MCP result budget would be exceeded";
  observation.capture.screenshot_omitted_reason = RESULT_BUDGET_OMISSION_REASON;
  observation.capture.coherence = "window_screenshot_then_accessibility_image_omitted_for_result_budget";
  observation.capabilities.snapshot_bound_visual_points = false;
  observation.capabilities.snapshot_bound_semantic_points = false;
}

function actionResult(result, imageContent) {
  if (!imageContent.length) return result;
  return {
    $mcp: {
      content: [{ type: "text", text: JSON.stringify(result) }, ...imageContent],
      structuredContent: result,
    },
  };
}

export function fitActionResultToBudget({
  result, imageContent, beforeObservation, beforePrivateState, postCapture, target,
  effectStatus, expectationRequested, postObservationDetail,
}) {
  try {
    const value = actionResult(result, imageContent);
    normalizeToolResult(value);
    return value;
  } catch (error) {
    if (!isResultLimitExceeded(error)) throw error;
  }

  let candidate = result;
  if (postCapture && imageContent.length) {
    if (postCapture.observation?.surface === "browser") omitBrowserScreenshotForResultBudget(postCapture.observation);
    else if (postCapture.observation?.surface === "application") omitApplicationScreenshotForResultBudget(postCapture.observation);
    postCapture.imageContent = [];
    const observedDiff = observationDiff(beforeObservation, postCapture.observation, beforePrivateState, postCapture.privateState);
    const continuation = buildContinuation(
      beforeObservation, postCapture.observation, target, observedDiff, beforePrivateState, postCapture.privateState,
    );
    const retryGuidance = buildRetryGuidance({
      dispatchStatus: result.dispatch_status, effectStatus, expectationRequested,
      postObservation: postCapture.observation, continuation,
    });
    candidate = {
      ...result,
      observed_diff: observedDiff,
      post_observation: projectPostObservation(postCapture.observation, postObservationDetail),
      continuation,
      retry_guidance: retryGuidance,
      recovery: retryGuidance.message,
      post_screenshot_included: false,
      post_screenshot_omitted_reason: RESULT_BUDGET_OMISSION_REASON,
      result_budget_compacted: true,
    };
    try {
      normalizeToolResult(candidate);
      return candidate;
    } catch (error) {
      if (!isResultLimitExceeded(error)) throw error;
    }
  }

  const compact = compactActionSettlement(candidate);
  normalizeToolResult(compact);
  return compact;
}

function compactActionSettlement(result) {
  const verification = result?.verification && typeof result.verification === "object" && !Array.isArray(result.verification)
    ? { requested: result.verification.requested === true, matched: result.verification.matched === true, reason: boundedText(result.verification.reason, 200) }
    : null;
  const postSnapshotId = typeof result?.post_snapshot_id === "string" ? result.post_snapshot_id : null;
  const retryGuidance = result?.retry_guidance && typeof result.retry_guidance === "object" && !Array.isArray(result.retry_guidance)
    ? {
        same_action_retry_allowed: false,
        disposition: boundedText(result.retry_guidance.disposition, 80),
        reason: boundedText(result.retry_guidance.reason, 200),
        next_step: boundedText(result.retry_guidance.next_step, 80),
        post_snapshot_id: postSnapshotId,
        message: boundedText(result.retry_guidance.message, 500),
      }
    : null;
  return {
    surface: result.surface, action: result.action, snapshot_id: result.snapshot_id,
    dispatch_status: result.dispatch_status, effect_status: result.effect_status, verification,
    post_snapshot_id: postSnapshotId, post_observation_detail: result.post_observation_detail,
    post_screenshot_policy: result.post_screenshot_policy, post_screenshot_included: false,
    ...(result.post_screenshot_omitted_reason === RESULT_BUDGET_OMISSION_REASON ? { post_screenshot_omitted_reason: RESULT_BUDGET_OMISSION_REASON } : {}), post_observation: null,
    continuation: result.continuation && typeof result.continuation === "object" && !Array.isArray(result.continuation)
      ? result.continuation
      : postSnapshotId
        ? { available: true, snapshot_id: postSnapshotId, reobserve_recommended: true, reason: "post_observation_omitted_from_result_budget" }
        : { available: false, snapshot_id: null, reobserve_recommended: true, reason: "post_observation_unavailable" },
    retry_guidance: retryGuidance,
    ...(result.dispatch_error ? { dispatch_error: boundedText(result.dispatch_error, 1000) } : {}),
    ...(result.post_observation_error ? { post_observation_error: boundedText(result.post_observation_error, 1000) } : {}),
    recovery: retryGuidance?.message || "Use the returned post snapshot when available; otherwise observe again before any retry.",
    result_budget_compacted: true,
  };
}

function boundedText(value, maximum) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}
