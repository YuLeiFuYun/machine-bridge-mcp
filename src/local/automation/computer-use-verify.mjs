import { applyApplicationTargetGeometry } from "./computer-use-geometry.mjs";
import { clampInt, requiredStringAllowEmpty } from "./computer-use-contracts.mjs";
import { captureComputerUse } from "./computer-use-capture.mjs";
import { computerActPostObservationTimeoutError, computerActRemainingTimeoutSeconds, computerActVerificationTimeoutProbe, publicPostObservationError, applicationVerificationTarget } from "./computer-use-policies.mjs";
import { applicationProcessChanged, findPostApplicationTarget, findPostApplicationTargetBinding, requiredPrivateApplicationProcessGeneration, requiredPrivateApplicationProcessId, browserExpectationNeedsPostObservation, verifyApplicationExpectation } from "./computer-use-verification.mjs";
import { observationDiff } from "./computer-use-observation.mjs";
import { errorCode } from "../core/errors.mjs";
import { createMonotonicDeadline } from "../core/timing.mjs";

const APPLICATION_VERIFY_POLL_MS = 100;

const APPLICATION_VERIFY_MAX_CAPTURES = 9;

export async function verifyApplicationPostAction(ctx, {
  beforeObservation,
  beforePrivateState,
  target,
  expectation,
  args,
  dispatchResult,
  captureArgs,
  timeoutSeconds,
  operationDeadline = null,
}, context) {
  const deadline = createMonotonicDeadline(timeoutSeconds * 1000, ctx.now);
  const retainedHandle = typeof dispatchResult?._machine_value_verification_handle === "string"
    ? dispatchResult._machine_value_verification_handle : "";
  let postCapture = null;
  let postCaptureError = "";
  let observedDiff = null;
  let captureAttempts = 0;
  let verificationProbe = { requested: true, matched: false, reason: "not_checked" };
  try {
    for (;;) {
      const remainingBeforeCaptureMs = deadline.remainingMs();
      if (remainingBeforeCaptureMs <= 0 || captureAttempts >= APPLICATION_VERIFY_MAX_CAPTURES) {
        if (postCaptureError) verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
        break;
      }
      try { ctx.throwIfCancelled(context); }
      catch (error) {
        postCaptureError = publicPostObservationError("application", error);
        verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
        break;
      }
      let captured = null;
      let captureError = "";
      const configuredCaptureTimeoutSeconds = clampInt(captureArgs.timeout_seconds, 30, 1, 60);
      const operationTimeoutSeconds = computerActRemainingTimeoutSeconds(operationDeadline, configuredCaptureTimeoutSeconds);
      const captureTimeoutSeconds = Math.min(
        Math.max(1, Math.min(configuredCaptureTimeoutSeconds, Math.ceil(remainingBeforeCaptureMs / 1000))),
        operationTimeoutSeconds,
      );
      if (operationTimeoutSeconds <= 0) {
        if (!postCapture) {
          postCaptureError = computerActPostObservationTimeoutError("application");
          verificationProbe = computerActVerificationTimeoutProbe();
        }
        break;
      }
      captureAttempts += 1;
      try { captured = await captureComputerUse(ctx, { ...captureArgs, timeout_seconds: captureTimeoutSeconds }, context, operationDeadline); }
      catch (error) {
        captureError = publicPostObservationError("application", error);
        if (errorCode(error) === "cancelled") {
          postCaptureError = captureError;
          verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
          break;
        }
      }
      if (captured) {
        if (postCapture) ctx.snapshots.discard(postCapture.observation.snapshot_id);
        postCapture = captured;
        postCaptureError = "";
        observedDiff = observationDiff(beforeObservation, captured.observation, beforePrivateState, captured.privateState);
        const processChanged = applicationProcessChanged(beforePrivateState, captured.privateState) === true;
        let valueProbe = null;
        if (expectation.target_value_matches !== undefined) {
          const remainingValueVerificationMs = deadline.remainingMs();
          const operationValueTimeoutSeconds = computerActRemainingTimeoutSeconds(operationDeadline, 60);
          const valueTimeoutSeconds = Math.min(Math.max(1, Math.ceil(remainingValueVerificationMs / 1000)), operationValueTimeoutSeconds);
          valueProbe = processChanged
            ? { available: false, matched: false, reason: "application_process_changed" }
            : remainingValueVerificationMs <= 0 || operationValueTimeoutSeconds <= 0
              ? { available: false, matched: false, reason: "verification_deadline_elapsed" }
              : await verifyApplicationValueExpectation(
                  ctx, captured, target, args, dispatchResult, context, valueTimeoutSeconds,
                );
        }
        verificationProbe = verifyApplicationExpectation(
          {
            after: captured.observation, target, expectation, diff: observedDiff,
            processChanged: applicationProcessChanged(beforePrivateState, captured.privateState),
            findTarget: (verificationTarget) => findPostApplicationTarget(captured.observation, captured.privateState, verificationTarget),
            valueProbe,
          },
        );
        if (verificationProbe.matched === true || processChanged) break;
        if (expectation.target_value_matches !== undefined
            && valueProbe?.reason !== "post_target_binding_unavailable"
            && !(valueProbe?.reason === "value_readback_failed" && args.value !== undefined)) break;
      } else {
        postCaptureError = captureError;
      }
      const remainingMs = Math.min(
        deadline.remainingMs(),
        operationDeadline?.remainingMs?.() ?? Number.POSITIVE_INFINITY,
      );
      if (remainingMs <= 0 || captureAttempts >= APPLICATION_VERIFY_MAX_CAPTURES) {
        if (postCaptureError) verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
        break;
      }
      const retryDelayMs = APPLICATION_VERIFY_POLL_MS * (2 ** Math.min(Math.max(captureAttempts - 1, 0), 3));
      try { await ctx.sleep(Math.min(retryDelayMs, remainingMs)); }
      catch (error) {
        postCaptureError = publicPostObservationError("application", error);
        verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
        break;
      }
    }
  } catch (error) {
    postCaptureError = publicPostObservationError("application", error);
    verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
  } finally {
    discardApplicationValueVerification(ctx, retainedHandle);
  }
  return { postCapture, postCaptureError, observedDiff, verificationProbe };
}

