import { hostedManagedJobListStatus } from "./managed-job-hosted-status.mjs";
import { managedJobCapacitySnapshot, MAX_JOBS, MAX_LISTED_JOBS } from "./managed-job-capacity.mjs";
import { managedJobRecentActivity } from "./managed-job-activity.mjs";
import { managedJobRecoveryPriority, recentProcessRecoveryJobs } from "./managed-job-recovery-listing.mjs";
import { readManagedJobListingRecords } from "./managed-job-listing-records.mjs";
import { isTerminalManagedJobStatus } from "./managed-job-terminal.mjs";
import { clampInteger } from "./numbers.mjs";
export function listManagedJobs({ jobRoot, args, context, logger, reconcileStatus, assertKnownStatus, maximumLimit = MAX_LISTED_JOBS }) {
  const limit = clampInteger(args.limit, 20, 1, Math.min(MAX_JOBS, maximumLimit));
  const { records, maintenanceRequired } = readManagedJobListingRecords({ jobRoot, context, logger, reconcileStatus, assertKnownStatus });
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
