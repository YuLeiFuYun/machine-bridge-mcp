import { join } from "node:path";
import { MANAGED_JOB_ID } from "./managed-job-directory.mjs";
import { assertManagedJobPlanIntegrity } from "./managed-job-plan-integrity.mjs";
import { readRequiredJson, resourceErrorClass } from "./managed-job-storage.mjs";
import { ACTIVE_JOB_STATES } from "./managed-job-terminal.mjs";

export function managedJobDependencyProtection(entries, logger, extraProtectedIds) {
  const ids = new Set(extraProtectedIds || []);
  let complete = true;
  for (const item of entries) {
    if (!item.status || (item.status.status !== "staged" && !ACTIVE_JOB_STATES.has(item.status.status))) continue;
    try {
      const plan = readRequiredJson(join(item.dir, "plan.json"), 1024 * 1024, "managed job plan");
      assertManagedJobPlanIntegrity(plan, item.status);
      if (plan.depends_on === undefined) continue;
      if (!Array.isArray(plan.depends_on)) throw new Error("managed job dependency plan is invalid");
      for (const jobId of plan.depends_on) {
        if (typeof jobId !== "string" || !MANAGED_JOB_ID.test(jobId)) {
          throw new Error("managed job dependency plan is invalid");
        }
        ids.add(jobId);
      }
    } catch (error) {
      complete = false;
      logger.warn?.("managed job pruning could not determine active dependency protection; retaining terminal state", {
        error_class: resourceErrorClass(error),
      });
    }
  }
  return { ids, complete };
}
