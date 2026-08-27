// @ts-check

import { TRANSIENT_PROCESS_RECOVERY_SLOTS, transientProcessWithinRecoveryGrace } from "./managed-job-retention-policy.mjs";

export function recentProcessRecoveryJobs(records, visibleJobs, now = Date.now()) {
  const visibleJobIds = new Set(visibleJobs.map((job) => job.job_id));
  return records
    .filter((record) => !visibleJobIds.has(record.job.job_id)
      && transientProcessWithinRecoveryGrace({
        retention_class: record.retentionClass,
        finished_at: record.job.finished_at,
      }, Number.NaN, now))
    .sort((left, right) => String(right.job?.finished_at || "").localeCompare(String(left.job?.finished_at || ""))
      || String(right.job?.created_at || "").localeCompare(String(left.job?.created_at || ""))
      || String(left.job?.job_id || "").localeCompare(String(right.job?.job_id || "")))
    .slice(0, TRANSIENT_PROCESS_RECOVERY_SLOTS)
    .map((record) => record.job);
}
