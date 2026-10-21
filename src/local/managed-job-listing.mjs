// @ts-check
import { TRANSIENT_PROCESS_RECOVERY_SLOTS, transientProcessWithinRecoveryGrace } from "./managed-job-retention-policy.mjs";
import { hostedManagedJobListStatus } from "./managed-job-hosted-status.mjs";
import { managedJobCapacitySnapshot, MAX_JOBS, MAX_LISTED_JOBS } from "./managed-job-capacity.mjs";
import { readManagedJobListingRecords } from "./managed-job-listing-records.mjs";
import { ACTIVE_JOB_STATES, isTerminalManagedJobStatus } from "./managed-job-terminal.mjs";
import { clampInteger } from "../shared/numbers.mjs";
/** @param {{jobRoot: string, args: {limit?: number}, context: {authority?: {owner?: boolean, origin?: unknown}}, logger: {warn?: (message: string, details?: Record<string, unknown>) => void}, reconcileStatus: (directory: string) => unknown, assertKnownStatus: (directory: string, status: Record<string, unknown>) => unknown, maximumLimit?: number}} options */
export function listManagedJobs({ jobRoot, args, context, logger, reconcileStatus, assertKnownStatus, maximumLimit = MAX_LISTED_JOBS }) {
  const limit = clampInteger(args.limit, 20, 1, Math.min(MAX_JOBS, maximumLimit));
  const { records: listingRecords, maintenanceRequired } = readManagedJobListingRecords({ jobRoot, context, logger, reconcileStatus, assertKnownStatus });
  const records = /** @type {RecoveryJobRecord[]} */ (listingRecords);
  records.sort((left, right) => managedJobRecoveryPriority(left.job, left.retentionClass) - managedJobRecoveryPriority(right.job, right.retentionClass)
    || String(right.job?.created_at || "").localeCompare(String(left.job?.created_at || ""))
    || String(left.job?.job_id || "").localeCompare(String(right.job?.job_id || "")));
  const visibleJobs = records.slice(0, limit).map((record) => record.job);
  const recentProcessRecovery = recentProcessRecoveryJobs(records, visibleJobs);
  const capacity = managedJobCapacitySnapshot(jobRoot);
  const durableTerminal = records.filter((record) => record.retentionClass !== "transient_process" && isTerminalManagedJobStatus(record.job?.status)).length;
  const transientTerminal = records.filter((record) => record.retentionClass === "transient_process" && isTerminalManagedJobStatus(record.job?.status)).length;
  return {
    jobs: visibleJobs,
    maintenanceRequired,
    recent_process_recovery: recentProcessRecovery,
    retained: records.length,
    maximum: MAX_JOBS,
    ...hostedManagedJobListStatus(visibleJobs, context),
    ...(context?.authority?.owner !== false ? {
      capacity: { ...capacity, durable_terminal: durableTerminal, transient_terminal: transientTerminal }, recent_activity: managedJobRecentActivity(records),
    } : {}),
  };
}


const WINDOWS_MS = Object.freeze({ one: 60_000, five: 5 * 60_000, fifteen: 15 * 60_000, sixty: 60 * 60_000 });

/** @param {RecoveryJobRecord[]} [records] @param {number} [nowMs] */
export function managedJobRecentActivity(records = [], nowMs = Date.now()) {
  const created = records.filter((record) => Number.isFinite(createdAtMs(record)));
  /** @param {number} windowMs */
  const recent = (windowMs) => created.filter((record) => Math.max(0, nowMs - createdAtMs(record)) <= windowMs);
  const last15 = recent(WINDOWS_MS.fifteen);
  const minuteCounts = new Map();
  for (const record of last15) {
    const bucket = Math.floor(Math.max(0, nowMs - createdAtMs(record)) / 60_000);
    minuteCounts.set(bucket, (minuteCounts.get(bucket) || 0) + 1);
  }
  return {
    created_last_1m: recent(WINDOWS_MS.one).length,
    created_last_5m: recent(WINDOWS_MS.five).length,
    created_last_15m: last15.length,
    created_last_60m: recent(WINDOWS_MS.sixty).length,
    transient_process_last_15m: last15.filter((record) => record.retentionClass === "transient_process").length,
    terminal_last_15m: last15.filter((record) => isTerminalManagedJobStatus(record.job?.status)).length,
    failed_last_15m: last15.filter((record) => failedLike(record.job?.status)).length,
    peak_created_per_minute_last_15m: Math.max(0, ...minuteCounts.values()),
  };
}

/** @param {RecoveryJobRecord} record */
function createdAtMs(record) { return Date.parse(String(record?.job?.created_at || "")); }
/** @param {unknown} status */
function failedLike(status) { return /failed|error|exhausted/.test(String(status || "")); }

/** @typedef {{job_id?: unknown, status?: unknown, finished_at?: unknown, created_at?: unknown, [key: string]: unknown}} RecoveryJob @typedef {{job: RecoveryJob, retentionClass: string, recoveryPending?: boolean}} RecoveryJobRecord */

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
