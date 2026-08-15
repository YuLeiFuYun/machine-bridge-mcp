import assert from "node:assert/strict";
import { BridgeError } from "../src/local/errors.mjs";
import {
  RESULT_BUDGET_OMISSION_REASON,
  assertObservationResultFits,
  fitActionResultToBudget,
  isResultLimitExceeded,
  observationResult,
  omitApplicationScreenshotForResultBudget,
  omitBrowserScreenshotForResultBudget,
} from "../src/local/computer-use-result-budget.mjs";

const tinyImage = { type: "image", data: "AA==", mimeType: "image/png" };
const browser = {
  snapshot_id: "",
  surface: "browser",
  target: { tab_id: 1, url: "https://example.test", title: "Example" },
  capture: { screenshot: true, screenshot_source: "cdp_surface", screenshot_sha256: "a".repeat(64) },
  capabilities: { cdp_surface_screenshot: true, snapshot_bound_visual_points: true },
  semantic: { kind: "dom", elements: [] },
};

assert.strictEqual(observationResult(browser, []), browser);
const wrapped = observationResult(browser, [tinyImage]);
assert.equal(wrapped.$mcp.content.length, 2);
assert.strictEqual(wrapped.$mcp.structuredContent, browser);
assert.doesNotThrow(() => assertObservationResultFits(browser, [tinyImage]));
assert.throws(
  () => assertObservationResultFits(browser, [{ ...tinyImage, data: "A".repeat(8 * 1024 * 1024) }]),
  (error) => error instanceof BridgeError && isResultLimitExceeded(error),
);
assert.equal(isResultLimitExceeded({ code: "limit_exceeded" }), true);
assert.equal(isResultLimitExceeded({ code: "execution_failed" }), false);
assert.equal(isResultLimitExceeded(null), false);

assert.doesNotThrow(() => omitBrowserScreenshotForResultBudget(null));
const browserOmitted = structuredClone(browser);
omitBrowserScreenshotForResultBudget(browserOmitted);
assert.equal(browserOmitted.capture.screenshot, false);
assert.equal(browserOmitted.capture.screenshot_source, "none");
assert.equal(browserOmitted.capture.screenshot_sha256, "");
assert.equal(browserOmitted.capture.screenshot_omitted_reason, RESULT_BUDGET_OMISSION_REASON);
assert.equal(browserOmitted.capabilities.cdp_surface_screenshot, false);
assert.equal(browserOmitted.capabilities.snapshot_bound_visual_points, false);

assert.doesNotThrow(() => omitApplicationScreenshotForResultBudget({ capture: {}, capabilities: null }));
const applicationOmitted = {
  capture: { screenshot: true, screenshot_source: "macos_window", screenshot_sha256: "b".repeat(64) },
  capabilities: { snapshot_bound_visual_points: true, snapshot_bound_semantic_points: true },
};
omitApplicationScreenshotForResultBudget(applicationOmitted);
assert.equal(applicationOmitted.capture.screenshot, false);
assert.equal(applicationOmitted.capture.screenshot_source, "none");
assert.equal(applicationOmitted.capture.screenshot_sha256, "");
assert.equal(applicationOmitted.capture.screenshot_omitted_reason, RESULT_BUDGET_OMISSION_REASON);
assert.match(applicationOmitted.capture.screenshot_error, /result budget/);
assert.equal(applicationOmitted.capabilities.snapshot_bound_visual_points, false);
assert.equal(applicationOmitted.capabilities.snapshot_bound_semantic_points, false);

const baseResult = {
  surface: "application",
  action: "focus",
  snapshot_id: "cu_before",
  dispatch_status: "completed",
  effect_status: "confirmed",
  verification: { requested: true, matched: true, reason: "confirmed" },
  post_snapshot_id: "cu_after",
  post_observation_detail: "summary",
  post_screenshot_policy: "never",
  post_screenshot_included: false,
  continuation: null,
  retry_guidance: {
    same_action_retry_allowed: false,
    disposition: "do_not_retry",
    reason: "effect_confirmed",
    next_step: "continue_from_post_snapshot",
    post_snapshot_id: "cu_after",
    message: "done",
  },
};

assert.strictEqual(fitActionResultToBudget({ result: baseResult, imageContent: [] }), baseResult);
const smallImageResult = fitActionResultToBudget({ result: baseResult, imageContent: [tinyImage] });
assert.equal(smallImageResult.$mcp.content.length, 2);

const compactWithoutImage = fitActionResultToBudget({
  result: { ...baseResult, oversized: "x".repeat(8 * 1024 * 1024) },
  imageContent: [],
});
assert.equal(compactWithoutImage.result_budget_compacted, true);
assert.equal(compactWithoutImage.post_screenshot_included, false);
assert.equal("post_screenshot_omitted_reason" in compactWithoutImage, false, "semantic-only compaction invented a screenshot omission");
assert.equal(compactWithoutImage.continuation.available, true);
assert.equal(compactWithoutImage.continuation.snapshot_id, "cu_after");
assert.equal(compactWithoutImage.retry_guidance.same_action_retry_allowed, false);

const compactWithBudgetOmission = fitActionResultToBudget({
  result: {
    ...baseResult,
    post_screenshot_omitted_reason: RESULT_BUDGET_OMISSION_REASON,
    continuation: { available: true, snapshot_id: "cu_after", reobserve_recommended: false },
    dispatch_error: "d".repeat(2000),
    post_observation_error: "p".repeat(2000),
    oversized: "y".repeat(8 * 1024 * 1024),
  },
  imageContent: [],
});
assert.equal(compactWithBudgetOmission.post_screenshot_omitted_reason, RESULT_BUDGET_OMISSION_REASON);
assert.equal(compactWithBudgetOmission.continuation.available, true);
assert.equal(compactWithBudgetOmission.dispatch_error.length, 1000);
assert.equal(compactWithBudgetOmission.post_observation_error.length, 1000);

const compactNoSnapshot = fitActionResultToBudget({
  result: {
    surface: "browser", action: "click", snapshot_id: "cu_before", dispatch_status: "unknown", effect_status: "unknown",
    verification: null, post_snapshot_id: null, post_observation_detail: "summary", post_screenshot_policy: "never",
    post_screenshot_included: false, continuation: null, retry_guidance: null, oversized: "z".repeat(8 * 1024 * 1024),
  },
  imageContent: [],
});
assert.equal(compactNoSnapshot.continuation.available, false);
assert.equal(compactNoSnapshot.retry_guidance, null);
assert.match(compactNoSnapshot.recovery, /post snapshot|observe again/i);

console.log("computer use result budget test ok");
