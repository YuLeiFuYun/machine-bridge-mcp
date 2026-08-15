export function buildRetryGuidance({
  dispatchStatus,
  effectStatus,
  expectationRequested,
  postObservation,
  continuation,
}) {
  const postSnapshotId = postObservation?.snapshot_id || null;
  const mappedPostTargetRef = continuation?.surface === "application"
    && continuation?.target_identity_continues === true
    && typeof continuation?.mapped_post_target_ref === "string"
    && continuation.mapped_post_target_ref
    ? continuation.mapped_post_target_ref
    : "";
  const base = {
    same_action_retry_allowed: false,
    post_snapshot_id: postSnapshotId,
    ...(mappedPostTargetRef ? {
      mapped_post_target_ref: mappedPostTargetRef,
      mapped_ref_for_replanning_only: true,
    } : {}),
  };

  if (effectStatus === "confirmed") {
    return {
      ...base,
      disposition: "do_not_retry",
      reason: "effect_confirmed",
      next_step: nextObservationStep(postObservation, continuation),
      message: "The requested effect was confirmed. Do not replay the same action.",
    };
  }

  if (dispatchStatus === "completed" && expectationRequested !== true) {
    return {
      ...base,
      disposition: "do_not_retry",
      reason: "dispatch_completed_without_effect_contract",
      next_step: nextObservationStep(postObservation, continuation),
      message: "Dispatch completed without an explicit effect contract. Do not replay the same action automatically; continue from observed state.",
    };
  }

  if (!postObservation) {
    return {
      ...base,
      disposition: "reobserve_before_retry",
      reason: dispatchStatus === "unknown" ? "dispatch_unknown_and_post_state_unavailable" : "post_state_unavailable",
      next_step: "computer_observe",
      message: "Post-state is unavailable. Re-observe before deciding whether any retry is appropriate.",
    };
  }

  if (continuation?.reobserve_recommended === true) {
    return {
      ...base,
      disposition: "reobserve_before_retry",
      reason: continuation.reason || "post_state_requires_fresh_observation",
      next_step: "computer_observe",
      message: "The post-state cannot be safely continued from the previous ref namespace. Re-observe before deciding whether any retry is appropriate.",
    };
  }

  return {
    ...base,
    disposition: "use_post_snapshot",
    reason: dispatchStatus === "unknown"
      ? "dispatch_unknown_inspect_post_state_before_any_retry"
      : effectStatus === "not_observed"
        ? "requested_effect_not_observed_use_post_state_to_replan"
        : "effect_unconfirmed_use_post_state_before_any_retry",
    next_step: "continue_from_post_snapshot",
    message: dispatchStatus === "unknown"
      ? "Dispatch outcome is ambiguous. Inspect and continue from the post snapshot; do not replay the same action automatically."
      : "The requested effect was not confirmed. Use the post snapshot to replan before considering any retry.",
  };
}

function nextObservationStep(postObservation, continuation) {
  if (!postObservation || continuation?.reobserve_recommended === true) return "computer_observe";
  return "continue_from_post_snapshot";
}
