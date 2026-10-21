// Effect evaluation consumes explicit evidence; it performs no dispatch, I/O or retries.
import { applicationVerificationTarget } from "./computer-use-expectation.mjs";

export function combineBrowserPostChecks(probe, diff, expectation, before, after, target, sameTargetIdentity) {
  let matched = probe.post_check_pending === true ? probe.wait_matched === true : probe.matched === true;
  const checks = [];
  if (expectation.url_changed !== undefined) {
    const ok = diff?.url_changed === expectation.url_changed;
    matched = matched && ok;
    checks.push({ condition: "url_changed", matched: ok, evidence_source: "browser_tab_state" });
  }
  if (expectation.semantic_change !== undefined) {
    const observed = diff?.semantic_changed;
    const ok = typeof observed === "boolean" && observed === expectation.semantic_change;
    matched = matched && ok;
    checks.push({ condition: "semantic_change", matched: ok, evidence_source: "browser_semantic",
      ...(typeof observed === "boolean" ? {} : { inconclusive: true, reason: "semantic_coverage_incomplete" }) });
  }
  if (expectation.visual_change !== undefined) {
    const observed = diff?.screenshot_changed;
    const ok = typeof observed === "boolean" && observed === expectation.visual_change;
    matched = matched && ok;
    checks.push({ condition: "visual_change", matched: ok, observed: typeof observed === "boolean" ? observed : null, evidence_source: "screenshot" });
  }
  if (expectation.target_state) {
    for (const check of browserPostTargetStateChecks(before, after, target, expectation.target_state, sameTargetIdentity)) {
      if (check.inconclusive === true) matched = false;
      else matched = matched && check.matched === true;
      checks.push({ evidence_source: "browser_semantic", ...check });
    }
  }
  const definitiveFailure = probe.wait_matched === false || checks.some((check) => check.matched === false && check.inconclusive !== true);
  const inconclusive = !definitiveFailure && checks.some((check) => check.inconclusive === true);
  return {
    ...probe,
    matched: matched && !inconclusive,
    inconclusive,
    post_check_pending: false,
    reason: matched && !inconclusive
      ? "post_conditions_satisfied"
      : inconclusive
        ? "post_conditions_inconclusive"
        : probe.wait_matched === false ? probe.reason : "post_conditions_not_observed",
    post_checks: checks,
  };
}

export function browserExpectationNeedsPostObservation(expectation) {
  return expectation?.url_changed !== undefined
    || expectation?.semantic_change !== undefined
    || expectation?.visual_change !== undefined
    || Boolean(expectation?.target_state);
}

function browserPostTargetStateChecks(before, after, target, state, sameTargetIdentity) {
  if (!target || target.kind !== "ref") return [{ condition: "target_state", matched: false, reason: "target_state_requires_ref_target" }];
  const frameEpochStatus = browserTargetFrameEpochStatus(before, after, target);
  if (frameEpochStatus === "unknown") return [{
    condition: "target_state",
    matched: false,
    observed: null,
    inconclusive: true,
    reason: "post_target_frame_coverage_incomplete",
  }];
  if (frameEpochStatus === "changed") {
    const goneMatches = state === "detached" || state === "hidden";
    return [{
      condition: "target_state",
      matched: goneMatches,
      observed: goneMatches ? state : null,
      reason: "target_frame_epoch_changed",
    }];
  }
  const frame = (after.semantic?.frames || []).find((candidate) => candidate?.frame_id === target.frame_id) || null;
  const complete = after.semantic?.frames_truncated === false && Boolean(frame) && frame.truncated === false;
  const element = (frame?.elements || []).find((candidate) => candidate?.ref === target.ref) || null;
  if (!element) {
    if (!complete) return [{
      condition: "target_state",
      matched: false,
      observed: null,
      inconclusive: true,
      reason: "post_target_coverage_incomplete",
    }];
    const absentMatches = state === "detached" || state === "hidden";
    return [{ condition: "target_state", matched: absentMatches, observed: absentMatches ? state : "detached" }];
  }
  const identityMatched = sameTargetIdentity(target.element, element);
  const checks = [{ condition: "target_identity", matched: identityMatched }];
  if (!identityMatched) {
    checks.push({ condition: "target_state", matched: false, observed: null, reason: "target_semantic_identity_changed" });
    return checks;
  }
  const observed = browserObservedTargetState(element, state);
  if (observed === null) {
    checks.push({ condition: "target_state", matched: false, observed: null, inconclusive: true, reason: "target_state_unavailable" });
    return checks;
  }
  checks.push({ condition: "target_state", matched: observed, observed });
  return checks;
}

function browserTargetFrameEpochStatus(before, after, target) {
  if (!Number.isInteger(target?.frame_id)) return "unknown";
  const beforeFrame = (before.semantic?.frames || []).find((frame) => frame?.frame_id === target.frame_id) || null;
  const afterFrame = (after.semantic?.frames || []).find((frame) => frame?.frame_id === target.frame_id) || null;
  if (!beforeFrame) return "unknown";
  if (!afterFrame) return after.semantic?.frames_truncated === true ? "unknown" : "changed";
  const beforeEpoch = typeof beforeFrame.document?.epoch === "string" ? beforeFrame.document.epoch : "";
  const afterEpoch = typeof afterFrame.document?.epoch === "string" ? afterFrame.document.epoch : "";
  const beforeUrl = typeof beforeFrame.document?.url === "string" ? beforeFrame.document.url : "";
  const afterUrl = typeof afterFrame.document?.url === "string" ? afterFrame.document.url : "";
  if (!beforeEpoch || !afterEpoch || !beforeUrl || !afterUrl) return "unknown";
  return beforeEpoch === afterEpoch && beforeUrl === afterUrl ? "same" : "changed";
}

