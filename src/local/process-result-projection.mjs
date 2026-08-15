// @ts-check

import { MCP_TEXT_PROJECTION_KEY } from "../shared/result-projection.mjs";
import { BridgeError } from "./errors.mjs";

/** @param {Record<string, any>} value */
export function publicProcessToolResult(value) {
  const truncated = Number(value.stdout_truncated_bytes) + Number(value.stderr_truncated_bytes);
  const continuation = value.output_session_id
    ? ` Continue with read_process session ${value.output_session_id}.`
    : truncated > 0 ? " Additional output could not be retained because the process-session limit was reached." : "";
  const summary = `Process exited with code ${value.code}.${truncated > 0 ? ` ${truncated} inline byte(s) omitted.` : ""}${continuation}`;
  return { ...value, [MCP_TEXT_PROJECTION_KEY]: summary };
}

/** @param {string} trigger @param {Record<string, unknown>} [details] */
export function processOutcomeUnknownAfterSpawn(trigger, details = {}) {
  const terminationRequested = trigger === "cancelled" || trigger === "timeout" || trigger === "resource_binding";
  return new BridgeError(
    "execution_failed",
    "command execution may have partially completed; the outcome is unknown. Inspect command effects before retrying.",
    {
      expose: true,
      retryable: false,
      details: {
        ...details,
        reason: "process_outcome_unknown_after_spawn",
        trigger: String(trigger || "unknown").slice(0, 64),
        side_effects_started: "unknown",
        termination_requested: terminationRequested,
        effect_settlement: terminationRequested ? "pending" : "unknown",
      },
    },
  );
}

/** @param {Record<string, any>} result */
export function processFailureMessage(result) {
  const source = String(result.stderr || result.stdout || `process exited ${result.code}`)
    .replace(/[\r\n]+/g, " ").trim().slice(0, 2000);
  const suffix = result.output_session_id
    ? `; additional output is available through read_process session ${result.output_session_id}`
    : result.stdout_truncated_bytes > 0 || result.stderr_truncated_bytes > 0
      ? "; additional output was truncated"
      : "";
  return `${source || `process exited ${result.code}`}${suffix}`;
}
