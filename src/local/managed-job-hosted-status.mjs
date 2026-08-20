// @ts-check

import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
import { ACTIVE_JOB_STATES } from "./managed-job-terminal.mjs";

/**
 * Project relay-only hosted-turn polling guidance after managed-job ownership checks.
 * @param {{status?: unknown} | null | undefined} status
 * @param {{authority?: {origin?: unknown}}} [context]
 */
export function hostedManagedJobStatus(status, context = {}) {
  if (context?.authority?.origin !== "relay") return {};
  const active = ACTIVE_JOB_STATES.has(String(status?.status || ""));
  return {
    host_turn_handoff_recommended: false,
    status_polling_mode: active ? "bounded_followup" : "terminal",
    tool_schema_generation: Number(serverMetadata.toolSchemaGeneration),
    host_turn_deadline_observable: false,
    managed_job_detached_from_mcp_response: true,
  };
}

/** @param {Array<{status?: unknown}>} _jobs @param {{authority?: {origin?: unknown}}} [context] */
export function hostedManagedJobListStatus(_jobs, context = {}) {
  if (context?.authority?.origin !== "relay") return {};
  return {
    host_turn_handoff_recommended: false,
    status_polling_mode: "inventory",
    tool_schema_generation: Number(serverMetadata.toolSchemaGeneration),
    host_turn_deadline_observable: false,
  };
}