export async function verifyApplicationValueExpectation(ctx, postCapture, target, args, dispatchResult, context, remainingTimeoutSeconds) {
  if (typeof ctx.applications.verifyApplicationValue !== "function") {
    return { available: false, matched: false, reason: "value_readback_backend_unavailable" };
  }
  const verificationTarget = applicationVerificationTarget(target);
  const postTarget = verificationTarget
    ? findPostApplicationTargetBinding(postCapture.observation, postCapture.privateState, verificationTarget)
    : null;
  if (!postTarget) return { available: false, matched: false, reason: "post_target_binding_unavailable" };
  if (postTarget.element?.sensitive === true) return { available: false, matched: false, reason: "sensitive_target" };
  const inspection = postCapture.privateState?.application_inspection || null;
  const selector = postTarget.binding.occurrence > 0
    ? { ...postTarget.binding.selector, index: postTarget.binding.occurrence }
    : postTarget.binding.selector;
  const call = applyApplicationTargetGeometry({
    application: postCapture.observation.target.application,
    expected_process_id: requiredPrivateApplicationProcessId(postCapture.privateState?.application_process_id),
    expected_process_generation: requiredPrivateApplicationProcessGeneration(postCapture.privateState?.application_process_generation),
    selector,
    max_depth: clampInt(inspection?.max_depth, 6, 1, 12),
    include_menus: inspection?.include_menus === true,
    timeout_seconds: Math.min(
      clampInt(args.timeout_seconds, 30, 1, 60),
      clampInt(remainingTimeoutSeconds, 1, 1, 60),
    ),
  }, {
    owner_window_bounds: postTarget.binding.owner_window_bounds || null,
    screen_box: postTarget.binding.screen_box || null,
  });
  const retainedHandle = typeof dispatchResult?._machine_value_verification_handle === "string"
    ? dispatchResult._machine_value_verification_handle : "";
  if (retainedHandle) call.value_verification_handle = retainedHandle;
  else if (args.value !== undefined) call.value = requiredStringAllowEmpty(args.value, "value", 4000);
  else if (args.value_resource !== undefined) {
    return { available: false, matched: false, reason: "exact_dispatched_resource_value_unavailable" };
  }
  try {
    const result = await ctx.applications.verifyApplicationValue(call, context);
    if (result?.supported !== true) return { available: false, matched: false, reason: String(result?.reason || "value_readback_unsupported") };
    return { available: true, matched: result.matched === true, reason: "accessibility_value_compared" };
  } catch {
    return { available: false, matched: false, reason: "value_readback_failed" };
  }
}

export function discardApplicationValueVerification(ctx, handle) {
  if (!handle || typeof ctx.applications.discardApplicationValueVerification !== "function") return;
  try { ctx.applications.discardApplicationValueVerification(handle); }
  catch { /* TTL remains the fallback if best-effort cleanup cannot run. */ }
}

export async function verifyBrowserExpectation(ctx, observation, target, expectation, timeoutSeconds, context) {
  const waitArgs = { tab_id: observation.target.tab_id, timeout_seconds: timeoutSeconds };
  let hasWaitCondition = false;
  const postCheckPending = browserExpectationNeedsPostObservation(expectation);
  if (expectation.url_contains) { waitArgs.url_contains = expectation.url_contains; hasWaitCondition = true; }
  if (expectation.text) { waitArgs.text = expectation.text; hasWaitCondition = true; }
  if (expectation.load_state) { waitArgs.load_state = expectation.load_state; hasWaitCondition = true; }
  if (expectation.target_state) {
    if (!target || target.kind !== "ref") return { requested: true, matched: false, reason: "target_state_requires_ref_target" };
    waitArgs.frame_id = target.frame_id;
    waitArgs.selector = { ref: target.ref };
    waitArgs.state = expectation.target_state;
    hasWaitCondition = true;
  }
  if (!hasWaitCondition) {
    return postCheckPending
      ? { requested: true, matched: false, wait_matched: true, post_check_pending: true, reason: "post_conditions_pending" }
      : { requested: true, matched: true, wait_matched: true, reason: "no_wait_conditions" };
  }
  try {
    await ctx.browser.wait(waitArgs, context);
    return postCheckPending
      ? { requested: true, matched: false, wait_matched: true, post_check_pending: true, reason: "post_conditions_pending" }
      : { requested: true, matched: true, wait_matched: true, reason: "wait_conditions_satisfied" };
  } catch (error) {
    return {
      requested: true,
      matched: false,
      wait_matched: false,
      post_check_pending: postCheckPending,
      reason: "wait_conditions_not_observed",
      error_class: errorCode(error),
    };
  }
}
