import { BridgeError, errorCode } from "./errors.mjs";

function computerUseRemainingTimeoutSeconds(deadline, maximumSeconds) {
  if (!deadline || typeof deadline.remainingMs !== "function") return maximumSeconds;
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) return 0;
  return Math.max(0, Math.min(maximumSeconds, Math.floor(remainingMs / 1000)));
}

export function computerActRemainingTimeoutSeconds(deadline, maximumSeconds) {
  return computerUseRemainingTimeoutSeconds(deadline, maximumSeconds);
}

export function requiredComputerActRemainingTimeoutSeconds(deadline, maximumSeconds) {
  const remainingSeconds = computerUseRemainingTimeoutSeconds(deadline, maximumSeconds);
  if (remainingSeconds > 0) return remainingSeconds;
  throw new BridgeError("timeout", "computer action timed out before mutation dispatch", {
    details: { reason: "computer_action_deadline_exhausted", side_effects_started: false },
  });
}

export function requiredComputerObserveRemainingTimeoutSeconds(deadline, maximumSeconds) {
  const remainingSeconds = computerUseRemainingTimeoutSeconds(deadline, maximumSeconds);
  if (remainingSeconds > 0) return remainingSeconds;
  throw new BridgeError("timeout", "computer observation timed out before semantic capture completed", {
    details: { reason: "computer_observe_deadline_exhausted", side_effects_started: false },
  });
}

export function computerActVerificationTimeoutProbe() {
  return {
    requested: true,
    matched: false,
    inconclusive: true,
    reason: "post_conditions_inconclusive",
    post_checks: [],
  };
}

export function publicPostObservationError(surface, error) {
  const normalizedSurface = surface === "application" ? "application" : "browser";
  return `${normalizedSurface} post observation unavailable (error_class=${errorCode(error)})`;
}

export function computerActPostObservationTimeoutError(surface) {
  return publicPostObservationError(
    surface,
    new BridgeError("timeout", "computer action end-to-end timeout elapsed before post observation"),
  );
}
