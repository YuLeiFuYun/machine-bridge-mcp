// @ts-check

import { managedJobCapacitySnapshot, MAX_JOBS } from "./managed-job-capacity.mjs";
import { pruneManagedJobs } from "./managed-job-retention.mjs";

/**
 * @param {string} jobRoot
 * @param {Console} logger
 * @param {{alreadyExists: boolean, recoveryAccountCapacity: {applies: boolean}, plan: {depends_on?: string[]}, retentionClass: string}} options
 */
export function pruneManagedJobsAtCapacity(jobRoot, logger, { alreadyExists, recoveryAccountCapacity, plan, retentionClass }) {
  const snapshot = managedJobCapacitySnapshot(jobRoot);
  if ((recoveryAccountCapacity.applies && alreadyExists) || snapshot.retained_state < MAX_JOBS) {
    return { snapshot, pruned: false };
  }
  pruneManagedJobs({
    jobRoot,
    logger,
    reserveSlots: alreadyExists ? 0 : 1,
    protectedJobIds: new Set(plan.depends_on || []),
    incomingRetentionClass: retentionClass,
  });
  return { snapshot: managedJobCapacitySnapshot(jobRoot), pruned: true };
}
