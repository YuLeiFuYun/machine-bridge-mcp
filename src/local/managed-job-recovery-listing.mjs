// @ts-check
import { TRANSIENT_PROCESS_RECOVERY_SLOTS, transientProcessWithinRecoveryGrace } from "./managed-job-retention-policy.mjs";
import { ACTIVE_JOB_STATES } from "./managed-job-terminal.mjs";
/** @typedef {{job_id?: string, status?: string, finished_at?: string | null, created_at?: string | null, [key: string]: unknown}} RecoveryJob @typedef {{job: RecoveryJob, retentionClass: string, recoveryPending?: boolean}} RecoveryJobRecord */

/** @param {RecoveryJob} job @param {string} retentionClass @returns {number} */
export function managedJobRecoveryPriority(job, retentionClass) {
  if (job?.status === "unreadable") return 0;
  if (ACTIVE_JOB_STATES.has(String(job?.status || ""))) return 1;
  if (job?.status === "staged") return 2;
  return retentionClass === "transient_process" ? 4 : 3;
}

/** @param {RecoveryJobRecord[]} records @param {RecoveryJob[]} visibleJobs @param {number} [now] */
export function recentProcessRecoveryJobs(records, visibleJobs, now = Date.now()) {
  const visibleJobIds = new Set(visibleJobs.map((job) => job.job_id));
  return records
    .filter((record) => !visibleJobIds.has(record.job.job_id)
      && transientProcessWithinRecoveryGrace({
        retention_class: record.retentionClass,
        finished_at: record.job.finished_at,
      }, Number.NaN, now))
    .sort((left, right) => Number(right.recoveryPending === true) - Number(left.recoveryPending === true)
      || String(right.job?.finished_at || "").localeCompare(String(left.job?.finished_at || ""))
      || String(right.job?.created_at || "").localeCompare(String(left.job?.created_at || ""))
      || String(left.job?.job_id || "").localeCompare(String(right.job?.job_id || "")))
    .slice(0, TRANSIENT_PROCESS_RECOVERY_SLOTS)
    .map((record) => record.job);
}
