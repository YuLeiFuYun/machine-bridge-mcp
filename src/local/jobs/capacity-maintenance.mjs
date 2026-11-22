// @ts-check
import { managedJobCapacitySnapshot, MAX_JOBS } from "./capacity.mjs";
import { pruneManagedJobs } from "./retention.mjs";
import { basename, join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { runnerProcessIsCurrentAsync } from "./runner-lifecycle.mjs";
import { readJson } from "./directory.mjs";
import { ACTIVE_JOB_STATES } from "./terminal-base.mjs";

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
/** @param {any} manager @param {string} dir @returns {Promise<void>} */
export async function reconcileManagedJobStatusHosted(manager, dir) {
  manager.assertMaintenanceAvailable();
  const initial = readJson(join(dir, "status.json"), 256 * 1024);
  if (!initial) return;
  if (initial.job_id !== basename(dir)) {
    throw new BridgeError("integrity_error", "managed job state does not match its directory");
  }
  if (ACTIVE_JOB_STATES.has(initial.status) && await runnerProcessIsCurrentAsync(initial, dir)) return;
  manager.reconcileStatus(dir);
}
