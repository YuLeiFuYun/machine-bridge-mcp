import { join } from "node:path";
import { visibleToContext } from "./authority-context.mjs";
import { hostedManagedJobListStatus } from "./managed-job-hosted-status.mjs";
import { publicStatus } from "./managed-job-projection.mjs";
import { readJson, resourceErrorClass, safeReadDir } from "./managed-job-storage.mjs";
import { MANAGED_JOB_ID } from "./managed-job-directory.mjs";
import { managedJobCapacitySnapshot, MAX_JOBS, MAX_LISTED_JOBS } from "./managed-job-capacity.mjs";
import { clampInteger } from "./numbers.mjs";

export function listManagedJobs({ jobRoot, args, context, logger, reconcileStatus, assertKnownStatus, maximumLimit = MAX_LISTED_JOBS }) {
  const limit = clampInteger(args.limit, 20, 1, Math.min(MAX_JOBS, maximumLimit));
  const jobs = [];
  for (const entry of safeReadDir(jobRoot)) {
    if (!MANAGED_JOB_ID.test(entry.name)) continue;
    if (!entry.isDirectory()) {
      logger.warn?.("managed job entry has the wrong type; retaining it for inspection", { error_class: "integrity_error" });
      if (context?.authority?.owner !== false) jobs.push({ job_id: entry.name, name: "unavailable", status: "unreadable", error_class: "integrity_error" });
      continue;
    }
    const dir = join(jobRoot, entry.name);
    try {
      reconcileStatus(dir);
      const status = readJson(join(dir, "status.json"), 256 * 1024, "job status");
      if (!status || !visibleToContext(status, context)) continue;
      assertKnownStatus(dir, status);
      jobs.push(publicStatus(status));
    } catch (error) {
      const errorClass = resourceErrorClass(error);
      logger.warn?.("managed job status is unreadable; retaining it for inspection", { error_class: errorClass });
      if (context?.authority?.owner !== false) jobs.push({ job_id: entry.name, name: "unavailable", status: "unreadable", error_class: errorClass });
    }
  }
  jobs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const visibleJobs = jobs.slice(0, limit);
  return {
    jobs: visibleJobs,
    retained: jobs.length,
    maximum: MAX_JOBS,
    ...hostedManagedJobListStatus(visibleJobs, context),
    ...(context?.authority?.owner !== false ? { capacity: managedJobCapacitySnapshot(jobRoot) } : {}),
  };
}
