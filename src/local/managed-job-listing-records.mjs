import { join } from "node:path";
import { visibleToContext } from "./authority-context.mjs";
import { publicStatus } from "./managed-job-projection.mjs";
import { readJson, resourceErrorClass, safeReadDir } from "./managed-job-storage.mjs";
import { MANAGED_JOB_ID } from "./managed-job-directory.mjs";
import { stagedPlanExpired } from "./managed-job-retention-policy.mjs";
import { ACTIVE_JOB_STATES } from "./managed-job-terminal.mjs";

export function readManagedJobListingRecords({ jobRoot, context, logger, reconcileStatus, assertKnownStatus }) {
  const records = [];
  let maintenanceRequired = false;
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
      if (!status) {
        maintenanceRequired = true;
        continue;
      }
      if ((status.status === "staged" || ACTIVE_JOB_STATES.has(status.status))
          && Number.isSafeInteger(status.dependency_total) && status.dependency_total > 0) maintenanceRequired = true;
      if (status.status === "staged" && stagedPlanExpired(status, 0)) maintenanceRequired = true;
      if (!visibleToContext(status, context)) continue;
      assertKnownStatus(dir, status);
      records.push({
        job: publicStatus(status),
        retentionClass: String(status.retention_class || ""),
        recoveryPending: status.transient_recovery_pending === true,
      });
    } catch (error) {
      maintenanceRequired = true;
      const errorClass = resourceErrorClass(error);
      logger.warn?.("managed job status is unreadable; retaining it for inspection", { error_class: errorClass });
      if (context?.authority?.owner !== false) records.push({ job: { job_id: entry.name, name: "unavailable", status: "unreadable", error_class: errorClass }, retentionClass: "", recoveryPending: false });
    }
  }
  return { records, maintenanceRequired };
}