function browserObservedTargetState(element, state) {
  if (state === "attached") return true;
  if (state === "detached") return false;
  if (state === "visible") return typeof element?.visible === "boolean" ? element.visible : null;
  if (state === "hidden") return typeof element?.visible === "boolean" ? !element.visible : null;
  if (state === "enabled") return typeof element?.enabled === "boolean" ? element.enabled : null;
  if (state === "editable") return typeof element?.editable === "boolean" ? element.editable : null;
  if (state === "checked") return typeof element?.checked === "boolean" ? element.checked : null;
  if (state === "unchecked") return typeof element?.checked === "boolean" ? !element.checked : null;
  return null;
}

function applicationPostTargetCheck(condition, match, expected, field, coverageComplete) {
  if (!match && !coverageComplete) return {
    condition, matched: false, observed: null, inconclusive: true, reason: "post_target_coverage_incomplete",
  };
  const observed = field ? match?.[field] : Boolean(match);
  return { condition, matched: field ? Boolean(match) && observed === expected : observed === expected };
}

function applicationVerificationEvidenceSource(condition) {
  if (condition === "process_identity") return "application_process";
  if (condition === "frontmost") return "application_workspace";
  if (condition === "visual_change") return "screenshot";
  return "application_accessibility";
}

export function verifyApplicationExpectation({ after, target, expectation, diff, processChanged, findTarget, valueProbe = null }) {
  const checks = [];
  if (processChanged === true) {
    checks.push({ condition: "process_identity", matched: false });
  }
  if (expectation.frontmost !== undefined) checks.push({
    condition: "frontmost",
    matched: after.target.frontmost === expectation.frontmost,
  });
  if (expectation.semantic_change !== undefined) checks.push({
    condition: "semantic_change",
    matched: typeof diff?.semantic_changed === "boolean" && diff.semantic_changed === expectation.semantic_change,
    ...(typeof diff?.semantic_changed === "boolean" ? {} : { inconclusive: true, reason: "semantic_coverage_incomplete" }),
  });
  if (expectation.visual_change !== undefined) {
    const observed = diff?.screenshot_changed;
    checks.push({ condition: "visual_change", matched: typeof observed === "boolean" && observed === expectation.visual_change, observed: typeof observed === "boolean" ? observed : null });
  }
  const verificationTarget = applicationVerificationTarget(target);
  if (verificationTarget) {
    const match = findTarget(verificationTarget);
    const targetCoverageComplete = after.semantic?.truncated === false;
    if (expectation.target_exists !== undefined) checks.push(applicationPostTargetCheck(
      "target_exists", match, expectation.target_exists, null, targetCoverageComplete));
    if (expectation.target_enabled !== undefined) checks.push(applicationPostTargetCheck(
      "target_enabled", match, expectation.target_enabled, "enabled", targetCoverageComplete));
    if (expectation.target_focused !== undefined) checks.push(applicationPostTargetCheck(
      "target_focused", match, expectation.target_focused, "focused", targetCoverageComplete));
    if (expectation.target_checked !== undefined) checks.push(applicationPostTargetCheck(
      "target_checked", match, expectation.target_checked, "checked", targetCoverageComplete));
    if (expectation.target_selected !== undefined) checks.push(applicationPostTargetCheck(
      "target_selected", match, expectation.target_selected, "selected", targetCoverageComplete));
    if (expectation.target_expanded !== undefined) checks.push(applicationPostTargetCheck(
      "target_expanded", match, expectation.target_expanded, "expanded", targetCoverageComplete));
    if (expectation.target_value_matches !== undefined) {
      const available = valueProbe?.available === true;
      checks.push({
        condition: "target_value_matches",
        matched: available && valueProbe.matched === expectation.target_value_matches,
        observed: available ? valueProbe.matched === true : null,
        ...(available ? {} : { inconclusive: true, reason: String(valueProbe?.reason || "value_readback_unavailable") }),
      });
    }
  }
  const postChecks = checks.map((check) => ({ evidence_source: applicationVerificationEvidenceSource(check.condition), ...check }));
  const definitiveFailure = postChecks.some((check) => check.matched === false && check.inconclusive !== true);
  const inconclusive = !definitiveFailure && postChecks.some((check) => check.inconclusive === true);
  return {
    requested: true,
    matched: postChecks.length > 0 && postChecks.every((check) => check.matched),
    inconclusive,
    reason: postChecks.every((check) => check.matched)
      ? "post_conditions_satisfied"
      : inconclusive
        ? "post_conditions_inconclusive"
        : "post_conditions_not_observed",
    post_checks: postChecks,
  };
}

export function classifyEffectStatus({ dispatchStatus, expectation, verificationProbe, postCapture }) {
  if (!expectation) return "unknown";
  if (verificationProbe.matched === true) return "confirmed";
  if (verificationProbe.inconclusive === true) return "unknown";
  if (dispatchStatus === "unknown" || !postCapture) return "unknown";
  return "not_observed";
}
