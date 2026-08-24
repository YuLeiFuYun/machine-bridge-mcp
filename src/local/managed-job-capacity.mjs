import { MANAGED_JOB_ID } from "./managed-job-directory.mjs";
import { retiredManagedJobDirectories } from "./managed-job-directory-generation.mjs";
import { safeReadDir } from "./managed-job-storage.mjs";

export const MAX_JOBS = 512;
export const MAX_LISTED_JOBS = 50;

export function managedJobCapacitySnapshot(jobRoot) {
  const retired = retiredManagedJobDirectories(jobRoot);
  const reservedJobs = safeReadDir(jobRoot).filter((entry) => MANAGED_JOB_ID.test(entry.name));
  return {
    retained_state: reservedJobs.length + retired.length,
    job_state_unreadable: reservedJobs.filter((entry) => !entry.isDirectory()).length,
    retired_state: retired.length,
    retired_unreadable: retired.filter((entry) => !entry.reclaimable).length,
  };
}
