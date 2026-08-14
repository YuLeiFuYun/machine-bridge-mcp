// @ts-check
import { BridgeError } from "./errors.mjs";
import { processOutcomeUnknownAfterSpawn } from "./process-result-projection.mjs";

/** @param {unknown} error @param {boolean} nonReplayable */
export function processPreSpawnFailure(error, nonReplayable) {
  if (!nonReplayable || error instanceof BridgeError) return error;
  return new BridgeError("execution_failed", boundedMessage(error), {
    cause: error instanceof Error ? error : undefined,
    retryable: false,
    details: { reason: "process_failed_before_spawn" },
  });
}

/** @param {boolean} nonReplayable @param {AbortSignal | undefined} signal */
export function processCancellationFailure(nonReplayable, signal) {
  const reason = signal?.reason;
  const code = reason instanceof BridgeError && reason.code === "timeout" ? "timeout" : "cancelled";
  if (nonReplayable) return processOutcomeUnknownAfterSpawn(code);
  return new BridgeError(code, reason instanceof Error ? reason.message : "tool call cancelled", {
    retryable: false,
    cause: reason instanceof Error ? reason : undefined,
    details: { side_effects_started: true, termination_requested: true, effect_settlement: "pending" },
  });
}

/** @param {boolean} nonReplayable @param {number} timeoutMs */
export function processTimeoutFailure(nonReplayable, timeoutMs) {
  if (nonReplayable) return processOutcomeUnknownAfterSpawn("timeout");
  return new BridgeError("timeout", `command timed out after ${timeoutMs}ms`, {
    retryable: false,
    details: { side_effects_started: true, termination_requested: true, effect_settlement: "pending" },
  });
}

/** @param {boolean} nonReplayable @param {string} trigger @param {unknown} fallback @param {Record<string, unknown>} [details] */
export function processPostSpawnFailure(nonReplayable, trigger, fallback, details = {}) {
  return nonReplayable ? processOutcomeUnknownAfterSpawn(trigger, details) : fallback;
}

/** @param {boolean} nonReplayable @param {unknown} error @param {boolean} started */
export function processChildErrorFailure(nonReplayable, error, started) {
  if (!nonReplayable) return error;
  if (started) return processOutcomeUnknownAfterSpawn("process_error");
  return new BridgeError("execution_failed", boundedMessage(error), {
    cause: error instanceof Error ? error : undefined,
    retryable: false,
    details: { reason: "process_failed_before_spawn" },
  });
}

/** @param {unknown} error */
function boundedMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "process failed before spawn");
  return message.replace(/[\r\n]+/g, " ").slice(0, 4096) || "process failed before spawn";
}
