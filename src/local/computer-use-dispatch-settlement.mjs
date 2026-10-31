// @ts-check

import { BridgeError, errorCode } from "./errors.mjs";

export const APPLICATION_OPERATION_REASON = Object.freeze({
  PROCESS_IDENTITY_CHANGED: "application_process_identity_changed",
  VISUAL_SNAPSHOT_CHANGED: "application_visual_snapshot_changed",
  VISUAL_PREFLIGHT_UNAVAILABLE: "application_visual_preflight_unavailable",
  INPUT_PREFLIGHT_UNAVAILABLE: "application_input_preflight_unavailable",
  INPUT_OUTCOME_UNKNOWN: "application_input_outcome_unknown",
  TARGET_GEOMETRY_CHANGED: "application_target_geometry_changed",
  CHECKED_STATE_CHANGED: "application_checked_state_changed",
  CHECKED_STATE_INPUT_UNAVAILABLE: "application_checked_state_input_unavailable",
});

/** @param {unknown} error */
export function applicationOperationReason(error) {
  if (!(error instanceof BridgeError)) return "";
  return typeof error.details?.reason === "string" ? error.details.reason : "";
}

/** @param {string} message @param {unknown} [cause] */
export function applicationProcessIdentityChanged(message, cause = null) {
  return applicationOperationError("conflict", APPLICATION_OPERATION_REASON.PROCESS_IDENTITY_CHANGED, message, cause, false);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationVisualSnapshotChanged(message, cause = null) {
  return applicationOperationError("conflict", APPLICATION_OPERATION_REASON.VISUAL_SNAPSHOT_CHANGED, message, cause, false);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationVisualPreflightUnavailable(message, cause = null) {
  return applicationOperationError("unavailable", APPLICATION_OPERATION_REASON.VISUAL_PREFLIGHT_UNAVAILABLE, message, cause, true);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationInputPreflightUnavailable(message, cause = null) {
  return applicationOperationError("unavailable", APPLICATION_OPERATION_REASON.INPUT_PREFLIGHT_UNAVAILABLE, message, cause, true);
}

/**
 * @param {string} message
 * @param {unknown} [cause]
 * @param {Record<string, unknown>} [details]
 */
export function applicationInputOutcomeUnknown(message, cause = null, details = {}) {
  return applicationOperationError("execution_failed", APPLICATION_OPERATION_REASON.INPUT_OUTCOME_UNKNOWN, message, cause, false, details);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationTargetGeometryChanged(message, cause = null) {
  return applicationOperationError("conflict", APPLICATION_OPERATION_REASON.TARGET_GEOMETRY_CHANGED, message, cause, false);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationCheckedStateChanged(message, cause = null) {
  return applicationOperationError("conflict", APPLICATION_OPERATION_REASON.CHECKED_STATE_CHANGED, message, cause, false);
}

/** @param {string} message @param {unknown} [cause] */
export function applicationCheckedStateInputUnavailable(message, cause = null) {
  return applicationOperationError("unavailable", APPLICATION_OPERATION_REASON.CHECKED_STATE_INPUT_UNAVAILABLE, message, cause, true);
}

/**
 * Convert fixed JXA helper wire messages at the subprocess boundary. Callers above this boundary
 * consume stable reasons and never infer execution semantics from human-readable text.
 * @param {string} message
 * @returns {BridgeError | null}
 */
export function applicationAutomationBoundaryError(message) {
  if (message === "application process changed before operation"
      || message === "application process generation changed before operation") {
    return applicationProcessIdentityChanged(message);
  }
  if (message === "application target window changed before dispatch"
      || message === "application target geometry changed before dispatch") {
    return applicationTargetGeometryChanged(message);
  }
  if (message === "application target checked state is unavailable before dispatch"
      || message === "application check target is not an Accessibility checkbox or radio button"
      || message === "application uncheck target is not an Accessibility checkbox") {
    return applicationCheckedStateChanged(message);
  }
  if (message === "application target does not expose AXPress before checked-state dispatch") {
    return applicationCheckedStateInputUnavailable(message);
  }
  return null;
}

/**
 * @param {string} code
 * @param {string} reason
 * @param {string} message
 * @param {unknown} cause
 * @param {boolean} retryable
 * @param {Record<string, unknown>} [details]
 */
function applicationOperationError(code, reason, message, cause, retryable, details = {}) {
  return new BridgeError(code, message, {
    retryable,
    cause: cause instanceof Error ? cause : undefined,
    details: { reason, ...details },
  });
}

const UNKNOWN_MUTATION_ERROR_PREFIXES = Object.freeze([
  "browser mutation request may have been dispatched;",
  "browser mutation may have completed;",
  "browser action may have been dispatched;",
  "trusted browser input may have been partially dispatched;",
  "browser tab mutation may have been dispatched;",
  "browser screenshot temporary tab activation may have been dispatched;",
  "browser screenshot restoration may have been dispatched;",
]);

/**
 * @template T
 * @param {string} surface
 * @param {() => Promise<T>} dispatch
 */
export async function settleComputerUseDispatch(surface, dispatch) {
  try {
    return { dispatchStatus: "completed", dispatchResult: await dispatch(), dispatchError: "" };
  } catch (error) {
    if (!isUnknownOutcomeError(surface, error)) throw error;
    return { dispatchStatus: "unknown", dispatchResult: null, dispatchError: publicUnknownOutcomeError(surface, error) };
  }
}

/** @param {string} surface @param {unknown} error */
function isUnknownOutcomeError(surface, error) {
  if (surface === "application") {
    return applicationOperationReason(error) === APPLICATION_OPERATION_REASON.INPUT_OUTCOME_UNKNOWN;
  }
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return UNKNOWN_MUTATION_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/** @param {string} surface @param {unknown} error */
function publicUnknownOutcomeError(surface, error) {
  const normalizedSurface = surface === "application" ? "application" : "browser";
  const inspection = normalizedSurface === "application" ? "Inspect the application" : "Inspect browser state";
  return `${normalizedSurface} mutation may have been dispatched; the outcome is unknown. ${inspection} before retrying. (error_class=${errorCode(error)})`;
}
