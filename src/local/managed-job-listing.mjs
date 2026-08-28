import { join } from "node:path";
import { visibleToContext } from "./authority-context.mjs";
import { hostedManagedJobListStatus } from "./managed-job-hosted-status.mjs";
import { publicStatus } from "./managed-job-projection.mjs";
import { readJson, resourceErrorClass, safeReadDir } from "./managed-job-storage.mjs";
import { MANAGED_JOB_ID } from "./managed-job-directory.mjs";
import { managedJobCapacitySnapshot, MAX_JOBS, MAX_LISTED_JOBS } from "./managed-job-capacity.mjs";
import { managedJobRecentActivity } from "./managed-job-activity.mjs";
import { managedJobRecoveryPriority, recentProcessRecoveryJobs } from "./managed-job-recovery-listing.mjs";
import { isTerminalManagedJobStatus } from "./managed-job-terminal.mjs";
import { clampInteger } from "./numbers.mjs";
export function listManagedJobs({ jobRoot, args, context, logger, reconcileStatus, assertKnownStatus, maximumLimit = MAX_LISTED_JOBS }) {
  const limit = clampInteger(args.limit, 20, 1, Math.min(MAX_JOBS, maximumLimit));
  const records = [];
  for (const entry of safeReadDir(jobRoot)) {
    if (!MANAGED_JOB_ID.test(entry.name)) continue;
    if (!entry.isDirectory()) {
      logger.warn?.("managed job entry has the wrong type; retaining it for inspection", { error_class: "integrity_error" });
      if (context?.authority?.owner !== false) records.push({ job: { job_id: entry.name, name: "unavailable", status: "unreadable", error_class: "integrity_error" }, retentionClass: "", recoveryPending: false });
      continue;
    }
    const dir = join(jobRoot, entry.name);
    try {
      reconcileStatus(dir);
      const status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
      if (!status || !visibleToContext(status, context)) continue;
      assertKnownStatus(dir, status);
      records.push({
        job: publicStatus(status),
        retentionClass: String(status.retention_class || ""),
        recoveryPending: status.transient_recovery_pending === true,
      });
    } catch (error) {
      const errorClass = resourceErrorClass(error);
      logger.warn?.("managed job status is unreadable; retaining it for inspection", { error_class: errorClass });
      if (context?.authority?.owner !== false) records.push({ job: { job_id: entry.name, name: "unavailable", status: "unreadable", error_class: errorClass }, retentionClass: "", recoveryPending: false });
    }
  }
  records.sort((left, right) => managedJobRecoveryPriority(left.job, left.retentionClass) - managedJobRecoveryPriority(right.job, right.retentionClass)
    || String(right.job?.created_at || "").localeCompare(String(left.job?.created_at || ""))
    || String(left.job?.job_id || "").localeCompare(String(right.job?.job_id || "")));
  const visibleJobs = records.slice(0, limit).map((record) => record.job);
  const recentProcessRecovery = recentProcessRecoveryJobs(records, visibleJobs);
  const capacity = managedJobCapacitySnapshot(jobRoot);
  const durableTerminal = records.filter((record) => record.retentionClass !== "transient_process" && isTerminalManagedJobStatus(String(record.job?.status || ""))).length;
  const transientTerminal = records.filter((record) => record.retentionClass === "transient_process" && isTerminalManagedJobStatus(String(record.job?.status || ""))).length;
  return {
    jobs: visibleJobs,
    recent_process_recovery: recentProcessRecovery,
    retained: records.length,
    maximum: MAX_JOBS,
    ...hostedManagedJobListStatus(visibleJobs, context),
    ...(context?.authority?.owner !== false ? {
      capacity: { ...capacity, durable_terminal: durableTerminal, transient_terminal: transientTerminal }, recent_activity: managedJobRecentActivity(records),
    } : {}),
  };
}
