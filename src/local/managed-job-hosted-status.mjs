// @ts-check

import { ACTIVE_JOB_STATES } from "./managed-job-terminal.mjs";

/**
 * Project relay-only hosted-turn polling guidance after managed-job ownership checks.
 * @param {{status?: unknown} | null | undefined} status
 * @param {{authority?: {origin?: unknown}}} [context]
 */
export function hostedManagedJobStatus(status, context = {}) {
  if (context?.authority?.origin !== "relay") return {};
  return {
    host_turn_handoff_recommended: ACTIVE_JOB_STATES.has(String(status?.status || "")),
    status_polling_mode: "checkpoint",
  };
}

/** @param {Array<{status?: unknown}>} jobs @param {{authority?: {origin?: unknown}}} [context] */
export function hostedManagedJobListStatus(jobs, context = {}) {
  if (context?.authority?.origin !== "relay") return {};
  return {
    host_turn_handoff_recommended: jobs.some((job) => ACTIVE_JOB_STATES.has(String(job?.status || ""))),
    status_polling_mode: "checkpoint",
  };
}
